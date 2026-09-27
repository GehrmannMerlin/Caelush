import { describe, expect, it } from "vitest";

import { projectCodingCompactionFacts } from "@caelush/coding-agent";
import { createTimestampMs } from "@caelush/protocol";
import type { AgentState, Observation, ToolInvocation } from "@caelush/protocol";

function invocation(input: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    id: "toolinv_phase_8c" as ToolInvocation["id"],
    runId: "run_phase_8c" as ToolInvocation["runId"],
    stepId: "step_phase_8c" as ToolInvocation["stepId"],
    toolName: "read_file",
    args: { path: "src/a.ts" },
    riskLevel: "LOW",
    status: "COMPLETED",
    createdAt: createTimestampMs(1),
    ...input,
  };
}

function observation(input: Partial<Extract<Observation, { kind: "TOOL" }>> = {}) {
  return {
    id: "obs_phase_8c" as Extract<Observation, { kind: "TOOL" }>["id"],
    runId: "run_phase_8c" as Extract<Observation, { kind: "TOOL" }>["runId"],
    stepId: "step_phase_8c" as Extract<Observation, { kind: "TOOL" }>["stepId"],
    kind: "TOOL" as const,
    toolInvocationId: "toolinv_phase_8c" as Extract<
      Observation,
      { kind: "TOOL" }
    >["toolInvocationId"],
    content: "SECRET RAW FILE CONTENT",
    rawArtifactRef: "artifact-secret",
    details: { path: "src/a.ts" },
    isError: false,
    createdAt: createTimestampMs(2),
    ...input,
  } as Extract<Observation, { kind: "TOOL" }>;
}

const state = {
  changedFiles: [
    { path: "src/b.ts", changeType: "MODIFIED" },
    { path: "src/a.ts", changeType: "CREATED" },
  ],
  activeProcesses: [{ id: "proc-1", status: "RUNNING", command: "rm -rf secret" }],
  errors: [
    {
      code: "COMMAND_FAILED",
      message: "password=super-secret details=do-not-copy",
      retryable: false,
      phase: "TOOL",
    },
  ],
} as unknown as AgentState;

describe("Phase 8C Coding deterministic compaction facts", () => {
  it("counts only completed successful read_file observations and projects durable state", () => {
    const facts = projectCodingCompactionFacts({
      invocations: [invocation()],
      observations: [observation()],
      state,
    });

    expect(facts.readFiles).toEqual(["src/a.ts"]);
    expect(facts.changedFiles).toEqual(["src/b.ts", "src/a.ts"]);
    expect(facts.activeProcesses).toEqual(["proc-1:RUNNING:shell command"]);
    expect(facts.recentErrors[0]).toContain("TOOL:COMMAND_FAILED:");
    expect(facts.recentErrors[0]).not.toContain("super-secret");
    expect(facts.recentErrors[0]).not.toContain("do-not-copy");
    expect(facts.activeProcesses[0]).not.toContain("rm -rf secret");
    expect(facts).not.toHaveProperty("content");
    expect(facts).not.toHaveProperty("rawArtifactRef");
  });

  it("omits failed invocations and error observations from readFiles", () => {
    const facts = projectCodingCompactionFacts({
      invocations: [invocation({ status: "FAILED" })],
      observations: [observation({ isError: true })],
      state: null,
    });

    expect(facts.readFiles).toEqual([]);
  });
});
