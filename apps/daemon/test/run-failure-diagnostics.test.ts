import { createRunId, createStepId } from "@caelush/protocol";
import type { RunToolFailureDiagnostic } from "@caelush/core";
import { describe, expect, it, vi } from "vitest";

import {
  createRunFailureDiagnostics,
  toToolFailureLogEntry,
} from "../src/services/run-failure-diagnostics.js";

function diagnostic(overrides: Partial<RunToolFailureDiagnostic> = {}): RunToolFailureDiagnostic {
  return {
    runId: createRunId(),
    sourceStepId: createStepId(),
    stage: "PREPARATION",
    reasonCode: "TOOL_PREPARATION_FAILED",
    causeKinds: ["ToolBatchInfrastructureError", "ToolPreparationInfrastructureError"],
    ...overrides,
  };
}

describe("Run failure diagnostics adapter", () => {
  it("shapes one fixed log entry and never forwards an exception", () => {
    const value = diagnostic();

    const entry = toToolFailureLogEntry(value);

    expect(entry).toEqual({
      event: "run.tool.failure",
      runId: value.runId,
      sourceStepId: value.sourceStepId,
      stage: "PREPARATION",
      reasonCode: "TOOL_PREPARATION_FAILED",
      causeKinds: ["ToolBatchInfrastructureError", "ToolPreparationInfrastructureError"],
    });
    expect(JSON.stringify(entry)).not.toContain("message");
    expect(JSON.stringify(entry)).not.toContain("stack");
  });

  it("degrades a reason code outside the published vocabulary to the generic one", () => {
    const entry = toToolFailureLogEntry(
      diagnostic({ reasonCode: "PREPARATION: ENOENT C:\\repo\\.env" as never }),
    );

    expect(entry.reasonCode).toBe("TOOL_INFRASTRUCTURE_FAILED");
    expect(JSON.stringify(entry)).not.toContain("ENOENT");
    expect(JSON.stringify(entry)).not.toContain("repo");
  });

  it("copies the cause kinds so a later mutation cannot rewrite a line already logged", () => {
    const causeKinds = ["ToolBatchInfrastructureError"];
    const entry = toToolFailureLogEntry(diagnostic({ causeKinds }));

    causeKinds.push("TypeError");

    expect(entry.causeKinds).toEqual(["ToolBatchInfrastructureError"]);
    expect(Object.isFrozen(entry.causeKinds)).toBe(true);
  });

  it("records through the host logger when one is configured", () => {
    const toolFailure = vi.fn();
    const port = createRunFailureDiagnostics({ logger: { toolFailure } });
    const value = diagnostic();

    port.recordToolFailure(value);

    expect(toolFailure).toHaveBeenCalledTimes(1);
    expect(toolFailure).toHaveBeenCalledWith(
      expect.objectContaining({ event: "run.tool.failure", reasonCode: "TOOL_PREPARATION_FAILED" }),
    );
    expect(toolFailure.mock.calls[0]![0]).not.toBe(value);
  });

  it("has no sink without a logger, and recording is still a no-op instead of a failure", () => {
    const port = createRunFailureDiagnostics();

    expect(() => port.recordToolFailure(diagnostic())).not.toThrow();
  });
});
