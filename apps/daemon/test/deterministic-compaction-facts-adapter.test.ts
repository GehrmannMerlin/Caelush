import { describe, expect, it } from "vitest";

import { createRunId, createSessionId } from "@caelush/protocol";
import type { AgentExecutionIdentity, ContextMessageRange } from "@caelush/agent";
import { agentMessageId, conversationTurnId } from "@caelush/agent";
import { createDeterministicCompactionFactsProvider } from "../src/context/deterministic-compaction-facts-adapter.js";

const identity: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "Collect current facts",
};

const sourceRange: ContextMessageRange = {
  runId: identity.runId,
  conversationTurnId: conversationTurnId("cturn_phase_8c_facts_adapter"),
  firstMessageId: agentMessageId("amsg_phase_8c_facts_first"),
  lastMessageId: agentMessageId("amsg_phase_8c_facts_last"),
  firstSequence: 1,
  lastSequence: 4,
};

function storageFixture() {
  return {
    toolInvocations: {
      async listByRun() {
        return [
          {
            id: "toolinv_phase_8c_fact" as never,
            runId: identity.runId,
            stepId: "step_phase_8c" as never,
            toolName: "read_file",
            args: { path: "src/a.ts" },
            riskLevel: "LOW",
            status: "COMPLETED",
            createdAt: 1,
          },
        ];
      },
    },
    observations: {
      async listByRun() {
        return [
          {
            id: "obs_phase_8c_fact" as never,
            runId: identity.runId,
            stepId: "step_phase_8c" as never,
            kind: "TOOL" as const,
            toolInvocationId: "toolinv_phase_8c_fact" as never,
            content: "SECRET RAW OBSERVATION",
            rawArtifactRef: "artifact-secret",
            details: { path: "src/a.ts" },
            isError: false,
            createdAt: 2,
          },
        ];
      },
    },
    runStates: {
      async get() {
        return {
          changedFiles: [{ path: "src/b.ts" }],
          activeProcesses: [{ id: "proc-1", status: "RUNNING", command: "shell command" }],
          errors: [],
        };
      },
    },
    approvals: {
      async listPendingByRun() {
        return [
          {
            id: "approval-1" as never,
            toolInvocationId: "toolinv-approval" as never,
            riskLevel: "HIGH",
          },
        ];
      },
    },
    verification: {
      async getLatestPlan() {
        return {
          id: "plan-1" as never,
          checks: [{ spec: { kind: "TASK", purpose: "ACCEPTANCE" }, status: "FAILED" }],
        };
      },
    },
    resourceGovernance: {
      async get() {
        return {
          mode: "ADAPTIVE",
          resourceGuardState: "NONE",
          agentTurnsConsumed: 2,
          toolOperationsConsumed: 3,
        };
      },
    },
  };
}

describe("Phase 8C Daemon deterministic facts composition", () => {
  it("reads settled repositories and projects bounded facts without raw observation content", async () => {
    const facts = await createDeterministicCompactionFactsProvider({
      storage: storageFixture(),
    }).collect({
      identity,
      sourceRange,
      signal: new AbortController().signal,
    });

    expect(facts.readFiles).toEqual(["src/a.ts"]);
    expect(facts.changedFiles).toEqual(["src/b.ts"]);
    expect(facts.pendingApprovals).toEqual(["approval-1:toolinv-approval:HIGH"]);
    expect(facts.verificationState).toContain("plan=plan-1");
    expect(facts.verificationState).toContain("TASK:FAILED");
    expect(facts.resourceGovernance).toBe("ADAPTIVE:NONE:turns=2:tools=3");
    expect(JSON.stringify(facts)).not.toContain("SECRET RAW OBSERVATION");
    expect(JSON.stringify(facts)).not.toContain("artifact-secret");
  });

  it("fails instead of inventing degraded facts when a durable authority read fails", async () => {
    const storage = storageFixture();
    storage.verification.getLatestPlan = async () => {
      throw new Error("verification storage failed");
    };

    await expect(
      createDeterministicCompactionFactsProvider({ storage }).collect({
        identity,
        sourceRange,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("verification storage failed");
  });
});
