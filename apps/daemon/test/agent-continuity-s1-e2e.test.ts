import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createReliabilityFixture } from "./support/reliability-fixture.js";

/**
 * S1: what a batch does after one of its calls did not complete.
 *
 * Two facts from the same production composition — the pinned SDK parsing a real SSE body, the real
 * daemon committing through SQLite, and the canonical batch coordinator deciding what may still run:
 *
 * ```text
 * T3  a later mutation is withheld when its independence from the failure is unproven
 * T8  a run of identical malformed requests is counted as one recurring mistake
 * ```
 *
 * Both are asserted through durable truth (Tool invocations, workspace files, the resource ledger),
 * not through the model-facing prose, because prose is a rendering and the ledger is the record.
 */

const API = "openai-compatible-chat";
const BAD_ARGS = '{"path":';

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chunk",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

interface WireCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

function sse(calls: readonly WireCall[] | undefined, text = "Finished."): Response {
  const delta =
    calls === undefined
      ? { content: text }
      : {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        };
  return new Response(
    chunk({ reasoning_content: "SYNTHETIC_TEST_REASONING" }) +
      chunk(delta) +
      chunk({}, calls === undefined ? "stop" : "tool_calls") +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function fixtureWith(
  label: string,
  handler: (wire: Record<string, unknown>, index: number) => Response,
) {
  const rootDirectory = await mkdtemp(join(tmpdir(), `caelush-${label}-`));
  const wires: Record<string, unknown>[] = [];
  const fixture = await createReliabilityFixture({
    rootDirectory,
    api: API,
    // The built-in adapter is the only one registered for `openai-compatible-chat`; the wire is
    // supplied through the provider transport, so this exercises the real SDK and the provider's own
    // replay-identity check instead of a fixture dialect.
    useBuiltinAdapter: true,
    providerBindingOverrides: {
      defaultApi: API,
      endpoint: "http://127.0.0.1:1/offline",
      transport: {
        fetch: async (_url: unknown, init: { readonly body?: unknown }) => {
          const wire = JSON.parse(String(init.body)) as Record<string, unknown>;
          wires.push(wire);
          return handler(wire, wires.length - 1);
        },
      },
    },
    modelLimits: { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 },
    adapterMetadata: { "openai-compatible": { requiresReasoningReplayWithTools: true } },
  });
  return { fixture, wires };
}

function toolResultsOf(wire: Record<string, unknown> | undefined) {
  const messages = (wire?.["messages"] ?? []) as readonly Record<string, unknown>[];
  return messages.filter((message) => message["role"] === "tool");
}

describe("agent continuity S1 — dependency barrier and correction facts", () => {
  it("withholds a later mutation after a rejected migration but keeps the applied patch", async () => {
    const patch = (path: string) =>
      JSON.stringify({
        patch: `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch`,
      });
    const { fixture, wires } = await fixtureWith("dependency", (_wire, index) =>
      index === 0
        ? sse([
            { id: "prefix", name: "apply_patch", arguments: patch("prefix.txt") },
            // A JSON array is a document, but not an arguments object: the preparer rejects it and the
            // request never becomes an invocation.
            { id: "migrate", name: "exec_command", arguments: "[]" },
            { id: "later", name: "apply_patch", arguments: patch("later.txt") },
          ])
        : sse(undefined),
    );
    try {
      const end = await fixture.composition.controller.start(fixture.run.id);
      const applied = async (name: string) =>
        readFile(join(fixture.workspacePath, name), "utf8").then(
          () => true,
          () => false,
        );
      const results = toolResultsOf(wires[1]);
      const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);

      expect(end.run.status).toBe("COMPLETED");
      // The successful prefix is kept and applied exactly once.
      expect(await applied("prefix.txt")).toBe(true);
      // Q13: the unproven dependency is not executed, and the model is told so in place.
      expect(await applied("later.txt")).toBe(false);
      expect(results).toHaveLength(3);
      expect(String(results[2]?.["content"])).toMatch(/was not started/i);
      expect(String(results[2]?.["content"])).toMatch(/depend/i);
      // One real invocation (the prefix patch); the rejected and withheld calls created none.
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.toolName).toBe("apply_patch");
    } finally {
      await fixture.dispose();
    }
  }, 120_000);

  it("counts five malformed-argument rounds as one recurring mistake", async () => {
    const { fixture, wires } = await fixtureWith("rejected-pattern", (_wire, index) =>
      index < 5
        ? sse([{ id: `bad-${index}`, name: "read_file", arguments: BAD_ARGS + " ".repeat(index) }])
        : sse(undefined),
    );
    try {
      const end = await fixture.composition.controller.start(fixture.run.id);
      const state = await fixture.storage.resourceGovernance.get(fixture.run.id);
      const turns = state?.semanticProgress?.turns ?? [];
      const patternKeys = new Set(turns.flatMap((turn) => turn.patterns.map((p) => p.key)));

      expect(end.run.status).toBe("COMPLETED");
      expect(wires).toHaveLength(6);
      // One stable pattern, counted once per accepted turn — the different argument byte counts and
      // the changing external call ids do not create five "new" findings.
      expect(patternKeys.size).toBe(1);
      expect(turns.reduce((total, turn) => total + turn.patterns.length, 0)).toBe(5);
      // The existing correction ladder actually delivered its advice, so the next turn could act on it.
      expect(state?.semanticProgress?.active?.deliveredInterventions ?? 0).toBeGreaterThan(0);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);

  it("dispatches an eighteen-call batch in two chunks without a second model turn", async () => {
    const { fixture, wires } = await fixtureWith("oversize", (_wire, index) =>
      index === 0
        ? sse(
            Array.from({ length: 18 }, (_unused, ordinal) => ({
              id: `read-${ordinal}`,
              name: "read_file",
              arguments: '{"path":"probe.txt"}',
            })),
          )
        : sse(undefined),
    );
    try {
      await writeFile(join(fixture.workspacePath, "probe.txt"), "Evidence.\n", "utf8");
      const end = await fixture.composition.controller.start(fixture.run.id);
      const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
      const results = toolResultsOf(wires[1]);

      expect(end.run.status).toBe("COMPLETED");
      // Two provider turns: the request, and the answer after all eighteen results arrived. Chunking
      // is an execution detail and buys no extra model request.
      expect(wires).toHaveLength(2);
      expect(invocations).toHaveLength(18);
      expect(new Set(invocations.map((invocation) => invocation.externalCallId)).size).toBe(18);
      expect(results).toHaveLength(18);
      // Source order is preserved across the chunk boundary.
      expect(results.map((message) => message["tool_call_id"])).toEqual(
        Array.from({ length: 18 }, (_unused, ordinal) => `read-${ordinal}`),
      );
    } finally {
      await fixture.dispose();
    }
  }, 180_000);

  it("waits out a transient 503 instead of ending the Run", async () => {
    const { fixture, wires } = await fixtureWith("provider-503", (_wire, index) =>
      index === 0
        ? new Response('{"error":{"message":"upstream unavailable"}}', {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        : sse(undefined, "Recovered after the provider came back."),
    );
    try {
      const first = await fixture.composition.controller.start(fixture.run.id);
      // A transient status is a wait, not a terminal failure: the Run stays RUNNING with a durable
      // retry checkpoint, and the attempt is scheduled rather than looped in-process.
      expect(first.run.status).toBe("RUNNING");
      expect(wires).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 1_600));
      const resumed = await fixture.composition.controller.recover(fixture.run.id);

      expect(resumed.run.status).toBe("COMPLETED");
      expect(wires).toHaveLength(2);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);

  it("keeps an independent read running after a malformed request in the same batch", async () => {
    const { fixture, wires } = await fixtureWith("independent-read", (_wire, index) =>
      index === 0
        ? sse([
            { id: "bad", name: "read_file", arguments: BAD_ARGS },
            { id: "good", name: "read_file", arguments: '{"path":"probe.txt"}' },
          ])
        : sse(undefined),
    );
    try {
      await writeFile(join(fixture.workspacePath, "probe.txt"), "Evidence.\n", "utf8");
      // Write the file before the Run starts, so the read cannot race the fixture setup.
      const end = await fixture.composition.controller.start(fixture.run.id);
      const results = toolResultsOf(wires[1]);

      expect(end.run.status).toBe("COMPLETED");
      expect(results).toHaveLength(2);
      // The valid read ran and returned the file's content; the malformed one carried the reason.
      expect(String(results[1]?.["content"])).toContain("Evidence.");
      expect(String(results[0]?.["content"])).toMatch(/not valid JSON|rejected/i);
      const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
      expect(invocations).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);
});
