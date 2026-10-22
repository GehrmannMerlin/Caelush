import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createAgentMessageCodecRegistry,
  createContextMessageRange,
  createDeterministicCheckpointBuilder,
  createDeterministicCompactionFacts,
  createHistorySourceRef,
  STANDARD_AGENT_MESSAGE_CODECS,
} from "@caelush/agent";
import { CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1 } from "@caelush/coding-agent";
import { createRunId, createSessionId } from "@caelush/protocol";

import { createReliabilityFixture } from "./support/reliability-fixture.js";
import { createHistoryLookupAdapter } from "../src/context/history-lookup-adapter.js";

/**
 * M3 / B17–B18: a checkpoint reference must actually be readable.
 *
 * ```text
 * the model calls read_history through the real Dispatcher   not a direct repository read
 * the reference addresses immutable durable records          and paginates by bytes
 * another Session's reference is refused                     scope is host-bound
 * unknown and malformed references are safe refusals          never a stack trace
 * ```
 *
 * The reference is built by the *host* in the transport handler, from the Run's own assigned
 * sequence range, exactly as a checkpoint emitter would build it. Nothing in this file lets a model
 * choose a Session.
 */

const API = "openai-compatible-chat";

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chunk",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function sseToolCall(id: string, name: string, args: Record<string, unknown>): Response {
  const body =
    chunk({
      reasoning_content: "SYNTHETIC_TEST_REASONING",
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    }) +
    chunk({}, "tool_calls") +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseText(text: string): Response {
  return new Response(
    chunk({ reasoning_content: "SYNTHETIC_TEST_REASONING", content: text }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function toolContents(wire: Record<string, unknown> | undefined): readonly string[] {
  const messages = (wire?.["messages"] ?? []) as readonly Record<string, unknown>[];
  return messages
    .filter((message) => message["role"] === "tool")
    .map((message) => String(message["content"] ?? ""));
}

describe("M3 — readable history references", () => {
  it("returns durable visible records to the next model turn, in bounded pages", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "caelush-history-lookup-"));
    const wires: Record<string, unknown>[] = [];
    let sourceRef: string | undefined;
    let nextCursor: string | undefined;

    const fixture = await createReliabilityFixture({
      rootDirectory,
      api: API,
      useBuiltinAdapter: true,
      providerBindingOverrides: {
        defaultApi: API,
        endpoint: "http://127.0.0.1:1/offline",
        transport: {
          fetch: async (_url: unknown, init: { readonly body?: unknown }) => {
            const wire = JSON.parse(String(init.body)) as Record<string, unknown>;
            wires.push(wire);
            const turn = wires.length;
            if (turn === 1) {
              // One Tool call first, so the Run has a Tool result chain in its history.
              return sseToolCall("call-read", "read_file", { path: "probe.txt" });
            }
            if (turn === 2) {
              // The host resolves the Run's own immutable sequence range and emits the reference a
              // checkpoint would emit. The model never sees a Session or a range.
              const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
              try {
                const first = db
                  .prepare(
                    "SELECT sequence, message_id, conversation_turn_id " +
                      "FROM agent_messages WHERE run_id=? ORDER BY sequence ASC LIMIT 1",
                  )
                  .get(fixture.run.id) as {
                  sequence: number;
                  message_id: string;
                  conversation_turn_id: string;
                };
                const last = db
                  .prepare(
                    "SELECT sequence, message_id, conversation_turn_id " +
                      "FROM agent_messages WHERE run_id=? ORDER BY sequence DESC LIMIT 1",
                  )
                  .get(fixture.run.id) as {
                  sequence: number;
                  message_id: string;
                  conversation_turn_id: string;
                };
                const sourceRange = createContextMessageRange({
                  runId: fixture.run.id,
                  conversationTurnId: first.conversation_turn_id as never,
                  firstMessageId: first.message_id as never,
                  lastMessageId: last.message_id as never,
                  firstSequence: first.sequence,
                  lastSequence: last.sequence,
                });
                const checkpoint = createDeterministicCheckpointBuilder().build({
                  goal: "exercise the real daemon reliability path",
                  sourceRange,
                  facts: createDeterministicCompactionFacts({
                    readFiles: [],
                    changedFiles: [],
                    recentErrors: [],
                    verificationState: "NOT_RUN",
                    activeProcesses: [],
                    pendingApprovals: [],
                    resourceGovernance: "BOUNDED",
                  }),
                });
                sourceRef = checkpoint.criticalReferences.find((reference) =>
                  reference.startsWith("history:v1:"),
                );
              } finally {
                db.close();
              }
              return sseToolCall("call-history-1", "read_history", {
                sourceRef,
                maxBytes: 120,
              });
            }
            if (turn === 3) {
              const contents = toolContents(wires[2]);
              const match = /c(\d+)/.exec(contents.join("\n"));
              nextCursor = match?.[0];
              return sseToolCall("call-history-2", "read_history", {
                sourceRef,
                ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
                maxBytes: 4_000,
              });
            }
            return sseText("History restored.");
          },
        },
      },
      modelLimits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
      limits: { maxSteps: 8, maxToolCalls: 16, timeoutMs: 60_000 },
    });

    try {
      const end = await fixture.composition.controller.start(fixture.run.id);
      expect(end.run.status).toBe("COMPLETED");
      expect(sourceRef).toBeDefined();

      // The first page is a real page: bounded, with a continuation.
      const firstPage = toolContents(wires[2]).join("\n");
      expect(firstPage).toContain("USER");
      expect(firstPage).toContain("exercise the real daemon reliability path");
      expect(Buffer.byteLength(firstPage, "utf8")).toBeLessThan(4_000);

      // The second page continues from the cursor the Tool returned and carries the Tool chain.
      const secondPage = toolContents(wires[3]).join("\n");
      expect(secondPage).toContain("read_file");

      // Both pages are visible-text projections: the provider-native reasoning the fixture emits on
      // every turn never appears in what the Tool returns.
      expect(firstPage).not.toContain("SYNTHETIC_TEST_REASONING");
      expect(secondPage).not.toContain("SYNTHETIC_TEST_REASONING");

      // The calls really went through the Dispatcher, so the read is a Tool execution with durable
      // identity rather than a repository read dressed up as one.
      const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        const names = (
          db
            .prepare("SELECT tool_name AS name FROM tool_invocations WHERE run_id=? ORDER BY rowid")
            .all(fixture.run.id) as readonly { name: string }[]
        ).map((row) => row.name);
        expect(names).toContain("read_file");
        expect(names.filter((name) => name === "read_history")).toHaveLength(2);
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  }, 90_000);

  it("refuses another Session's reference, unknown references and forged bounds", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "caelush-history-scope-"));
    const fixture = await createReliabilityFixture({
      rootDirectory,
      api: API,
      useBuiltinAdapter: true,
      providerBindingOverrides: { defaultApi: API, endpoint: "http://127.0.0.1:1/offline" },
      modelLimits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    });
    const codecs = createAgentMessageCodecRegistry({
      codecs: [...STANDARD_AGENT_MESSAGE_CODECS, CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1],
    });
    const adapter = createHistoryLookupAdapter({
      runs: fixture.storage.runs,
      messageRecords: fixture.storage.messageRecords,
      codecs,
    });
    const signal = new AbortController().signal;
    const scope = { sessionId: fixture.sessionId, runId: fixture.run.id };
    const ref = createHistorySourceRef({
      runId: fixture.run.id,
      firstSequence: 1,
      lastSequence: 1,
    });
    try {
      // Same Session, no records yet: a real page, empty.
      const empty = await adapter.read({ sourceRef: ref }, scope, signal);
      expect(empty.kind).toBe("PAGE");

      const otherSession = await adapter.read(
        { sourceRef: ref },
        {
          sessionId: createSessionId(),
          runId: createRunId(),
        },
        signal,
      );
      expect(otherSession).toEqual({ kind: "UNAVAILABLE", reason: "OUT_OF_SCOPE" });

      const unknown = await adapter.read({ sourceRef: "history:v1:nonsense" }, scope, signal);
      expect(unknown).toEqual({ kind: "UNAVAILABLE", reason: "UNKNOWN_SOURCE" });

      const forged = ref.replace(/:1:1#/, ":1:99#");
      const forgedResult = await adapter.read({ sourceRef: forged }, scope, signal);
      expect(forgedResult).toEqual({ kind: "UNAVAILABLE", reason: "INTEGRITY_MISMATCH" });

      const unsupported = await adapter.read(
        { sourceRef: ref.replace("history:v1:", "history:v2:") },
        scope,
        signal,
      );
      expect(unsupported).toEqual({ kind: "UNAVAILABLE", reason: "UNSUPPORTED_VERSION" });

      const badCursor = await adapter.read({ sourceRef: ref, cursor: "nope" }, scope, signal);
      expect(badCursor).toEqual({ kind: "UNAVAILABLE", reason: "CURSOR_INVALID" });
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
