import {
  SubmissionSkillPreparationV1Schema,
  type RunId,
  type PreparedInputResourceReceiptV1,
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
  getSkillLoadFacts(input: { readonly runId: RunId }): Promise<readonly WorkflowSkillLoadFact[]>;
  getRunSkillPresentationFacts(input: { readonly runId: RunId }): Promise<RunSkillPresentationFacts>;
}

export interface WorkflowSkillLoadFact {
  readonly skillId: string;
  readonly name: string;
  readonly displayName?: string;
  readonly status: "CONTENT_READY" | "LOADED";
}

export interface SkillBindingPresentationFact extends WorkflowSkillLoadFact {
  readonly bindingId: string;
  readonly activationOrdinal: number;
  readonly sourceToolInvocationId?: string;
}

export interface RunSkillPresentationFacts {
  readonly selectedSkills: readonly {
    readonly skillId: string;
    readonly name: string;
    readonly displayName?: string;
  }[];
  readonly catalogSkills: readonly {
    readonly skillId: string;
    readonly name: string;
    readonly displayName?: string;
    readonly modelInvocable: boolean;
  }[];
  readonly bindings: readonly SkillBindingPresentationFact[];
}

interface SubmissionSkillViewOptions {
  readonly runs: Pick<
    RunRepository,
    "get" | "readWorkflowProfile" | "readPreparedResources" | "readPreparedInputReceipts"
  >;
  readonly readCatalogSnapshot: RunSkillCatalogSnapshotService["readRunSkillCatalogSnapshot"];
}

export function createSubmissionSkillViewService(
  options: SubmissionSkillViewOptions,
): SubmissionSkillViewService {
  const getRunSkillPresentationFacts = async ({ runId }: { readonly runId: RunId }) =>
    readRunSkillPresentationFacts(options, runId);
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
    async getSkillLoadFacts({ runId }: { readonly runId: RunId }) {
      const facts = await getRunSkillPresentationFacts({ runId });
      return Object.freeze(
        facts.bindings
          .filter(({ sourceToolInvocationId }) => sourceToolInvocationId === undefined)
          .map(({ skillId, name, displayName, status }) =>
            Object.freeze({
              skillId,
              name,
              ...(displayName === undefined ? {} : { displayName }),
              status,
            }),
          ),
      );
    },
    getRunSkillPresentationFacts,
  });
}

const EMPTY_PRESENTATION_FACTS: RunSkillPresentationFacts = Object.freeze({
  selectedSkills: Object.freeze([]),
  catalogSkills: Object.freeze([]),
  bindings: Object.freeze([]),
});

async function readRunSkillPresentationFacts(
  options: SubmissionSkillViewOptions,
  runId: RunId,
): Promise<RunSkillPresentationFacts> {
  const run = await options.runs.get(runId);
  if (run === null) throw new StorageNotFoundError("AgentRun", runId);
  if (options.runs.readWorkflowProfile === undefined) return EMPTY_PRESENTATION_FACTS;
  const profile = await options.runs.readWorkflowProfile(runId);
  if (profile === null) return EMPTY_PRESENTATION_FACTS;
  const snapshot = await options.readCatalogSnapshot(profile.catalogSnapshotRef);
  if (
    snapshot.workspaceId !== run.workspace.id ||
    snapshot.catalogRevision !== profile.catalogSnapshotRef.catalogRevision
  ) {
    throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
  }
  const [resources, receipts] = await Promise.all([
    readResources(options.runs, runId),
    options.runs.readPreparedInputReceipts?.(runId) ?? Promise.resolve([]),
  ]);
  validateReceipts(runId, profile, resources, receipts);
  const bindings = resources
    .map((binding) => {
      const metadata = selectedDisplayMetadata(binding, snapshot.skills);
      const loaded = receipts.some((receipt) => receipt.bindingId === binding.bindingId);
      return Object.freeze({
        bindingId: binding.bindingId,
        ...metadata,
        activationOrdinal: binding.activationOrdinal,
        ...(binding.sourceToolInvocationId === undefined
          ? {}
          : { sourceToolInvocationId: binding.sourceToolInvocationId }),
        status: loaded ? ("LOADED" as const) : ("CONTENT_READY" as const),
      });
    })
    .sort((left, right) => left.activationOrdinal - right.activationOrdinal);
  return Object.freeze({
    selectedSkills: Object.freeze(
      bindings
        .filter(({ sourceToolInvocationId }) => sourceToolInvocationId === undefined)
        .map(({ skillId, name, displayName }) =>
          Object.freeze({ skillId, name, ...(displayName === undefined ? {} : { displayName }) }),
        ),
    ),
    catalogSkills: Object.freeze(
      snapshot.skills.map((skill) =>
        Object.freeze({
          skillId: skill.skillId,
          name: skill.name,
          ...(skill.displayName === undefined ? {} : { displayName: skill.displayName }),
          modelInvocable: skill.modelInvocable,
        }),
      ),
    ),
    bindings: Object.freeze(bindings),
  });
}

function validateReceipts(
  runId: RunId,
  profile: RunWorkflowExecutionProfileV1,
  bindings: readonly WorkflowResourceBindingV1[],
  receipts: readonly PreparedInputResourceReceiptV1[],
): void {
  const bindingById = new Map(bindings.map((binding) => [binding.bindingId, binding] as const));
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const binding = bindingById.get(receipt.bindingId);
    if (
      receipt.runId !== runId ||
      binding === undefined ||
      receipt.rendererVersion !== profile.workflowRendererVersion ||
      !/^sha256:[a-f0-9]{64}$/u.test(receipt.projectionFingerprint) ||
      seen.has(`${receipt.stepId}\0${receipt.bindingId}`)
    ) {
      throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
    }
    seen.add(`${receipt.stepId}\0${receipt.bindingId}`);
  }
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
