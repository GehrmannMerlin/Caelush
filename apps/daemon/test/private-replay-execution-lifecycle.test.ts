import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentMessageIdFactory, createPrivateReplayReference } from "@caelush/agent";
import type { AgentMessageRecordDraft, PrivateReplayIdentity } from "@caelush/agent";
import { createReplayProtection } from "@caelush/security";
import type { ReplayKeyProvider } from "@caelush/security";
import { openCaelushStorage } from "@caelush/storage";
import { makeRun, makeSession } from "../../../packages/storage/test/support/fixtures.js";
import { createWindowsReplayKeyProvider } from "../src/replay/replay-key-provider.js";
import { createDaemonPrivateReplayResolver } from "../src/replay/private-replay-resolver.js";
import { windowsDpapi } from "../src/replay/windows-dpapi.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("daemon private replay execution lifecycle", () => {
  it("reads only Context-selected assistants through SQLite and one disposable key lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-replay-execution-"));
    directories.push(directory);
    const master = Buffer.alloc(32, 0x5a);
    const returnedKeys: Uint8Array[] = [];
    let lookups = 0;
    const keys: ReplayKeyProvider = {
      async current() {
        return { keyId: "temp-session-key", bytes: Buffer.from(master) };
      },
      async get(keyId, options) {
        lookups += 1;
        if (options?.signal?.aborted || keyId !== "temp-session-key") return undefined;
        const bytes = Buffer.from(master);
        returnedKeys.push(bytes);
        return { keyId, bytes };
      },
    };
    const storage = await openCaelushStorage({
      path: join(directory, "replay.sqlite"),
      replayProtection: createReplayProtection(keys),
    });
    try {
      const session = makeSession();
      const run = makeRun(session.id);
      await storage.sessions.insert(session);
      await storage.runs.insert(run);
      const ids = createAgentMessageIdFactory();
      const entries = await Promise.all(
        ["selected-one", "selected-two", "not-selected"].map(async (label, index) => {
          const identity: PrivateReplayIdentity = {
            sessionId: session.id,
            runId: run.id,
            messageId: ids.create(),
            callId: "call-" + (index + 1),
            providerId: "deepseek",
            model: "deepseek-reasoner",
            api: "openai-compatible-chat",
            replayVersion: 1,
          };
          const content = Buffer.from("temporary replay " + label);
          const draft: AgentMessageRecordDraft = {
            messageId: identity.messageId,
            sessionId: session.id,
            conversationTurnId: ("turn:" +
              run.id +
              ":" +
              (index + 1)) as AgentMessageRecordDraft["conversationTurnId"],
            messageType: "ASSISTANT",
            schemaVersion: 2,
            modelProjectionVersion: 1,
            createdAt: session.createdAt,
            source: { kind: "MODEL", callId: identity.callId },
            audience: { model: true, transcript: true },
            data: {
              content: [{ type: "TEXT", text: label }],
              phase: "TOOL_CALLS",
              model: {
                kind: "MODEL_TURN",
                callId: identity.callId,
                model: { provider: identity.providerId, model: identity.model },
                finishReason: "STOP",
              },
              providerState: createPrivateReplayReference(identity),
            },
          };
          const write = await storage.privateReplay.prepare(identity, content);
          content.fill(0);
          return { identity, draft, write };
        }),
      );
      await storage.execution.commit({
        run,
        expectedStateRevision: null,
        expectedContinuationRevision: null,
        stepWrites: [],
        messagesToAppend: entries.map(({ draft }) => ({ draft })),
        events: [],
        privateReplayWrites: entries.map(({ write }) => write),
      });
      lookups = 0;
      returnedKeys.length = 0;

      const selected = entries.slice(0, 2);
      const execution = await createDaemonPrivateReplayResolver(storage.privateReplay, {
        sessionId: session.id,
        executionRunId: run.id,
        providerId: "deepseek",
        model: "deepseek-reasoner",
        api: "openai-compatible-chat",
        selectedMessageIds: selected.map(({ identity }) => identity.messageId),
        selectedAssistantMessageIds: selected.map(({ identity }) => identity.messageId),
      });
      const opened: Uint8Array[] = [];
      try {
        for (const entry of selected) {
          opened.push(
            await execution.resolver.resolve({
              providerState: createPrivateReplayReference(entry.identity),
              providerId: "deepseek" as never,
              model: { provider: "deepseek", model: "deepseek-reasoner" },
              api: "openai-compatible-chat" as never,
            }),
          );
        }
        expect(opened.map((bytes) => Buffer.from(bytes).toString("utf8"))).toEqual([
          "temporary replay selected-one",
          "temporary replay selected-two",
        ]);
        expect(lookups).toBe(1);
        expect(returnedKeys).toHaveLength(1);
        expect(returnedKeys[0]?.every((byte) => byte === 0)).toBe(true);
        await expect(
          execution.resolver.resolve({
            providerState: createPrivateReplayReference(entries[2]!.identity),
            providerId: "deepseek" as never,
            model: { provider: "deepseek", model: "deepseek-reasoner" },
            api: "openai-compatible-chat" as never,
          }),
        ).rejects.toThrow("Private replay unavailable.");
        expect(lookups).toBe(1);
      } finally {
        for (const bytes of opened) bytes.fill(0);
        await execution.dispose();
      }
      await expect(
        execution.resolver.resolve({
          providerState: createPrivateReplayReference(selected[0]!.identity),
          providerId: "deepseek" as never,
          model: { provider: "deepseek", model: "deepseek-reasoner" },
          api: "openai-compatible-chat" as never,
        }),
      ).rejects.toThrow("Private replay unavailable.");
      master.fill(0);
    } finally {
      await storage.close();
    }
  });

  it("stops an aborted Windows DPAPI helper and uses only a temporary key profile", async () => {
    if (process.platform !== "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "caelush-replay-dpapi-"));
    directories.push(directory);
    const provider = createWindowsReplayKeyProvider(join(directory, "keys", "master.v1.json"));
    const current = await provider.current();
    const recovered = await provider.get(current.keyId);
    expect(recovered?.bytes).toEqual(current.bytes);
    current.bytes.fill(0);
    recovered?.bytes.fill(0);

    const key = Buffer.alloc(32, 4);
    const protectedBytes = await windowsDpapi("protect", "abort-fixture-key", key);
    key.fill(0);
    const controller = new AbortController();
    const pending = windowsDpapi(
      "unprotect",
      "abort-fixture-key",
      protectedBytes,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("Private replay unavailable.");
    protectedBytes.fill(0);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      windowsDpapi("unprotect", current.keyId, Buffer.from("temporary"), alreadyAborted.signal),
    ).rejects.toThrow("Private replay unavailable.");
  }, 20_000);
});
