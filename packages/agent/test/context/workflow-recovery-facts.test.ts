import { describe, expect, it } from "vitest";
import { createRunId } from "@caelush/protocol";
import { createDeterministicCheckpointBuilder } from "../../src/context/compaction/deterministic-checkpoint-builder.js";
import { createContextCheckpointEnricher } from "../../src/context/compaction/checkpoint-enricher.js";
import { createDeterministicCompactionFacts } from "../../src/context/compaction/deterministic-compaction-facts.js";
import { createContextMessageRange } from "../../src/context/compaction/context-compaction-contracts.js";
import { fitStructuredCheckpointToBudget } from "../../src/context/compaction/checkpoint-budget.js";

const resource = {
  bindingId: "binding:workflow",
  artifactRef: "skill:fixed-bundle",
  projectionFingerprint: `sha256:${"a".repeat(64)}`,
  rendererVersion: "workflow-resource@1",
  fragmentAnchor: `sha256:${"b".repeat(64)}`,
  utf8Bytes: 32,
  tokenEstimate: 12,
};

const factsInput = {
  readFiles: [],
  changedFiles: [],
  recentErrors: [],
  verificationState: "NOT_RUN",
  activeProcesses: [],
  pendingApprovals: [],
  resourceGovernance: "NONE",
  activeWorkflowResources: [resource],
};

describe("deterministic workflow recovery facts", () => {
  it("retains the fixed reference, projection hash, renderer and fragment anchor", () => {
    const facts = createDeterministicCompactionFacts(factsInput);
    const range = createContextMessageRange({
      runId: createRunId(),
      conversationTurnId: "turn:workflow-recovery" as never,
      firstMessageId: "message:workflow-recovery-first" as never,
      lastMessageId: "message:workflow-recovery-last" as never,
      firstSequence: 1,
      lastSequence: 2,
    });
    const checkpoint = createDeterministicCheckpointBuilder().build({
      goal: "Recover active workflow guidance",
      sourceRange: range,
      facts,
    });

    expect(checkpoint.criticalReferences).toContain(
      `workflow-resource:v1:${JSON.stringify(resource)}`,
    );
    expect(JSON.stringify(checkpoint)).not.toContain("Complete workflow body");
  });

  it("keeps active workflow facts when semantic checkpoint memory is enriched", () => {
    const facts = createDeterministicCompactionFacts(factsInput);
    const range = createContextMessageRange({
      runId: createRunId(),
      conversationTurnId: "turn:workflow-semantic" as never,
      firstMessageId: "message:workflow-semantic-first" as never,
      lastMessageId: "message:workflow-semantic-last" as never,
      firstSequence: 1,
      lastSequence: 2,
    });
    const checkpoint = createContextCheckpointEnricher().enrich({
      identity: { goal: "Recover active workflow guidance" },
      semantic: {
        constraints: [],
        completedWork: [],
        inProgress: [],
        blocked: [],
        importantDiscoveries: [],
        keyDecisions: [],
        criticalReferences: [],
        nextIntent: "continue",
      },
      facts,
      sourceRange: range,
    });

    expect(checkpoint.criticalReferences).toContain(
      `workflow-resource:v1:${JSON.stringify(resource)}`,
    );
  });

  it("does not compact an active workflow reference out of a bounded checkpoint", () => {
    const facts = createDeterministicCompactionFacts(factsInput);
    const checkpoint = createDeterministicCheckpointBuilder().build({
      goal: "Recover active workflow guidance",
      sourceRange: createContextMessageRange({
        runId: createRunId(),
        conversationTurnId: "turn:workflow-budget" as never,
        firstMessageId: "message:workflow-budget-first" as never,
        lastMessageId: "message:workflow-budget-last" as never,
        firstSequence: 1,
        lastSequence: 2,
      }),
      facts,
      previousCheckpoint: {
        version: 1,
        goal: "previous",
        constraints: [],
        completedWork: [],
        inProgress: [],
        blocked: [],
        importantDiscoveries: [],
        keyDecisions: [],
        changedFiles: [],
        readFiles: [],
        recentErrors: [],
        verificationState: "NOT_RUN",
        activeProcesses: [],
        pendingApprovals: [],
        resourceGovernance: "NONE",
        criticalReferences: ["semantic-reference:old-1", "semantic-reference:old-2"],
        nextIntent: "continue",
        sourceRange: { from: 1, to: 1 },
      },
    });
    const fitted = fitStructuredCheckpointToBudget({
      checkpoint,
      maxTokens: 1,
      model: {} as never,
      tokenEstimator: {
        estimateText(text: string) {
          const value = JSON.parse(text) as { criticalReferences: readonly string[] };
          return value.criticalReferences.length;
        },
      } as never,
    });

    expect(fitted.criticalReferences).toEqual([`workflow-resource:v1:${JSON.stringify(resource)}`]);
  });
});
