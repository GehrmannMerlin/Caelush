import {
  createRunId,
  createSessionId,
  createWorkspaceId,
  type PreparedInputResourceReceiptV1,
  type RunWorkflowExecutionProfileV1,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createSubmissionSkillViewService,
  type SubmissionSkillViewService,
} from "../src/skills/submission-skill-view.js";

const HASH = `sha256:${"c".repeat(64)}`;

describe("Skill loaded facts", () => {
  it("keeps HTTP preparation CONTENT_READY and derives LOADED only from a matching Step receipt", async () => {
    const runId = createRunId();
    const sessionId = createSessionId();
    const workspaceId = createWorkspaceId();
    const artifactRef = "bundle_review_helper_revision_1";
    const binding: WorkflowResourceBindingV1 = {
      runId,
      bindingId: "binding_review_helper",
      resourceKind: "WORKFLOW_INSTRUCTION",
      resourceId: "skill_review_helper",
      resourceRevision: "revision-1",
      artifactRef,
      sourceFingerprint: HASH,
      utf8Bytes: 256,
      tokenEstimate: 85,
      activationOrdinal: 0,
    };
    const profile: RunWorkflowExecutionProfileV1 = {
      runId,
      profileVersion: 1,
      workflowRendererVersion: "workflow-resource@1",
      catalogSnapshotRef: {
        catalogRevision: "catalog-revision-1",
        artifactRef: "catalog_review_helper_snapshot",
        manifestFingerprint: HASH,
      },
    };
    let receipts: readonly PreparedInputResourceReceiptV1[] = [];
    const view = createSubmissionSkillViewService({
      runs: {
        get: async () =>
          ({
            id: runId,
            sessionId,
            goal: "review",
            userText: "review this",
            status: "RUNNING",
            workspace: { id: workspaceId, path: "/workspace" },
          }) as never,
        readWorkflowProfile: async () => profile,
        readPreparedResources: async () => [binding],
        readPreparedInputReceipts: async () => receipts,
      } as never,
      readCatalogSnapshot: async () =>
        ({
          schemaVersion: 1,
          workspaceId,
          catalogRevision: profile.catalogSnapshotRef.catalogRevision,
          complete: true,
          artifactRef: profile.catalogSnapshotRef.artifactRef,
          manifestFingerprint: profile.catalogSnapshotRef.manifestFingerprint,
          skills: [
            {
              skillId: binding.resourceId,
              name: "review-helper",
              description: "Review changes",
              enabled: true,
              userInvocable: true,
              modelInvocable: false,
              bundle: {
                bundleRevision: binding.resourceRevision,
                artifactRef,
                manifestFingerprint: binding.sourceFingerprint,
              },
            },
          ],
        }) as never,
    });

    const readFacts = (
      view as SubmissionSkillViewService & {
        getSkillLoadFacts?: (input: {
          readonly runId: typeof runId;
        }) => Promise<readonly unknown[]>;
      }
    ).getSkillLoadFacts;
    expect(readFacts).toBeTypeOf("function");
    if (readFacts === undefined) return;

    const contentReady = await view.getSubmissionSkillPreparation({ runId });
    expect(contentReady.preparationStatus).toBe("CONTENT_READY");
    expect(await readFacts({ runId })).toEqual([
      { skillId: binding.resourceId, name: "review-helper", status: "CONTENT_READY" },
    ]);

    receipts = [
      {
        runId,
        stepId: "stp_0195f3a0-0000-7000-8000-000000000001" as never,
        bindingId: binding.bindingId,
        projectionFingerprint: HASH,
        rendererVersion: profile.workflowRendererVersion,
      },
    ];
    expect(await readFacts({ runId })).toEqual([
      { skillId: binding.resourceId, name: "review-helper", status: "LOADED" },
    ]);
    expect((await view.getSubmissionSkillPreparation({ runId })).preparationStatus).toBe(
      "CONTENT_READY",
    );

    receipts = [{ ...receipts[0]!, runId: createRunId() }];
    await expect(readFacts({ runId })).rejects.toThrow();
  });
});
