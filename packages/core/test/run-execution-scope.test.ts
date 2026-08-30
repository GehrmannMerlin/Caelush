import { createRunId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { RunExecutionScopeRegistry } from "../src/run-execution-scope.js";

describe("RunExecutionScopeRegistry", () => {
  it("owns one abortable scope per Run and settles it", async () => {
    const registry = new RunExecutionScopeRegistry();
    const runId = createRunId();
    const scope = registry.open(runId);

    expect(registry.get(runId)).toBe(scope);
    expect(scope.signal.aborted).toBe(false);
    expect(() => registry.open(runId)).toThrow();

    expect(registry.abort(runId)).toBe(true);
    expect(scope.signal.aborted).toBe(true);
    scope.settle();
    await expect(scope.settled).resolves.toBeUndefined();

    registry.close(runId, scope);
    expect(registry.get(runId)).toBeUndefined();
  });
});
