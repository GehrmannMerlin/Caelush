import {
  SubmissionSkillPreparationV1Schema,
  type RunId,
  type SubmissionSkillPreparationV1,
  type WorkflowResourceBindingV1,
  type RunWorkflowExecutionProfileV1,
} from "@caelush/protocol";
import { StorageNotFoundError, type RunRepository } from "@caelush/storage";
import type {
  RunSkillCatalogSnapshot,
  RunSkillCatalogSnapshotService,
} from "./run-catalog-snapshot.js";
import { SkillServiceError } from "./feature-policy.js";

export interface SubmissionSkillViewService {
  getSubmissionSkillPreparation(input: {
    readonly runId: RunId;
  }): Promise<SubmissionSkillPreparationV1>;
}

export function createSubmissionSkillViewService(options: {
  readonly runs: Pick<RunRepository, "get" | "readWorkflowProfile" | "readPreparedResources">;
  readonly readCatalogSnapshot: RunSkillCatalogSnapshotService["readRunSkillCatalogSnapshot"];
}): SubmissionSkillViewService {
  return Object.freeze({
    async getSubmissionSkillPreparation({ runId }: { readonly runId: RunId }) {
      const run = await options.runs.get(runId);
      if (run === null) throw new StorageNotFoundError("AgentRun", runId);
      const profile = await requireWorkflowProfile(options.runs, runId);
      const snapshot = await options.readCatalogSnapshot(profile.catalogSnapshotRef);
      if (
        snapshot.workspaceId !== run.workspace.id ||
        snapshot.catalogRevision !== profile.catalogSnapshotRef.catalogRevision
      ) {
        throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
      }
      const resources = await readResources(options.runs, runId);
      const selectedSkills = resources
        .filter(({ sourceToolInvocationId }) => sourceToolInvocationId === undefined)
        .map((binding) => selectedDisplayMetadata(binding, snapshot.skills));
      return SubmissionSkillPreparationV1Schema.parse({
        schemaVersion: 1,
        runId,
        userText: run.userText ?? run.goal,
        preparationStatus: "CONTENT_READY",
        selectedSkills,
      });
    },
  });
}

async function requireWorkflowProfile(
  runs: Pick<RunRepository, "readWorkflowProfile">,
  runId: RunId,
): Promise<RunWorkflowExecutionProfileV1> {
  if (runs.readWorkflowProfile === undefined) throw new SkillServiceError("SKILLS_UNAVAILABLE");
  const profile = await runs.readWorkflowProfile(runId);
  if (profile === null) throw new StorageNotFoundError("Skill preparation", runId);
  return profile;
}

async function readResources(
  runs: Pick<RunRepository, "readPreparedResources">,
  runId: RunId,
): Promise<readonly WorkflowResourceBindingV1[]> {
  if (runs.readPreparedResources === undefined) throw new SkillServiceError("SKILLS_UNAVAILABLE");
  return runs.readPreparedResources(runId);
}

function selectedDisplayMetadata(
  binding: WorkflowResourceBindingV1,
  skills: RunSkillCatalogSnapshot["skills"],
) {
  const skill = skills.find(
    (candidate) =>
      candidate.skillId === binding.resourceId &&
      candidate.bundle.bundleRevision === binding.resourceRevision &&
      candidate.bundle.manifestFingerprint === binding.sourceFingerprint,
  );
  if (skill === undefined) throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
  return {
    skillId: skill.skillId,
    name: skill.name,
    ...(skill.displayName === undefined ? {} : { displayName: skill.displayName }),
  };
}
