import { createRunId, createStepId } from "@caelush/protocol";
import type { RunContextPreparationDiagnostic, RunToolFailureDiagnostic } from "@caelush/core";
import { describe, expect, it, vi } from "vitest";

import {
  createRunFailureDiagnostics,
  toContextPreparationLogEntry,
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

function contextDiagnostic(
  overrides: Partial<RunContextPreparationDiagnostic> = {},
): RunContextPreparationDiagnostic {
  return {
    runId: createRunId(),
    sourceStepId: createStepId(),
    stage: "surface_persistence",
    reasonCode: "CONTEXT_SURFACE_PERSISTENCE_FAILED",
    dimension: "SECTION_STATES",
    observed: 2_049,
    limit: 2_048,
    causeKinds: ["PromptSurfaceCapacityError"],
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

describe("Context preparation diagnostics adapter", () => {
  it("shapes one fixed log entry with the measured bound and nothing else", () => {
    const value = contextDiagnostic();

    const entry = toContextPreparationLogEntry(value);

    expect(entry).toEqual({
      event: "run.context.preparation.failure",
      runId: value.runId,
      sourceStepId: value.sourceStepId,
      stage: "surface_persistence",
      reasonCode: "CONTEXT_SURFACE_PERSISTENCE_FAILED",
      dimension: "SECTION_STATES",
      observed: 2_049,
      limit: 2_048,
      causeKinds: ["PromptSurfaceCapacityError"],
    });
    expect(Object.keys(entry)).not.toContain("message");
    expect(Object.keys(entry)).not.toContain("stack");
  });

  it("omits the bound fields a capacity error never measured", () => {
    const entry = toContextPreparationLogEntry(
      contextDiagnostic({
        reasonCode: "CONTEXT_SURFACE_INTEGRITY_FAILED",
        stage: "surface_read",
        dimension: undefined,
        observed: undefined,
        limit: undefined,
      }),
    );

    expect(entry).toEqual({
      event: "run.context.preparation.failure",
      runId: entry.runId,
      sourceStepId: entry.sourceStepId,
      stage: "surface_read",
      reasonCode: "CONTEXT_SURFACE_INTEGRITY_FAILED",
      causeKinds: ["PromptSurfaceCapacityError"],
    });
  });

  it("re-checks the closed vocabulary and degrades an unknown classification", () => {
    const entry = toContextPreparationLogEntry(
      contextDiagnostic({
        stage: "surface_read\nCANARY" as never,
        reasonCode: "CONTEXT_SURFACE_PERSISTENCE_FAILED: C:\\repo\\.env" as never,
        dimension: "DIMENSION CANARY",
      }),
    );

    expect(entry).toMatchObject({
      stage: "unknown",
      reasonCode: "CONTEXT_PREPARATION_FAILED",
    });
    expect(JSON.stringify(entry)).not.toContain("CANARY");
    expect(JSON.stringify(entry)).not.toContain("repo");
  });

  it("records through the host logger when one is configured", () => {
    const contextPreparationFailure = vi.fn();
    const port = createRunFailureDiagnostics({ logger: { contextPreparationFailure } });
    const value = contextDiagnostic();

    port.recordContextPreparationFailure?.(value);

    expect(contextPreparationFailure).toHaveBeenCalledTimes(1);
    expect(contextPreparationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "run.context.preparation.failure",
        reasonCode: "CONTEXT_SURFACE_PERSISTENCE_FAILED",
        observed: 2_049,
      }),
    );
    expect(contextPreparationFailure.mock.calls[0]![0]).not.toBe(value);
  });

  it("does not require a host that only logs Tool failures", () => {
    const port = createRunFailureDiagnostics({ logger: { toolFailure: vi.fn() } });

    expect(() => port.recordContextPreparationFailure?.(contextDiagnostic())).not.toThrow();
  });
});
