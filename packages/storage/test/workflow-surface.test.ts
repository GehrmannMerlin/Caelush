import { afterEach, describe, expect, it } from "vitest";

import {
  createPromptSurfaceAnchor,
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceRecord,
  createPromptSurfaceSectionStates,
  diffPromptSurfaceSections,
  projectPromptSurface,
  renderWorkflowInstructionFragment,
  WORKFLOW_INSTRUCTION_RENDERER_VERSION,
} from "@caelush/agent";
import { createTimestampMs, type RunId } from "@caelush/protocol";
import { StorageError, openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { makeRun, makeSession } from "./support/fixtures.js";

const stores: CaelushStorage[] = [];

afterEach(async () => {
  for (const storage of stores.splice(0)) await storage.close();
});

async function setup() {
  const storage = await openCaelushStorage({ path: ":memory:" });
  stores.push(storage);
  const session = makeSession();
  const run = makeRun(session.id);
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  return { storage, run };
}

function epoch(runId: RunId, formatVersion: 3 | 4) {
  return createPromptSurfaceEpoch({
    runId,
    epochId: createPromptSurfaceEpochId(`workflow-surface-${formatVersion}`),
    formatVersion,
    modelRef: { provider: "test", model: "workflow-surface" },
    stableHeadFingerprint: `sha256:${"1".repeat(64)}`,
    toolSchemaFingerprint: `sha256:${"2".repeat(64)}`,
    cacheSettingsFingerprint: `sha256:${"3".repeat(64)}`,
    resetReason: "INITIAL",
    createdStepSequence: 1,
    createdAt: createTimestampMs(1),
  });
}

function workflowState(runId: RunId) {
  const binding = {
    runId,
    resourceKind: "WORKFLOW_INSTRUCTION" as const,
    resourceId: "skill-review",
    resourceRevision: "bundle-r1",
    artifactRef: "skillbundle:review-r1",
    sourceFingerprint: "sha256:source-review-r1",
    utf8Bytes: Buffer.byteLength("Check each generated patch.\nPreserve ]]> exactly.", "utf8"),
    tokenEstimate: 20,
    bindingId: "workflow-binding-review",
    activationOrdinal: 1,
  };
  const fragment = renderWorkflowInstructionFragment({
    binding,
    body: "Check each generated patch.\nPreserve ]]> exactly.",
  });
  const states = createPromptSurfaceSectionStates({
    sections: [
      {
        id: "agent.workflow-instruction:workflow-binding-review",
        authority: "WORKFLOW_INSTRUCTION",
        sourceRef: "agent.workflow-instructions@workflow-resource@1:skillbundle:review-r1",
        cacheStability: "DYNAMIC",
        priorityClass: "CRITICAL",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        text: fragment.text,
      },
    ],
  });
  return { states, fragment };
}

describe("Prompt Surface V4 workflow projection", () => {
  it("persists an anchored workflow fragment and its stable hash in the authoritative V4 record", async () => {
    const { storage, run } = await setup();
    const next = epoch(run.id, 4);
    const { states, fragment } = workflowState(run.id);
    const diff = diffPromptSurfaceSections([], states, true);
    const record = createPromptSurfaceRecord({
      runId: run.id,
      epochId: next.epochId,
      ordinal: 1,
      anchor: createPromptSurfaceAnchor({
        messageId: "amsg_workflow_surface_anchor" as never,
        runId: run.id,
        conversationTurnId: "cturn_workflow_surface_anchor" as never,
        sequence: 1,
      }),
      sourceStepSequence: 1,
      kind: "BASELINE",
      updates: diff.updates,
      decisionFingerprint: "a".repeat(64),
      createdAt: createTimestampMs(2),
    });

    await storage.promptSurface.createEpoch(next);
    await expect(storage.promptSurface.appendRecord(record, next, 0)).resolves.toBe("APPENDED");

    const persisted = await storage.promptSurface.readEpoch(run.id, next.epochId);
    expect(persisted).toMatchObject({
      formatVersion: 4,
      records: [{ anchor: { messageId: "amsg_workflow_surface_anchor" } }],
      sectionStates: [{ stateKey: states[0]?.stateKey, contentHash: states[0]?.contentHash }],
    });
    expect(projectPromptSurface(persisted)[0]?.content).toContain(fragment.text);
    expect(projectPromptSurface(persisted)[0]?.content).toContain(
      `renderer_version="${WORKFLOW_INSTRUCTION_RENDERER_VERSION}"`,
    );
    expect(persisted?.sectionStates?.[0]?.contentHash).toBe(states[0]?.contentHash);
  });

  it("rejects workflow instruction writes into Prompt Surface V3 without leaving a record", async () => {
    const { storage, run } = await setup();
    const legacy = epoch(run.id, 3);
    const { states } = workflowState(run.id);
    const diff = diffPromptSurfaceSections([], states, true);
    const record = createPromptSurfaceRecord({
      runId: run.id,
      epochId: legacy.epochId,
      ordinal: 1,
      anchor: createPromptSurfaceAnchor({
        messageId: "amsg_workflow_surface_legacy" as never,
        runId: run.id,
        conversationTurnId: "cturn_workflow_surface_legacy" as never,
        sequence: 1,
      }),
      sourceStepSequence: 1,
      kind: "BASELINE",
      updates: diff.updates,
      decisionFingerprint: "b".repeat(64),
      createdAt: createTimestampMs(2),
    });
    await storage.promptSurface.createEpoch(legacy);

    await expect(storage.promptSurface.appendRecord(record, legacy, 0)).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(storage.promptSurface.readEpoch(run.id, legacy.epochId)).resolves.toMatchObject({
      records: [],
      sectionStates: [],
    });
  });
});
