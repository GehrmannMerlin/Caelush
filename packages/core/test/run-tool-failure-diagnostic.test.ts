import {
  ToolBatchInfrastructureError,
  ToolExecutionInfrastructureError,
  ToolExecutionUncertainError,
  ToolPreparationInfrastructureError,
  type ToolExecutionInfrastructurePhase,
} from "@caelush/agent";
import { createRunId, createStepId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { classifyToolFailure } from "../src/index.js";

/**
 * The bounded Tool failure diagnostic.
 *
 * A Run that fails in the Tool phase used to persist one generic `RUNTIME_ERROR`, so the host knew a
 * Tool broke and nothing else. The classifier recovers a *stage* from typed cause links only — never
 * from a message — and produces a small JSON-safe object. Everything a message, a stack, an argument
 * or a host path could say stays outside it.
 */

const runId = createRunId();
const stepId = createStepId();

function classify(cause: unknown) {
  return classifyToolFailure({ runId, sourceStepId: stepId, cause });
}

describe("Tool failure classification", () => {
  it("finds the preparation stage underneath the batch wrapper", () => {
    const diagnostic = classify(
      new ToolBatchInfrastructureError("batch failed", {
        cause: new ToolPreparationInfrastructureError("preparation failed", {
          cause: new TypeError("Cannot assign to read only property 'patch'"),
          toolName: "apply_patch",
        }),
      }),
    );

    expect(diagnostic).toEqual({
      runId,
      sourceStepId: stepId,
      stage: "PREPARATION",
      reasonCode: "TOOL_PREPARATION_FAILED",
      causeKinds: [
        "ToolBatchInfrastructureError",
        "ToolPreparationInfrastructureError",
        "TypeError",
      ],
    });
  });

  it("maps every typed phase to its own reason code", () => {
    const cases: Array<[ToolExecutionInfrastructurePhase, string]> = [
      ["PREPARATION", "TOOL_PREPARATION_FAILED"],
      ["ADMISSION", "TOOL_ADMISSION_FAILED"],
      ["EXECUTION", "TOOL_EXECUTION_INFRASTRUCTURE_FAILED"],
      ["RESULT_PIPELINE", "TOOL_RESULT_PIPELINE_FAILED"],
      ["SETTLEMENT", "TOOL_SETTLEMENT_FAILED"],
      ["RECOVERY", "TOOL_RECOVERY_FAILED"],
    ];
    for (const [phase, reasonCode] of cases) {
      const diagnostic = classify(
        new ToolBatchInfrastructureError("batch failed", {
          cause: new ToolExecutionInfrastructureError(phase, "phase failed"),
        }),
      );
      expect(diagnostic.stage, phase).toBe(phase);
      expect(diagnostic.reasonCode, phase).toBe(reasonCode);
    }
  });

  it("does not guess a stage from an untyped error", () => {
    for (const cause of [
      new Error("Tool execution infrastructure failed: PREPARATION"),
      new TypeError("tool preparation admission settlement"),
      "PREPARATION",
      undefined,
      null,
    ]) {
      const diagnostic = classify(cause);
      expect(diagnostic.stage).toBe("UNKNOWN");
      expect(diagnostic.reasonCode).toBe("TOOL_INFRASTRUCTURE_FAILED");
    }
  });

  it("keeps the uncertain-side-effect signal distinguishable", () => {
    const diagnostic = classify(
      new ToolBatchInfrastructureError("batch failed", {
        cause: new ToolExecutionUncertainError(),
      }),
    );

    expect(diagnostic.stage).toBe("UNKNOWN");
    expect(diagnostic.causeKinds).toEqual([
      "ToolBatchInfrastructureError",
      "ToolExecutionUncertainError",
    ]);
  });

  it("bounds the cause chain and never publishes raw error content", () => {
    const secret = "sk-live-1234567890";
    const hostPath = "C:\\Users\\someone\\private-project\\src\\secret.ts";
    let cause: unknown = new TypeError(`${secret} at ${hostPath}`);
    for (let index = 0; index < 6; index += 1) {
      cause = new Error(`${secret} wrapper ${index}`, { cause });
    }
    (cause as Error & { secret?: string }).secret = secret;

    const diagnostic = classify(cause);

    expect(diagnostic.causeKinds).toHaveLength(4);
    expect(diagnostic.causeKinds).toEqual(["Error", "Error", "Error", "Error"]);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(hostPath);
    expect(serialized).not.toContain("private-project");
    expect(Object.keys(diagnostic).sort()).toEqual([
      "causeKinds",
      "reasonCode",
      "runId",
      "sourceStepId",
      "stage",
    ]);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.causeKinds)).toBe(true);
  });

  it("survives a hostile cause accessor instead of masking the Run failure", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "cause", {
      get() {
        throw new Error("accessor exploded");
      },
    });

    expect(() => classify(hostile)).not.toThrow();
    expect(classify(hostile).causeKinds).toEqual(["Error"]);
  });

  it("terminates on a cyclic cause chain", () => {
    const looped = new Error("looped") as Error & { cause?: unknown };
    looped.cause = looped;

    const diagnostic = classify(looped);

    expect(diagnostic.causeKinds).toEqual(["Error"]);
    expect(diagnostic.reasonCode).toBe("TOOL_INFRASTRUCTURE_FAILED");
  });

  it("labels a cause it does not recognize without echoing it", () => {
    class CustomFailure extends Error {}
    const diagnostic = classify(new CustomFailure("internal detail"));

    expect(diagnostic.causeKinds).toEqual(["UnknownCause"]);
    expect(JSON.stringify(diagnostic)).not.toContain("internal detail");
  });
});
