import {
  WorkflowCatalogSnapshotRefV1Schema,
  type ModelRef,
  type RunId,
  type SkillSelectionV1,
  type WorkflowCatalogSnapshotRefV1,
  type WorkflowResourceBindingDraftV1,
} from "@caelush/protocol";
import { parseSkillManifest, type SkillBundlePort } from "@caelush/skills";
import type { SkillCatalogService, SkillUserSelectionTarget } from "./catalog-service.js";
import { SkillBundleStoreError } from "./bundle-store.js";
import { SkillServiceError } from "./feature-policy.js";

export const MAX_SKILL_CORE_UTF8_BYTES = 64 * 1024;
export const MAX_ACTIVE_SKILL_CORE_UTF8_BYTES = 256 * 1024;
export const WORKFLOW_RENDERER_VERSION = "workflow-resource@1";

export interface PreparedSkillDisplayMetadata {
  readonly skillId: string;
  readonly name: string;
  readonly displayName?: string;
}

export interface RenderedSkillCoreBudget {
  readonly selectedCount: number;
  readonly coreUtf8Bytes: number;
  readonly tokenEstimate: number;
  readonly maxCoreUtf8Bytes: number;
  readonly maxActiveCoreUtf8Bytes: number;
}

export interface PreparedSelectedSkills {
  readonly workflowProfile: {
    readonly runId: RunId;
    readonly profileVersion: 1;
    readonly workflowRendererVersion: string;
    readonly catalogSnapshotRef: WorkflowCatalogSnapshotRefV1;
  };
  readonly bindingsInSelectionOrder: readonly WorkflowResourceBindingDraftV1[];
  readonly renderedCoreBudget: RenderedSkillCoreBudget;
  readonly selectionDisplaySnapshot: readonly PreparedSkillDisplayMetadata[];
}

export interface SelectedSkillPreparer {
  prepare(input: SelectedSkillPreparationInput): Promise<PreparedSelectedSkills>;
}

export interface SelectedSkillPreparationInput {
  readonly runId: RunId;
  readonly workspaceId: string;
  readonly selections: readonly SkillSelectionV1[];
  readonly model: ModelRef;
  readonly signal: AbortSignal;
}

export interface SelectedSkillPreparerOptions {
  readonly catalog: Pick<SkillCatalogService, "resolveUserSelections">;
  readonly bundleStore: SkillBundlePort;
  readonly captureCatalogSnapshot: (input: {
    readonly runId: RunId;
    readonly workspaceId: string;
    readonly signal: AbortSignal;
  }) => Promise<WorkflowCatalogSnapshotRefV1>;
  readonly maxActiveCoreUtf8Bytes?: number;
}

export function createSelectedSkillPreparer(
  options: SelectedSkillPreparerOptions,
): SelectedSkillPreparer {
  const maxActiveCoreUtf8Bytes = options.maxActiveCoreUtf8Bytes ?? MAX_ACTIVE_SKILL_CORE_UTF8_BYTES;
  if (
    !Number.isSafeInteger(maxActiveCoreUtf8Bytes) ||
    maxActiveCoreUtf8Bytes < 1 ||
    maxActiveCoreUtf8Bytes > 4 * 1024 * 1024
  ) {
    throw new RangeError("The active Skill core budget must be a bounded positive byte count.");
  }

  return Object.freeze({
    async prepare(input: SelectedSkillPreparationInput) {
      const selections = normalizeSelections(input.selections);
      const targets = await resolveTargets(options.catalog, input, selections);
      const catalogSnapshotRef = await captureCatalogSnapshot(options, input);
      if (targets.some((target) => target.catalogRevision !== catalogSnapshotRef.catalogRevision)) {
        throw new SkillServiceError("SKILL_SELECTION_STALE");
      }

      const bindings: WorkflowResourceBindingDraftV1[] = [];
      const displays: PreparedSkillDisplayMetadata[] = [];
      let coreUtf8Bytes = 0;
      let tokenEstimate = 0;
      for (const target of targets) {
        const bundle = await captureBundle(options.bundleStore, {
          workspaceId: input.workspaceId,
          skillId: target.skillId,
          expectedRevision: target.bundleRevision,
          signal: input.signal,
        });
        const core = await readCore(options.bundleStore, bundle, target, input.signal);
        const bytes = new TextEncoder().encode(core).byteLength;
        if (bytes > MAX_SKILL_CORE_UTF8_BYTES) {
          throw new SkillServiceError("SKILL_CORE_BUDGET_EXCEEDED");
        }
        if (coreUtf8Bytes > maxActiveCoreUtf8Bytes - bytes) {
          throw new SkillServiceError("SKILL_CORE_BUDGET_EXCEEDED");
        }
        const estimate = Math.ceil(bytes / 3);
        coreUtf8Bytes += bytes;
        tokenEstimate += estimate;
        bindings.push({
          runId: input.runId,
          resourceKind: "WORKFLOW_INSTRUCTION",
          resourceId: target.skillId,
          resourceRevision: bundle.bundleRevision,
          artifactRef: bundle.artifactRef,
          sourceFingerprint: bundle.manifestFingerprint,
          utf8Bytes: bytes,
          tokenEstimate: estimate,
        });
        displays.push({
          skillId: target.skillId,
          name: target.name,
          ...(target.displayName === undefined ? {} : { displayName: target.displayName }),
        });
      }

      return Object.freeze({
        workflowProfile: Object.freeze({
          runId: input.runId,
          profileVersion: 1 as const,
          workflowRendererVersion: WORKFLOW_RENDERER_VERSION,
          catalogSnapshotRef,
        }),
        bindingsInSelectionOrder: Object.freeze(bindings),
        renderedCoreBudget: Object.freeze({
          selectedCount: bindings.length,
          coreUtf8Bytes,
          tokenEstimate,
          maxCoreUtf8Bytes: MAX_SKILL_CORE_UTF8_BYTES,
          maxActiveCoreUtf8Bytes,
        }),
        selectionDisplaySnapshot: Object.freeze(displays),
      });
    },
  });
}

function normalizeSelections(selections: readonly SkillSelectionV1[]): readonly SkillSelectionV1[] {
  const bySkillId = new Map<string, SkillSelectionV1>();
  for (const selection of selections) {
    const prior = bySkillId.get(selection.skillId);
    if (prior !== undefined) {
      if (prior.selectionToken !== selection.selectionToken) {
        throw new SkillServiceError("SKILL_SELECTION_STALE");
      }
      continue;
    }
    bySkillId.set(selection.skillId, selection);
  }
  return Object.freeze([...bySkillId.values()]);
}

async function resolveTargets(
  catalog: Pick<SkillCatalogService, "resolveUserSelections">,
  input: {
    readonly workspaceId: string;
    readonly signal: AbortSignal;
  },
  selections: readonly SkillSelectionV1[],
): Promise<readonly SkillUserSelectionTarget[]> {
  try {
    return await catalog.resolveUserSelections({
      workspaceId: input.workspaceId,
      selections,
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw new SkillServiceError("SKILLS_UNAVAILABLE");
  }
}

async function captureCatalogSnapshot(
  options: SelectedSkillPreparerOptions,
  input: {
    readonly runId: RunId;
    readonly workspaceId: string;
    readonly signal: AbortSignal;
  },
): Promise<WorkflowCatalogSnapshotRefV1> {
  try {
    return WorkflowCatalogSnapshotRefV1Schema.parse(await options.captureCatalogSnapshot(input));
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw new SkillServiceError("SKILL_LOAD_FAILED");
  }
}

async function captureBundle(
  bundleStore: SkillBundlePort,
  input: {
    readonly workspaceId: string;
    readonly skillId: string;
    readonly expectedRevision: string;
    readonly signal: AbortSignal;
  },
) {
  try {
    return await bundleStore.capture(input);
  } catch (error) {
    throw mapBundleStoreError(error);
  }
}

async function readCore(
  bundleStore: SkillBundlePort,
  bundle: Awaited<ReturnType<SkillBundlePort["capture"]>>,
  target: SkillUserSelectionTarget,
  signal: AbortSignal,
): Promise<string> {
  try {
    const resource = await bundleStore.read({ bundle, relativePath: "SKILL.md", signal });
    if (resource.kind !== "TEXT" || !resource.complete) {
      throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
    }
    const parsed = parseSkillManifest(resource.text);
    if (!parsed.ok || parsed.manifest.name !== target.name) {
      throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
    }
    return parsed.manifest.body;
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw mapBundleStoreError(error);
  }
}

function mapBundleStoreError(error: unknown): SkillServiceError {
  if (!(error instanceof SkillBundleStoreError)) return new SkillServiceError("SKILL_LOAD_FAILED");
  switch (error.code) {
    case "SKILL_NOT_FOUND":
      return new SkillServiceError("SKILL_NOT_FOUND");
    case "SKILL_SELECTION_STALE":
    case "SKILL_SOURCE_CHANGED":
      return new SkillServiceError("SKILL_SELECTION_STALE");
    case "SKILL_ARTIFACT_INVALID":
    case "SKILL_BUNDLE_INVALID":
      return new SkillServiceError("SKILL_ARTIFACT_INVALID");
    case "SKILL_RESOURCE_DENIED":
      return new SkillServiceError("SKILL_RESOURCE_DENIED");
    default:
      return new SkillServiceError("SKILL_LOAD_FAILED");
  }
}
