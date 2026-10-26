import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createReliabilityFixture,
  listRunContextCheckpoints,
} from "./support/reliability-fixture.js";

const API = "openai-compatible-chat";
const SOURCE_SENTINEL = "M4_SOURCE_SENTINEL_42A9";
const PADDING_FILES = Array.from({ length: 40 }, (_, index) => `m4-padding-${index + 1}.txt`);

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "m4-chunk",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function sseToolCalls(calls: readonly ToolCall[]): Response {
  const toolCalls = calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }));
  return new Response(
    chunk({ tool_calls: toolCalls }) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function sseText(text: string): Response {
  return new Response(chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function messagesOf(wire: Record<string, unknown>): readonly Record<string, unknown>[] {
  const messages = wire["messages"];
  return Array.isArray(messages)
    ? messages.filter(
        (message): message is Record<string, unknown> =>
          message !== null && typeof message === "object" && !Array.isArray(message),
      )
    : [];
}

describe("M4 — failed semantic summary through the pinned SDK and durable daemon path", () => {
  it("commits a degraded checkpoint and has the next model turn read its original source", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "caelush-degraded-summary-sdk-"));
    const wires: Record<string, unknown>[] = [];
    const summaryWires: Record<string, unknown>[] = [];
    let nextFile = 0;
    let historyLookupCount = 0;
    let recoveredOriginalSource = false;
    const progressStages: Array<{ readonly stage: string; readonly reason: string }> = [];

    const fixture = await createReliabilityFixture({
      rootDirectory,
      api: API,
      useBuiltinAdapter: true,
      contextBudgetPolicy: "DAEMON_DEFAULT",
      contextBudgetPolicyVersion: "TURN_BUDGET_V4",
      modelLimits: { contextWindowTokens: 32_768, maxOutputTokens: 2_048 },
      limits: { maxSteps: 48, maxToolCalls: 64, timeoutMs: 120_000 },
      resourcePolicy: {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 48, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 8,
          identicalCallNudgeThreshold: 3,
          noProgressTurnsBeforeReplan: 4,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      },
      providerBindingOverrides: {
        defaultApi: API,
        endpoint: "http://127.0.0.1:1/offline",
        transport: {
          fetch: async (_url: unknown, init: { readonly body?: unknown }) => {
            const wire = JSON.parse(String(init.body)) as Record<string, unknown>;
            wires.push(wire);
            const messages = messagesOf(wire);
            const serialized = JSON.stringify(messages);

            if (
              serialized.includes(
                "Return exactly one plain JSON object matching SemanticCheckpointDraft only.",
              )
            ) {
              summaryWires.push(wire);
              // A syntactically truncated response exercises the production parser, validator,
              // checkpoint fallback, durable commit and subsequent source lookup.
              return sseText('{"goal":"truncated semantic summary');
            }

            if (
              messages.some(
                (message) =>
                  message["role"] === "tool" &&
                  message["tool_call_id"] === "m4-read-degraded-source" &&
                  String(message["content"] ?? "").includes(SOURCE_SENTINEL),
              )
            ) {
              recoveredOriginalSource = true;
              return sseText("The original source was restored from its verified history range.");
            }

            const sourceRef = serialized.match(/history:v1:[^\s"\\]+/u)?.[0];
            if (sourceRef !== undefined && historyLookupCount === 0) {
              historyLookupCount += 1;
              return sseToolCalls([
                {
                  id: "m4-read-degraded-source",
                  name: "read_history",
                  input: { sourceRef, maxBytes: 32_768 },
                },
              ]);
            }

            const batchSize = 1;
            const batch = PADDING_FILES.slice(nextFile, nextFile + batchSize);
            if (batch.length > 0) {
              const calls = batch.map((path, index) => ({
                id: `m4-read-padding-${String(nextFile + index + 1)}`,
                name: "read_file",
                input: { path, limit: 400 },
              }));
              nextFile += batch.length;
              return sseToolCalls(calls);
            }

            return sseText("No degraded source reference was produced.");
          },
        },
      },
    });
    const eventHub = fixture.composition.eventHub;
    if (eventHub === undefined) throw new Error("expected the production RunEventHub");
    const progressSubscription = eventHub.subscribe(
      { runId: fixture.run.id, includeDurable: false },
      (event) => {
        if (event.type === "context.compaction.progress") {
          progressStages.push({ stage: event.payload.stage, reason: event.payload.reason });
        }
      },
    );

    try {
      for (const [index, name] of PADDING_FILES.entries()) {
        const padding = Array.from(
          { length: 400 },
          (_, line) => `M4 file ${index + 1} durable source line ${String(line).padStart(3, "0")}`,
        ).join("\n");
        await writeFile(
          join(fixture.workspacePath, name),
          index === 0 ? `${SOURCE_SENTINEL}\n${padding}` : padding,
          "utf8",
        );
      }

      const result = await fixture.composition.controller.start(fixture.run.id);
      expect(result.run.status).toBe("COMPLETED");
      expect(
        summaryWires.length,
        JSON.stringify({
          usage: await fixture.composition.contextUsage.getContextUsage(String(fixture.run.id)),
          toolResultBytes: messagesOf(wires.at(-1) ?? {})
            .filter((message) => message["role"] === "tool")
            .map((message) => Buffer.byteLength(String(message["content"] ?? ""), "utf8")),
          requestCount: wires.length,
        }),
      ).toBeGreaterThan(0);
      expect(historyLookupCount).toBe(1);
      expect(recoveredOriginalSource).toBe(true);

      for (const wire of summaryWires) {
        const tools = wire["tools"];
        // A verified native replay keeps its original data-only Tool declarations for cache hits;
        // the explicit none choice still prevents a summary response from requesting execution.
        expect(tools === undefined || Array.isArray(tools)).toBe(true);
        expect(wire["tool_choice"]).toBe("none");
      }

      const checkpoints = await listRunContextCheckpoints(fixture);
      const degraded = checkpoints.find((checkpoint) => checkpoint.degraded);
      expect(degraded).toBeDefined();
      if (degraded === undefined) throw new Error("expected a committed degraded checkpoint");
      await expect(
        fixture.composition.contextUsage.getContextUsage(String(fixture.run.id)),
      ).resolves.toMatchObject({
        lastCompaction: { reason: degraded.reason, quality: "DEGRADED" },
      });
      const sourceRef = degraded?.structuredCheckpoint.criticalReferences.find((reference) =>
        reference.startsWith("history:v1:"),
      );
      expect(sourceRef).toMatch(/^history:v1:/u);
      await waitFor(() => progressStages.some(({ stage }) => stage === "FINISHED"));
      expect(progressStages.map(({ stage }) => stage)).toEqual([
        "PREPARING",
        "SUMMARIZING",
        "REBUILDING",
        "FINISHED",
      ]);
      expect(new Set(progressStages.map(({ reason }) => reason)).size).toBe(1);

      const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
      expect(
        invocations.filter((invocation) => invocation.toolName === "read_history"),
      ).toHaveLength(1);
      const fileReads = invocations.filter((invocation) => invocation.toolName === "read_file");
      expect(fileReads).toHaveLength(nextFile);
      expect(nextFile).toBeLessThan(PADDING_FILES.length);
      expect(wires.length).toBeGreaterThan(summaryWires.length + 1);
    } finally {
      progressSubscription.close();
      await fixture.dispose();
    }
  }, 120_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!predicate()) throw new Error("Timed out waiting for the live compaction progress events.");
}
