import { createRunId, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ToolFailureMemory } from "../src/index.js";

describe("ToolFailureMemory", () => {
  it("matches canonicalized arguments and does not retain raw arguments", () => {
    const memory = new ToolFailureMemory({ ttlMs: 1_000 });
    const runId = createRunId();

    memory.record({
      runId,
      toolName: "exec_command",
      args: { command: "npm test", timeout_ms: 3_000 },
      failureCode: "TOOL_EXECUTION_ERROR",
      now: createTimestampMs(100),
    });

    expect(
      memory.has({
        runId,
        toolName: "exec_command",
        args: { timeout_ms: 3_000, command: "npm test" },
        failureCode: "TOOL_EXECUTION_ERROR",
        now: createTimestampMs(500),
      }),
    ).toBe(true);
    expect(JSON.stringify(memory.entries(runId))).not.toContain("npm test");
    expect(memory.entries(runId)[0]).toMatchObject({
      toolName: "exec_command",
      argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      count: 1,
    });
  });

  it("expires old failures, separates failure reasons, and bounds entries per run", () => {
    const memory = new ToolFailureMemory({ ttlMs: 100, maxEntriesPerRun: 2 });
    const runId = createRunId();
    const base = {
      runId,
      toolName: "read_file" as const,
      failureCode: "TOOL_EXECUTION_ERROR",
    };

    memory.record({ ...base, args: { path: "a.txt" }, now: createTimestampMs(100) });
    memory.record({ ...base, args: { path: "a.txt" }, now: createTimestampMs(110) });
    memory.record({ ...base, args: { path: "b.txt" }, now: createTimestampMs(120) });
    memory.record({ ...base, args: { path: "c.txt" }, now: createTimestampMs(130) });

    expect(memory.entries(runId)).toHaveLength(2);
    expect(memory.has({ ...base, args: { path: "a.txt" }, now: createTimestampMs(130) })).toBe(
      false,
    );
    expect(memory.has({ ...base, args: { path: "c.txt" }, now: createTimestampMs(130) })).toBe(
      true,
    );
    expect(
      memory.has({
        ...base,
        args: { path: "c.txt" },
        failureCode: "TOOL_ARGUMENT_ERROR",
        now: createTimestampMs(130),
      }),
    ).toBe(false);
    expect(memory.has({ ...base, args: { path: "c.txt" }, now: createTimestampMs(231) })).toBe(
      false,
    );
  });
});
