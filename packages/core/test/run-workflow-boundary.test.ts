import { createRunId, createSessionId, createStepId, createTimestampMs } from "@caelush/protocol";
import type { PreparedWorkflowResourceRefV1 } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createAgentModelTurnBoundary,
  createAgentTurnObservation,
  type PendingAgentTurn,
} from "../src/run-model-turn-boundary.js";

const HASH = `sha256:${"b".repeat(64)}`;

describe("Run workflow input boundary", () => {
  it("passes only prepared resource references and the actual tool catalog fingerprint to Step commit", async () => {
    const runId = createRunId();
    const sessionId = createSessionId();
    const stepId = createStepId();
    const resource: PreparedWorkflowResourceRefV1 = {
      bindingId: "binding_review_helper",
      artifactRef: "bundle_review_helper_revision_1",
      projectionFingerprint: HASH,
      rendererVersion: "workflow-resource@1",
      fragmentAnchor: HASH,
      utf8Bytes: 256,
      tokenEstimate: 86,
    };
    const pending: PendingAgentTurn = {
      identity: { runId, sessionId, goal: "review the change" },
      model: { provider: "fixture", model: "fixture-model" },
      step: {
        id: stepId,
        runId,
        sequence: 1,
        status: "RUNNING",
        startedAt: createTimestampMs(100),
      },
      advanceReason: "INITIAL",
      expectedStateRevision: null,
      expectedContinuationRevision: null,
    };
    let committedSelection: unknown;
    const observation = createAgentTurnObservation();
    const boundary = createAgentModelTurnBoundary({
      observation,
      pendingTurn: () => pending,
      openTurn: async (_turn, selection) => {
        committedSelection = selection;
      },
    });

    await boundary.beforeExecute({
      identity: pending.identity,
      turn: { stepId, sequence: 1 },
      model: pending.model,
      preparedResourceRefs: [resource],
      toolCatalogFingerprint: HASH,
    } as never);

    expect(committedSelection).toEqual({
      preparedResourceRefs: [resource],
      toolCatalogFingerprint: HASH,
    });
    expect(JSON.stringify(committedSelection)).not.toContain("core body");
    expect(observation.boundaryCommitted).toBe(true);
  });

  it("does not report a prepared boundary after the authoritative Step commit rejects", async () => {
    const runId = createRunId();
    const sessionId = createSessionId();
    const stepId = createStepId();
    const pending: PendingAgentTurn = {
      identity: { runId, sessionId, goal: "review the change" },
      model: { provider: "fixture", model: "fixture-model" },
      step: {
        id: stepId,
        runId,
        sequence: 1,
        status: "RUNNING",
        startedAt: createTimestampMs(100),
      },
      advanceReason: "INITIAL",
      expectedStateRevision: null,
      expectedContinuationRevision: null,
    };
    const observation = createAgentTurnObservation();
    const boundary = createAgentModelTurnBoundary({
      observation,
      pendingTurn: () => pending,
      openTurn: () => Promise.reject(new Error("injected Step commit failure")),
    });

    await expect(
      boundary.beforeExecute({
        identity: pending.identity,
        turn: { stepId, sequence: 1 },
        model: pending.model,
        preparedResourceRefs: [],
        toolCatalogFingerprint: HASH,
      } as never),
    ).rejects.toThrow("injected Step commit failure");
    expect(observation.boundaryCommitted).toBe(false);
    expect(observation.boundaryError).toBeInstanceOf(Error);
  });
});
