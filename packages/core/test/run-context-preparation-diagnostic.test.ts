import {
  ContextExhaustedError,
  ContextMandatoryInputTooLargeError,
  ContextPlanningError,
  ContextPressureAccountingError,
  PromptSurfaceCapacityError,
  PromptSurfaceIntegrityError,
  PromptSurfaceRolloverConflictError,
} from "@caelush/agent";
import type { RunContextPreparationDiagnostic } from "@caelush/core";
import { classifyContextPreparationFailure, contextPreparationAgentError } from "@caelush/core";
import { createRunId, createStepId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

/**
 * The Context preparation classification.
 *
 * ```text
 * typed cause → stage + reason code        (read from the class, never from the text)
 * measured bound → dimension/observed/limit
 * unknown → unknown / CONTEXT_PREPARATION_FAILED
 * ```
 *
 * The canary strings below stand in for the things a diagnostic must never carry: a prompt
 * fragment, a host path, a key. Every test asserts on the serialized diagnostic, because the point
 * of the type is that a *consumer* cannot leak what the classifier never received.
 */

const CANARY = "CANARY-secret-prompt-and-C:/Users/owner/.env";

function classify(cause: unknown): RunContextPreparationDiagnostic {
  return classifyContextPreparationFailure({
    runId: createRunId(),
    sourceStepId: createStepId(),
    cause,
  });
}

describe("Context preparation failure classification", () => {
  it("keeps the measured bound of a Prompt Surface capacity failure", () => {
    const diagnostic = classify(
      new PromptSurfaceCapacityError(
        {
          reason: "BASELINE_TOO_LARGE",
          stage: "surface_capacity",
          dimension: "BASELINE_UTF8_BYTES",
          observed: 4_194_305,
          limit: 4_194_304,
          cause: new RangeError(CANARY),
        },
        `The projection does not fit: ${CANARY}`,
      ),
    );

    expect(diagnostic).toMatchObject({
      stage: "surface_capacity",
      reasonCode: "CONTEXT_SURFACE_BASELINE_TOO_LARGE",
      dimension: "BASELINE_UTF8_BYTES",
      observed: 4_194_305,
      limit: 4_194_304,
    });
    expect(diagnostic.causeKinds).toEqual(["PromptSurfaceCapacityError", "RangeError"]);
    expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
    expect(JSON.stringify(diagnostic)).not.toContain("Users");
  });

  it("maps every capacity reason to its own code and stage", () => {
    const cases = [
      ["BASELINE_TOO_LARGE", "surface_capacity", "CONTEXT_SURFACE_BASELINE_TOO_LARGE"],
      ["EPOCH_ROLLOVER_CONFLICT", "surface_capacity", "CONTEXT_SURFACE_ROLLOVER_CONFLICT"],
      ["EPOCH_ROLLOVER_FAILED", "surface_capacity", "CONTEXT_SURFACE_ROLLOVER_FAILED"],
      ["SURFACE_PERSISTENCE_FAILED", "surface_persistence", "CONTEXT_SURFACE_PERSISTENCE_FAILED"],
    ] as const;
    const rendered = new Set<string>();
    for (const [reason, stage, reasonCode] of cases) {
      const diagnostic = classify(new PromptSurfaceCapacityError({ reason, stage }, "bounded"));
      expect(diagnostic.stage).toBe(stage);
      expect(diagnostic.reasonCode).toBe(reasonCode);
      rendered.add(diagnostic.reasonCode);
    }
    // Four reasons, four codes: collapsing them would hide which bound gave way.
    expect(rendered.size).toBe(4);
  });

  it("classifies the remaining typed context errors by their class", () => {
    expect(
      classify(new PromptSurfaceIntegrityError("digest mismatch", { cause: new Error(CANARY) })),
    ).toMatchObject({ stage: "surface_read", reasonCode: "CONTEXT_SURFACE_INTEGRITY_FAILED" });
    expect(classify(new PromptSurfaceRolloverConflictError("epoch moved"))).toMatchObject({
      stage: "surface_capacity",
      reasonCode: "CONTEXT_SURFACE_ROLLOVER_CONFLICT",
    });
    expect(classify(new ContextExhaustedError())).toMatchObject({
      stage: "compaction",
      reasonCode: "CONTEXT_WINDOW_EXHAUSTED",
    });
    expect(classify(new ContextMandatoryInputTooLargeError())).toMatchObject({
      stage: "pressure_accounting",
      reasonCode: "CONTEXT_PRESSURE_ACCOUNTING_FAILED",
    });
    expect(classify(new ContextPlanningError("DUPLICATE_ITEM_ID"))).toMatchObject({
      stage: "pressure_accounting",
      reasonCode: "CONTEXT_PRESSURE_ACCOUNTING_FAILED",
      planningErrorCode: "DUPLICATE_ITEM_ID",
    });
    // The reachable production condition: reserves plus the request's own overhead exceed the window,
    // so there is no positive input allowance to plan against.
    expect(classify(new ContextPressureAccountingError("no positive input budget"))).toMatchObject({
      stage: "pressure_accounting",
      reasonCode: "CONTEXT_PRESSURE_ACCOUNTING_FAILED",
      causeKinds: ["ContextPressureAccountingError"],
    });
  });

  it("reports an untyped failure as unknown instead of guessing from its text or code", () => {
    // A class that *looks* like the engine's own: same name, same code, a message that reads like a
    // capacity failure. None of those is a type, so none of them may become a classification.
    class ContextExhaustedErrorLookalike extends Error {
      readonly code = "CONTEXT_EXHAUSTED";
    }
    const diagnostic = classify(
      new ContextExhaustedErrorLookalike(
        `The context window is exhausted; baseline too large at ${CANARY}`,
      ),
    );

    expect(diagnostic).toMatchObject({
      stage: "unknown",
      reasonCode: "CONTEXT_PREPARATION_FAILED",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
    // The class name is not trusted either: an unrecognized constructor is not a diagnostic surface.
    expect(diagnostic.causeKinds).toEqual(["UnknownCause"]);
  });

  it("finds a typed failure nested inside a wrapper, and bounds the chain", () => {
    const inner = new PromptSurfaceCapacityError(
      { reason: "SURFACE_PERSISTENCE_FAILED", stage: "surface_persistence" },
      "commit failed",
    );
    const wrapper = new Error("append failed", { cause: inner });

    const diagnostic = classify(wrapper);

    expect(diagnostic.reasonCode).toBe("CONTEXT_SURFACE_PERSISTENCE_FAILED");
    expect(diagnostic.causeKinds).toEqual(["Error", "PromptSurfaceCapacityError"]);
  });

  it("never throws on a hostile failure value", () => {
    const cyclic: Record<string, unknown> = { name: "Cyclic" };
    cyclic["cause"] = cyclic;
    const throwing = Object.defineProperty(new Error("broken"), "cause", {
      get(): never {
        throw new Error("accessor exploded");
      },
    });

    for (const cause of [cyclic, throwing, "a string", null, 42]) {
      expect(() => classify(cause)).not.toThrow();
      expect(classify(cause).causeKinds.length).toBeLessThanOrEqual(4);
    }
    // A throwing accessor ends the chain rather than replacing the Run's failure with this one.
    expect(classify(throwing)).toMatchObject({ stage: "unknown" });
  });
});

describe("Context preparation settlement error", () => {
  function errorOf(diagnostic: RunContextPreparationDiagnostic) {
    return contextPreparationAgentError(diagnostic);
  }

  it("settles a projection failure as an internal context failure, not a model failure", () => {
    const error = errorOf(
      classify(
        new PromptSurfaceCapacityError(
          {
            reason: "SURFACE_PERSISTENCE_FAILED",
            stage: "surface_persistence",
            dimension: "SECTION_STATES",
            observed: 2_049,
            limit: 2_048,
          },
          "commit failed",
        ),
      ),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      phase: "INTERNAL",
      retryable: false,
      details: {
        contextPreparation: {
          reasonCode: "CONTEXT_SURFACE_PERSISTENCE_FAILED",
          stage: "surface_persistence",
          dimension: "SECTION_STATES",
          observed: 2_049,
          limit: 2_048,
        },
      },
    });
    // The message names the local step and never the provider.
    expect(error.message).not.toMatch(/model|provider/iu);
  });

  it("keeps an exhausted window distinguishable from an infrastructure fault", () => {
    const error = errorOf(classify(new ContextExhaustedError()));

    expect(error).toMatchObject({
      code: "CONTEXT_EXHAUSTED",
      phase: "INTERNAL",
      retryable: false,
      details: {
        contextPreparation: { reasonCode: "CONTEXT_WINDOW_EXHAUSTED", stage: "compaction" },
      },
    });
  });

  it("publishes nothing but the closed classification when the bound is unusable", () => {
    const error = errorOf(
      classify(
        new PromptSurfaceCapacityError(
          {
            reason: "BASELINE_TOO_LARGE",
            stage: "surface_capacity",
            // A producer that ignored the type: neither value is a bound a reader could trust.
            dimension: `${CANARY}\n`,
            observed: -1,
            limit: 1.5,
          },
          "too large",
        ),
      ),
    );

    expect(error.details).toStrictEqual({
      contextPreparation: {
        reasonCode: "CONTEXT_SURFACE_BASELINE_TOO_LARGE",
        stage: "surface_capacity",
      },
    });
    expect(JSON.stringify(error)).not.toContain("CANARY");
  });
});
