import { describe, expect, it } from "vitest";
import type {
  AgentExecutionIdentity,
  AgentTurnInput,
  LegacyContextItem,
  ContextProvider,
  ContextProviderInput,
} from "@caelush/agent";
import { agentMessageId } from "@caelush/agent";
import type { ModelDescriptor } from "@caelush/ai";
import { createRunId, createSessionId, createStepId } from "@caelush/protocol";

/**
 * The Context Provider seam, standalone.
 *
 * This file imports exactly one workspace package — `@caelush/agent` — plus the ID factory a host
 * needs to name a turn. There is no Workspace, no project inspector, no Git, no Runtime, no
 * Storage and no legacy Context anywhere in it.
 *
 * What it proves, and what it deliberately does not:
 *
 * ```text
 * PROVEN      the frozen ContextProvider seam is implementable and receives exactly the input
 *             the freeze names, including the model descriptor
 * NOT PROVEN  a provider-based ContextEngine
 * ```
 *
 * No production Context Engine consumes `ContextProvider` yet. The legacy adapter assembles
 * system context, conversation and relevant files itself and has no injection point that could
 * take a `ContextItem` without changing prompt order or the token budget, so the seam is a
 * frozen contract with a conformance proof rather than a wired pipeline. The pipeline belongs to
 * Context Engineering V2.
 */

const IDENTITY: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "conform to the frozen provider seam",
};

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "model-a" },
  api: "test-api",
  limits: { contextWindowTokens: 8_000, maxOutputTokens: 1_000 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

/**
 * A test-owned provider.
 *
 * It does the only thing a general provider may do with a turn: decide relevance from the turn
 * input and contribute text items. It consults `model` for capability only, and it could not
 * consult history even if it wanted to — the frozen input does not carry one.
 */
function testProvider(): {
  readonly provider: ContextProvider;
  received(): readonly ContextProviderInput[];
} {
  const received: ContextProviderInput[] = [];
  return {
    provider: {
      id: "test-provider",
      provide(input): Promise<readonly LegacyContextItem[]> {
        received.push(input);
        const goal =
          input.input.kind === "USER_INPUT"
            ? `durable-user:${input.input.userMessageId}`
            : input.input.kind === "CONTINUATION"
              ? `continuation:${input.input.reason}`
              : "tool results";
        return Promise.resolve([
          {
            id: `test:${String(received.length)}`,
            priorityClass: "NORMAL",
            content: `goal=${goal} model=${input.model.ref.provider}/${input.model.ref.model}`,
            tokenEstimate: 8,
          },
        ]);
      },
    },
    received: () => received,
  };
}

describe("ContextProvider conformance", () => {
  it("receives exactly the frozen input, including the resolved model", async () => {
    const fixture = testProvider();
    const controller = new AbortController();
    const turn = { stepId: createStepId(), sequence: 1 };
    const input: AgentTurnInput = {
      kind: "USER_INPUT",
      userMessageId: agentMessageId("provider-user"),
    };

    const items = await fixture.provider.provide({
      identity: IDENTITY,
      turn,
      input,
      model: MODEL,
      signal: controller.signal,
    });

    expect(fixture.received()).toHaveLength(1);
    const seen = fixture.received()[0]!;
    // The exact field set, asserted at runtime as well as at compile time.
    expect(Object.keys(seen).sort()).toEqual(["identity", "input", "model", "signal", "turn"]);
    expect(seen.identity).toBe(IDENTITY);
    expect(seen.turn).toBe(turn);
    expect(seen.input).toBe(input);
    expect(seen.model).toBe(MODEL);
    expect(seen.signal).toBe(controller.signal);
    // The conversation is not the provider's to assemble.
    expect(seen).not.toHaveProperty("history");
    expect(seen).not.toHaveProperty("messages");
    expect(items).toEqual([
      {
        id: "test:1",
        priorityClass: "NORMAL",
        content: "goal=durable-user:provider-user model=test/model-a",
        tokenEstimate: 8,
      },
    ]);
  });

  it("works for every frozen turn input kind", async () => {
    const fixture = testProvider();
    const signal = new AbortController().signal;
    const turn = { stepId: createStepId(), sequence: 4 };

    for (const input of [
      { kind: "USER_INPUT", userMessageId: agentMessageId("provider-user-a") },
      { kind: "CONTINUATION", reason: "VERIFICATION_REPAIR" },
      { kind: "CONTINUATION", reason: "STEERING" },
    ] satisfies readonly AgentTurnInput[]) {
      await fixture.provider.provide({ identity: IDENTITY, turn, input, model: MODEL, signal });
    }

    expect(fixture.received().map((entry) => entry.input.kind)).toEqual([
      "USER_INPUT",
      "CONTINUATION",
      "CONTINUATION",
    ]);
    // A provider that read model capabilities still never changed the model authority.
    expect(fixture.received().every((entry) => entry.model === MODEL)).toBe(true);
  });
});
