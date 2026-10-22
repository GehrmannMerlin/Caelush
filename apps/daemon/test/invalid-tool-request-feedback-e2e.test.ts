import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleApiAdapter } from "@caelush/ai/adapters/openai-compatible";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

/**
 * T2: a model Tool request with unexecutable arguments must not end the Run.
 *
 * The whole point of this file is the *composition*: the pinned SDK parses a real SSE body, the
 * production gateway assembles the turn, the real daemon commits it through SQLite, the Tool batch
 * answers every request, and the next provider request is built from the durable history. A scripted
 * `AIAdapterEvent` fixture cannot show any of that, so nothing here emits adapter events directly.
 */

interface WireRequest {
  readonly messages: readonly Record<string, unknown>[];
  readonly tools?: readonly Record<string, unknown>[];
}

interface Scenario {
  readonly requests: number;
  readonly wire: readonly WireRequest[];
  readonly status: string;
  readonly invocations: number;
  readonly toolResults: number;
  readonly failingEvents: readonly unknown[];
  readonly timeline: readonly string[];
}

const GOOD_ARGS = '{"path":"probe.txt"}';
const BAD_ARGS = '{"path":';

/** SSE chunk carrying one assistant turn of tool calls, in the OpenAI chat dialect. */
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chunk",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function sse(
  calls: readonly { readonly id: string; readonly arguments: string }[],
): Response {
  const toolCalls = calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: { name: "read_file", arguments: call.arguments },
  }));
  const body =
    chunk({ tool_calls: toolCalls }) +
    chunk({}, "tool_calls") +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseText(text: string): Response {
  return new Response(
    chunk({ content: text }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * Run one scenario end to end.
 *
 * ```text
 * turn 1   a mixed batch: one valid read and one truncated argument string
 * turn 2   the model corrects the call, or answers, after receiving the feedback
 * ```
 *
 * The second turn's response is decided by the *request it received*, so the assertion is about what
 * the production path actually built rather than about a scripted sequence.
 */
async function runMixedBatch(options: {
  readonly correctInTurnTwo: boolean;
}): Promise<Scenario> {
  const wire: WireRequest[] = [];
  let requests = 0;
  const adapter = {
    id: FIXTURE_API,
    async *stream(input: { readonly provider: unknown }) {
      const native = createOpenAICompatibleApiAdapter();
      const respond = (): Response => {
        // The turn number is decided when the transport is actually called, so a request that never
        // reached the wire cannot shift the script.
        if (requests === 1) {
          return sse([
            { id: "call-good", arguments: GOOD_ARGS },
            { id: "call-bad", arguments: BAD_ARGS },
          ]);
        }
        if (requests === 2 && options.correctInTurnTwo) {
          return sse([{ id: "call-fixed", arguments: GOOD_ARGS }]);
        }
        return sseText("Finished.");
      };
      yield* native.stream({
        ...(input as never),
        provider: {
          ...(input.provider as Record<string, unknown>),
          endpoint: "http://127.0.0.1:1/offline",
          credentials: { apiKey: "offline-fixture" },
          headers: {},
          queryParams: {},
          transport: {
            fetch: async (_url: string, init?: { readonly body?: unknown }) => {
              requests += 1;
              // The *real* provider body, not the pre-translation AI messages: this is the only
              // place a native replay or a repaired argument could be observed. A non-string body is
              // recorded as empty rather than throwing inside the transport.
              const bodyText = typeof init?.body === "string" ? init.body : "";
              wire.push({
                messages:
                  bodyText.length === 0
                    ? []
                    : ((JSON.parse(bodyText) as { readonly messages?: readonly Record<string, unknown>[] })
                        .messages ?? []),
              } as WireRequest);
              return respond();
            },
          },
        },
      } as never);
    },
  };

  const fixture = await createReliabilityFixture({
    adapter: adapter as never,
    limits: { maxSteps: 8, maxToolCalls: 20, timeoutMs: 60_000 },
  });
  try {
    await writeFile(join(fixture.workspacePath, "probe.txt"), "Synthetic evidence.\n", "utf8");
    const outcome = await fixture.composition.controller.start(fixture.run.id);
    const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
    const invocations = (
      db.prepare("SELECT count(*) AS n FROM tool_invocations WHERE run_id=?").get(fixture.run.id) as {
        n: number;
      }
    ).n;
    const toolResults = (
      db
        .prepare("SELECT count(*) AS n FROM agent_messages WHERE run_id=? AND message_type='TOOL_RESULT'")
        .get(fixture.run.id) as { n: number }
    ).n;
    const timeline = (
      db
        .prepare("SELECT event_type, data_json FROM agent_events WHERE run_id=? ORDER BY aggregate_sequence")
        .all(fixture.run.id) as { event_type: string; data_json: string }[]
    ).map((row) =>
      row.event_type === "llm.failed"
        ? `llm.failed:${row.data_json.slice(0, 700)}`
        : row.event_type,
    );
    const failingEvents = db
      .prepare(
        "SELECT event_type, data_json FROM agent_events WHERE run_id=? AND event_type='run.failed'",
      )
      .all(fixture.run.id);
    db.close();
    return {
      requests,
      wire,
      status: outcome.run.status,
      invocations,
      toolResults,
      failingEvents,
      timeline,
    };
  } finally {
    await fixture.dispose();
  }
}

describe("a rejected tool request is corrected instead of ending the Run", () => {
  it("keeps the valid call, answers the rejected one, and continues to completion", async () => {
    const scenario = await runMixedBatch({ correctInTurnTwo: true });

    // The Run survived the malformed arguments and finished on its own.
    expect(scenario.failingEvents).toEqual([]);
    expect(scenario.status).toBe("COMPLETED");
    // Two physical calls ran (the valid one, then the corrected one); the rejected request never
    // reached the ledger. Three results: two answers to turn 1 and one to turn 2.
    expect(scenario.invocations).toBe(2);
    expect(scenario.toolResults).toBe(3);

    // The first turn asked for two calls; the second turn must carry both, plus both results.
    expect(scenario.requests).toBeGreaterThanOrEqual(3);
    const second = scenario.wire[1]!;
    const assistant = second.messages.find((message) => message["role"] === "assistant");
    const toolCallIds = (
      (assistant?.["tool_calls"] as readonly { readonly id: string }[] | undefined) ?? []
    ).map((call) => call.id);
    expect(toolCallIds).toEqual(["call-good", "call-bad"]);

    const toolMessages = second.messages.filter((message) => message["role"] === "tool");
    expect(toolMessages.map((message) => message["tool_call_id"])).toEqual([
      "call-good",
      "call-bad",
    ]);
    const rejected = toolMessages[1]!;
    expect(String(rejected["content"])).toContain("was rejected before execution");
    expect(String(rejected["content"])).toContain("read_file");
  });

  it("still ends the Run when the model answers instead of correcting", async () => {
    const scenario = await runMixedBatch({ correctInTurnTwo: false });

    expect(scenario.status).toBe("COMPLETED");
    expect(scenario.invocations).toBe(1);
    expect(scenario.toolResults).toBe(2);
  });
});

describe("rejected request persistence", () => {
  it("stores the rejection by identity and reason without the received bytes", async () => {
    let turns = 0;
    const adapter = {
      id: FIXTURE_API,
      async *stream(input: { readonly provider: unknown }) {
        const native = createOpenAICompatibleApiAdapter();
        yield* native.stream({
          ...(input as never),
          provider: {
            ...(input.provider as Record<string, unknown>),
            endpoint: "http://127.0.0.1:1/offline",
            credentials: { apiKey: "offline-fixture" },
            headers: {},
            queryParams: {},
            transport: {
              fetch: async () => {
                turns += 1;
                return turns === 1
                  ? sse([{ id: "call-bad", arguments: BAD_ARGS }])
                  : sseText("Finished.");
              },
            },
          },
        } as never);
      },
    };
    const fixture = await createReliabilityFixture({
      adapter: adapter as never,
      limits: { maxSteps: 6, maxToolCalls: 10, timeoutMs: 60_000 },
    });
    try {
      await fixture.composition.controller.start(fixture.run.id);
      const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
      const rows = db
        .prepare(
          "SELECT schema_version, data_json FROM agent_messages WHERE run_id=? AND message_type='ASSISTANT'",
        )
        .all(fixture.run.id) as { schema_version: number; data_json: string }[];
      db.close();

      expect(rows.length).toBeGreaterThan(0);
      const encoded = rows.map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
      const withRejection = encoded.find((data) =>
        JSON.stringify(data).includes("TOOL_CALL_REJECTED"),
      );
      expect(withRejection).toBeDefined();
      expect(rows.some((row) => row.schema_version === 4)).toBe(true);

      const rejectedPart = (
        withRejection!["content"] as readonly Record<string, unknown>[]
      ).find((part) => part["type"] === "TOOL_CALL_REJECTED")!;
      expect(rejectedPart).toMatchObject({
        toolCallId: "call-bad",
        toolName: "read_file",
        issue: { code: "MALFORMED_JSON" },
      });
      // The durable message must never contain the received bytes.
      expect(JSON.stringify(withRejection)).not.toContain('{\\"path\\":');
    } finally {
      await fixture.dispose();
    }
  });
});
