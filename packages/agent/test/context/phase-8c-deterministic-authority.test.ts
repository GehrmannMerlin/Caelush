import { describe, expect, it } from "vitest";
import { createRunId } from "@caelush/protocol";

import {
  createContextCheckpointEnricher,
  createContextMessageRange,
  createDeterministicCheckpointBuilder,
  createDeterministicCompactionFacts,
  createSemanticCheckpointDraft,
  type DeterministicCompactionFacts,
  type StructuredCheckpoint,
} from "@caelush/agent";
import { agentMessageId, conversationTurnId } from "@caelush/agent";

const sourceRange = createContextMessageRange({
  runId: createRunId(),
  conversationTurnId: conversationTurnId("cturn_phase_8c_facts"),
  firstMessageId: agentMessageId("amsg_phase_8c_facts_first"),
  lastMessageId: agentMessageId("amsg_phase_8c_facts_last"),
  firstSequence: 1,
  lastSequence: 160,
});

const facts: DeterministicCompactionFacts = createDeterministicCompactionFacts({
  readFiles: ["src/a.ts"],
  changedFiles: ["src/new.ts"],
  recentErrors: ["TOOL:COMMAND_FAILED:bounded"],
  verificationState: "FAILED",
  activeProcesses: ["process-1:RUNNING:shell command"],
  pendingApprovals: ["approval-1"],
  resourceGovernance: "ADAPTIVE:NONE",
});

const semantic = createSemanticCheckpointDraft({
  goal: "Current goal",
  constraints: [],
  completedWork: ["semantic work"],
  inProgress: [],
  blocked: ["verification is PASSED"],
  importantDiscoveries: [],
  keyDecisions: ["Verification passed and all approvals are resolved."],
  criticalReferences: [],
  nextIntent: "Continue",
});

function previousCheckpoint(): StructuredCheckpoint {
  return {
    version: 1,
    goal: "old goal",
    constraints: [],
    completedWork: [],
    inProgress: [],
    blocked: [],
    importantDiscoveries: [],
    keyDecisions: [],
    changedFiles: ["old.ts"],
    readFiles: ["old.ts"],
    recentErrors: [],
    verificationState: "OLD_PASS",
    activeProcesses: [],
    pendingApprovals: [],
    resourceGovernance: "OLD",
    criticalReferences: [],
    nextIntent: "old next",
    sourceRange: { from: 1, to: 100 },
  };
}

describe("Phase 8C deterministic checkpoint authority", () => {
  it("enriches semantic memory with facts and never accepts semantic authority claims", () => {
    const checkpoint = createContextCheckpointEnricher().enrich({
      semantic,
      facts,
      sourceRange,
    });

    expect(checkpoint.keyDecisions).toContain(
      "Verification passed and all approvals are resolved.",
    );
    expect(checkpoint.verificationState).toBe("FAILED");
    expect(checkpoint.pendingApprovals).toEqual(["approval-1"]);
    expect(checkpoint.changedFiles).toEqual(["src/new.ts"]);
    expect(checkpoint.sourceRange).toEqual({ from: 1, to: 160 });
    expect(Object.isFrozen(checkpoint)).toBe(true);
  });

  it("builds degraded fallback memory while replacing every stale previous authority field", () => {
    const checkpoint = createDeterministicCheckpointBuilder().build({
      goal: "Current goal",
      sourceRange,
      facts,
      previousCheckpoint: previousCheckpoint(),
    });

    expect(checkpoint.goal).toBe("Current goal");
    expect(checkpoint.completedWork).toEqual([]);
    expect(checkpoint.changedFiles).toEqual(["src/new.ts"]);
    expect(checkpoint.readFiles).toEqual(["src/a.ts"]);
    expect(checkpoint.verificationState).toBe("FAILED");
    expect(checkpoint.pendingApprovals).toEqual(["approval-1"]);
    expect(checkpoint.blocked).toContain(
      "Semantic summarization was unavailable; continue from deterministic durable state.",
    );
    expect(checkpoint.sourceRange).toEqual({ from: 1, to: 160 });
  });

  it("rejects unbounded facts instead of letting a checkpoint exceed its safe boundary", () => {
    expect(() =>
      createDeterministicCompactionFacts({
        ...facts,
        recentErrors: Array.from({ length: 1000 }, () => "error"),
      }),
    ).toThrow(/bound|size|limit/i);
  });
});
