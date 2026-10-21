import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import type { AgentError } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { DefaultPublicEventProjector } from "../src/events/public-event-projector.js";
import { answer } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

/**
 * A real Context preparation failure, through the production path and nothing else.
 *
 * ```text
 * real daemon composition → real RunController → real Context Engine → real SQLite
 *   → a model window too small for the projection
 *   → PromptSurfaceCapacityError / ContextExhaustedError           (typed, local)
 *   → Core re-reads it as a context failure                        (never a provider error)
 *   → durable AgentState error + durable llm.failed event
 *   → public projection                                            (closed classification only)
 * ```
 *
 * The provider is scripted to record every call, because the claim being tested is a negative one:
 * this failure never reached the model. A test that only checked the Run status would pass even if
 * the failure had been reported as `MODEL_ERROR` after a real provider round trip.
 */

const fixtures: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of fixtures.splice(0)) await dispose();
});

class RecordingAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    void input;
    this.calls += 1;
    return this.respond();
  }

  private async *respond(): AsyncGenerator<AIAdapterEvent> {
    yield* answer("this answer must never be requested");
  }
}

describe("Context preparation failure in the production daemon", () => {
  it("settles as a local context failure, reports no provider call and publishes only the classification", async () => {
    const adapter = new RecordingAdapter();
    const fixture = await createReliabilityFixture({
      adapter,
      // Too small for the system prompt, the authoritative state and the Run's goal together.
      modelLimits: { contextWindowTokens: 600, maxOutputTokens: 128 },
    });
    fixtures.push(async () => {
      await fixture.dispose();
    });

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(result.run.status).toBe("FAILED");
    // The claim: the failure was local. No provider request was made, so nothing was billed.
    expect(adapter.calls).toBe(0);

    const snapshot = await fixture.storage.execution.load(fixture.run.id);
    const error = snapshot?.state?.errors.at(-1) as AgentError | undefined;
    expect(error).toBeDefined();
    const details = error?.details as
      | { contextPreparation?: { reasonCode?: string; stage?: string } }
      | undefined;
    /*
     * The exact classification, not a membership check.
     *
     * ```text
     * window 600 · output reserve 48 · safety reserve 6 · request overhead ≈ 3 000
     *   → no positive input budget → ContextPressureAccountingError
     * ```
     *
     * The reason this is reachable in production at all is that the failure is typed: an untyped
     * `RangeError` would classify as `unknown`, which is honest but useless to an operator deciding
     * whether the model configuration is wrong or the conversation is too big.
     */
    expect(details?.contextPreparation).toStrictEqual({
      reasonCode: "CONTEXT_PRESSURE_ACCOUNTING_FAILED",
      stage: "pressure_accounting",
    });
    // The misreport this replaced: a local projection failure settled as a model failure.
    expect(error?.code).toBe("INTERNAL_ERROR");
    expect(error?.phase).toBe("INTERNAL");
    expect(error?.retryable).toBe(false);

    // The durable event carries the same classification, and the public stream republishes only it.
    const events = await fixture.storage.eventReader.replay(fixture.run.id, { afterSequence: 0 });
    // A preparation failure carries no provider turn, so the terminal event is the Run's own.
    const failedRun = events.find((event) => event.type === "run.failed");
    expect(failedRun).toBeDefined();
    expect(events.some((event) => event.type === "llm.started")).toBe(false);
    const published = new DefaultPublicEventProjector().project(failedRun!);
    expect(published).not.toBeNull();
    const publishedError = (published?.payload as { error?: Record<string, unknown> }).error;
    expect(publishedError).toMatchObject({
      code: error?.code,
      details: { contextPreparation: details?.contextPreparation },
    });
    // Nothing about the workspace, the prompt or the host travels with it.
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain("workspace");
    expect(serialized).not.toContain("goal");
  });
});
