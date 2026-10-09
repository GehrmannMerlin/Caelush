import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@caelush/protocol";
import { createWorkspaceRef, startDaemon } from "../src/index.js";
import {
  createAIError,
  type AIAdapterEvent,
  type ApiAdapter,
  type ApiAdapterStreamInput,
} from "@caelush/ai";
import { openCaelushStorage } from "@caelush/storage";
import { CaelushClient } from "@caelush/client";
import { afterEach, describe, expect, it } from "vitest";
import { WebSessionManager } from "../../web/src/application/session-manager.js";
import {
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  fixtureBinding,
  fixtureModelSource,
} from "./support/ai-fixture.js";
import { restrictedProvider } from "./support/permission-flow-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

/** Keep this lifecycle test on the compatibility model selection path. */
function withoutAIControlPlane(client: CaelushClient): CaelushClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (
        property === "listAIProviders" ||
        property === "getAIModelDirectory" ||
        property === "getDefaultAISelection"
      ) {
        return undefined;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

class DirectFinalProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    const isReview = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    return this.text(
      isReview
        ? JSON.stringify({ verdict: "PASS", summary: "The candidate is acceptable." })
        : "Verified web result.",
    );
  }

  private async *text(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

class StopResumeProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly blockedTurnEntered = deferred<void>();
  readonly blockedTurnAborted = deferred<void>();
  readonly modelRequests: ApiAdapterStreamInput[] = [];
  continuationObservedPatchedFile = false;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if (
      input.request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.text(
        JSON.stringify({ verdict: "PASS", summary: "The resumed task is complete." }),
      );
    }

    const requestIndex = this.modelRequests.push(input) - 1;
    switch (requestIndex) {
      case 0:
        return this.patchNote();
      case 1:
        return this.blockUntilCancelled(input);
      case 2:
        return this.readNote();
      default:
        this.continuationObservedPatchedFile = input.request.messages.some(
          (message) => message.role === "tool" && message.content.includes("version=after"),
        );
        return this.text("The continued scan found version=after.");
    }
  }

  private async *patchNote(): AsyncGenerator<AIAdapterEvent> {
    yield {
      type: "tool_call.start",
      payload: { toolCallId: "call_ic_c_patch", toolName: "apply_patch" },
    };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "call_ic_c_patch",
        name: "apply_patch",
        input: {
          patch:
            "*** Begin Patch\n*** Update File: src/note.txt\n@@\n-version=before\n+version=after\n*** End Patch",
        },
      },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *blockUntilCancelled(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.blockedTurnEntered.resolve();
    await new Promise<void>((resolve) => {
      if (input.signal.aborted) {
        resolve();
        return;
      }
      input.signal.addEventListener(
        "abort",
        () => {
          this.blockedTurnAborted.resolve();
          resolve();
        },
        { once: true },
      );
    });
    if (input.signal.aborted) throw createAIError("AI_ABORTED");
    yield* [] as readonly AIAdapterEvent[];
  }

  private async *readNote(): AsyncGenerator<AIAdapterEvent> {
    yield {
      type: "tool_call.start",
      payload: { toolCallId: "call_ic_c_read", toolName: "read_file" },
    };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "call_ic_c_read",
        name: "read_file",
        input: { path: "src/note.txt" },
      },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *text(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("Web Session model production lifecycle", () => {
  it("drives a real daemon Run to Natural Completion", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-web-session-"));
    const workspace = createWorkspaceRef(directory);
    const provider = new DirectFinalProvider();
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
      processSandboxProviders: [restrictedProvider],
      web: { buildRoot: webBuildRoot(), workspace },
    });
    const client = withoutAIControlPlane(new CaelushClient({ baseUrl: daemon.url }));
    const indexResponse = await fetch(`${daemon.url}/`);
    expect(indexResponse.status).toBe(200);
    expect(await indexResponse.text()).toContain('id="caelush-bootstrap"');
    const apiResponse = await fetch(`${daemon.url}/api/v1/health`);
    expect(apiResponse.status).toBe(200);
    const info = await client.getInfo();
    const manager = new WebSessionManager({ client, workspace, info });

    await manager.loadSessions();
    manager.beginDraft();
    const submitted = await manager.submitPrompt("complete the web lifecycle");
    expect(
      submitted,
      JSON.stringify({
        error: manager.getSnapshot().error,
        selectedPreset: manager.getSnapshot().selectedPreset,
        availablePresets: manager.getSnapshot().availablePresets,
        submission: manager.getSnapshot().submission,
        selectedSession: manager.getSnapshot().selectedSession?.id,
      }),
    ).toBe(true);
    await waitFor(() => manager.getSnapshot().submission === "IDLE");

    const snapshot = manager.getSnapshot();
    expect(snapshot.selectedSessionId).toBeDefined();
    expect(snapshot.activeRuns).toHaveLength(0);
    expect(snapshot.composerEnabled).toBe(true);
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "USER", text: "complete the web lifecycle" }),
        expect.objectContaining({ kind: "ASSISTANT", text: "Verified web result." }),
      ]),
    );
    expect(snapshot.history.some((entry) => entry.text.includes("raw"))).toBe(false);
    expect(provider.calls).toBe(1);
    await expect(client.getRun(snapshot.runs[0]!.id)).resolves.toMatchObject({
      status: "COMPLETED",
      completionContract: "NATURAL_V1",
      finalResult: { type: "NORMAL_COMPLETION", text: "Verified web result." },
    });

    manager.dispose();
  }, 20_000);

  it("stops a production Run in WebSessionManager and continues the same Session without repeating its file write", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-web-stop-resume-"));
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "note.txt"), "version=before\n", "utf8");
    const workspace = createWorkspaceRef(directory);
    const provider = new StopResumeProvider();
    const databasePath = join(directory, "caelush.db");
    daemon = await startDaemon({
      databasePath,
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
      processSandboxProviders: [restrictedProvider],
      web: { buildRoot: webBuildRoot(), workspace },
    });
    let client = withoutAIControlPlane(new CaelushClient({ baseUrl: daemon.url }));
    let manager = new WebSessionManager({ client, workspace, info: await client.getInfo() });

    await manager.loadSessions();
    manager.beginDraft();
    expect(await manager.submitPrompt("Inspect and update src/note.txt, then summarize it.")).toBe(
      true,
    );
    await provider.blockedTurnEntered.promise;
    await waitFor(
      async () =>
        (await readFile(join(directory!, "src", "note.txt"), "utf8")) === "version=after\n",
    );

    const runAId = manager.getSnapshot().activeRun?.id;
    const sessionId = manager.getSnapshot().selectedSessionId;
    expect(runAId).toBeDefined();
    expect(sessionId).toBeDefined();
    expect(await manager.cancelRun()).toBe(true);
    await provider.blockedTurnAborted.promise;
    await waitFor(() => {
      const snapshot = manager.getSnapshot();
      return (
        snapshot.activeRuns.length === 0 &&
        snapshot.composerEnabled &&
        snapshot.submission === "IDLE" &&
        snapshot.runs.some((run) => run.id === runAId && run.status === "CANCELLED")
      );
    });

    const runAEvents = await collectUntil(client, runAId!, "run.cancelled");
    expect(runAEvents.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
    expect(runAEvents.some((event) => event.type === "run.completed")).toBe(false);
    expect(await readFile(join(directory, "src", "note.txt"), "utf8")).toBe("version=after\n");

    manager.dispose();
    await daemon.close();
    daemon = await startDaemon({
      databasePath,
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
      processSandboxProviders: [restrictedProvider],
      web: { buildRoot: webBuildRoot(), workspace },
    });
    client = withoutAIControlPlane(new CaelushClient({ baseUrl: daemon.url }));
    manager = new WebSessionManager({ client, workspace, info: await client.getInfo() });
    await manager.loadSessions();
    expect(await manager.selectSession(sessionId!)).toBe(true);
    expect(manager.getSnapshot().runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: runAId, status: "CANCELLED" })]),
    );

    expect(
      await manager.submitPrompt("Continue the previous scan and summarize the current file."),
    ).toBe(true);
    const runBId = manager.getSnapshot().activeRun?.id;
    expect(runBId).toBeDefined();
    await waitFor(() => {
      const snapshot = manager.getSnapshot();
      return (
        snapshot.activeRuns.length === 0 &&
        snapshot.composerEnabled &&
        snapshot.submission === "IDLE" &&
        snapshot.runs.some((run) => run.id === runBId && run.status === "COMPLETED")
      );
    });

    const runA = await client.getRun(runAId!);
    const runB = await client.getRun(runBId!);
    expect(runA).toMatchObject({ status: "CANCELLED", sessionId, workspace });
    expect(runB).toMatchObject({
      status: "COMPLETED",
      sessionId,
      workspace,
      completionContract: "NATURAL_V1",
      finalResult: { type: "NORMAL_COMPLETION", text: "The continued scan found version=after." },
    });
    expect(manager.getSnapshot().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "USER",
          text: "Inspect and update src/note.txt, then summarize it.",
        }),
        expect.objectContaining({
          kind: "USER",
          text: "Continue the previous scan and summarize the current file.",
        }),
        expect.objectContaining({
          kind: "ASSISTANT",
          text: "The continued scan found version=after.",
        }),
      ]),
    );

    const requestA = provider.modelRequests[0];
    const requestB = provider.modelRequests[2];
    expect(requestA).toBeDefined();
    expect(requestB).toBeDefined();
    const securityBlock = (request: ApiAdapterStreamInput | undefined): string | undefined => {
      const system = request?.request.messages.find(
        (message) => message.role === "system" && message.content.includes("<run_security_policy>"),
      );
      return system?.role === "system"
        ? system.content.match(/<run_security_policy>[\s\S]*?<\/run_security_policy>/)?.[0]
        : undefined;
    };
    expect(securityBlock(requestA)).toBeDefined();
    expect(securityBlock(requestB)).toBeDefined();
    expect(securityBlock(requestB)).toBe(securityBlock(requestA));
    expect(requestB?.request.model).toEqual(requestA?.request.model);
    expect(requestB?.request.settings).toEqual(requestA?.request.settings);
    expect(requestA?.request.tools?.length).toBeGreaterThan(0);
    expect(requestB?.request.tools).toEqual(requestA?.request.tools);
    expect(requestB?.request.tools?.map((tool) => tool.name)).toEqual(
      requestA?.request.tools?.map((tool) => tool.name),
    );

    const resumedMessages = requestB?.request.messages ?? [];
    const resumedToolResultIndex = resumedMessages.findIndex(
      (message) => message.role === "tool" && message.toolCallId === "call_ic_c_patch",
    );
    const resumedUserIndex = resumedMessages.findIndex(
      (message) =>
        message.role === "user" &&
        message.content === "Continue the previous scan and summarize the current file.",
    );
    expect(resumedToolResultIndex).toBeGreaterThan(-1);
    expect(resumedUserIndex).toBeGreaterThan(resumedToolResultIndex);
    expect(JSON.stringify(resumedMessages)).toContain("call_ic_c_patch");
    expect(provider.continuationObservedPatchedFile).toBe(true);
    expect(provider.modelRequests).toHaveLength(4);

    const runBEvents = await collectUntil(client, runB.id, "run.completed");
    expect(runBEvents.filter((event) => event.type === "run.completed")).toHaveLength(1);
    const durableSequences = runBEvents.flatMap((event) =>
      event.durability.kind === "DURABLE" ? [event.durability.sequence] : [],
    );
    expect(durableSequences).toEqual([...durableSequences].sort((left, right) => left - right));

    const storage = await openCaelushStorage({ path: databasePath });
    try {
      const runAToolResults = (await storage.messageRecords.listByRun(runA.id)).filter(
        (message) => message.messageType === "TOOL_RESULT",
      );
      expect(runAToolResults).toHaveLength(1);
      expect(await storage.toolInvocations.listByRun(runA.id)).toHaveLength(1);
      const runBInvocations = await storage.toolInvocations.listByRun(runB.id);
      expect(
        runBInvocations.filter((invocation) => invocation.toolName === "read_file"),
      ).toHaveLength(1);
      expect(
        runBInvocations.filter((invocation) => invocation.toolName === "apply_patch"),
      ).toHaveLength(0);
      expect((await storage.runs.get(runA.id))?.status).toBe("CANCELLED");
      expect((await storage.runs.get(runB.id))?.status).toBe("COMPLETED");
    } finally {
      await storage.close();
    }

    manager.dispose();
  }, 30_000);
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await predicate()).toBe(true);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function webBuildRoot(): string {
  return fileURLToPath(new URL("../../web/dist", import.meta.url));
}

async function collectUntil(
  client: CaelushClient,
  runId: Parameters<CaelushClient["getRun"]>[0],
  target: AgentEvent["type"],
) {
  const events: AgentEvent[] = [];
  for await (const event of client.watchRunEvents(runId, { afterSequence: 0 })) {
    events.push(event);
    if (event.type === target) break;
  }
  return events;
}
