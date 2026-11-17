import {
  MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS,
  MAX_WORKFLOW_INSTRUCTION_BYTES,
} from "@caelush/agent";
import {
  RunWorkflowExecutionProfileV1Schema,
  WorkflowResourceBindingDraftV1Schema,
  type RunId,
  type ToolInvocationId,
} from "@caelush/protocol";
import {
  InvalidSkillSearchCursorError,
  parseSkillManifest,
  type SkillBundlePort,
  type SkillSearchPage,
} from "@caelush/skills";
import type { RunRepository } from "@caelush/storage";
import { SkillOperationError, type SkillOperations } from "@caelush/coding-agent";

import type { RunSkillCatalogSnapshotService } from "./run-catalog-snapshot.js";
import type { RunSkillModelCatalogService } from "./run-skill-search.js";
import { SkillBundleStoreError } from "./bundle-store.js";
import { normalizeSkillRelativePath, createSkillFileFingerprint } from "./skill-package.js";
import { WORKFLOW_RENDERER_VERSION } from "./selected-skill-preparer.js";

export interface RunSkillOperationsAdapterOptions {
  readonly runs: Pick<RunRepository, "get" | "readWorkflowProfile">;
  readonly snapshots: Pick<RunSkillCatalogSnapshotService, "readRunSkillCatalogSnapshot">;
  readonly bundles: SkillBundlePort;
  readonly modelCatalog: RunSkillModelCatalogService;
  /** Omitted in production until script execution is explicitly ready; test compositions inject it. */
  readonly scriptExecution?: SkillOperations["runScript"] | undefined;
}

const MAX_SINGLE_SKILL_CORE_UTF8_BYTES = 64 * 1024;

/** Bind automatic search and reads to one Run's frozen catalog and immutable bundle references. */
export function createRunSkillOperationsAdapter(
  options: RunSkillOperationsAdapterOptions,
): SkillOperations {
  return Object.freeze({
    async search(input: Parameters<SkillOperations["search"]>[0]): Promise<SkillSearchPage> {
      try {
        return await options.modelCatalog.search({
          runId: input.runId,
          query: input.query,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          pageSize: input.pageSize,
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal.aborted) throw abortReason(input.signal);
        if (error instanceof InvalidSkillSearchCursorError) throw error;
        throw new SkillOperationError("SKILL_SEARCH_UNAVAILABLE");
      }
    },

    async read(input: Parameters<SkillOperations["read"]>[0]) {
      const frozen = await readFrozenCatalog(options, input.runId, input.signal);
      const skill = frozen.snapshot.skills.find((candidate) => candidate.skillId === input.skillId);
      if (skill === undefined) throw new SkillOperationError("SKILL_NOT_FOUND");
      if (!skill.enabled) throw new SkillOperationError("SKILL_DISABLED");
      if (!skill.modelInvocable) throw new SkillOperationError("SKILL_NOT_MODEL_INVOCABLE");

      if (input.resourcePath === undefined && input.cursor !== undefined) {
        throw new SkillOperationError("SKILL_CORE_INVALID");
      }
      if (input.resourcePath === undefined) {
        return readCore(options, {
          runId: input.runId,
          invocationId: input.invocationId,
          skill,
          signal: input.signal,
        });
      }
      if (input.cursor !== undefined) {
        throw new SkillOperationError("SKILL_RESOURCE_INVALID");
      }
      let relativePath: string;
      try {
        relativePath = normalizeSkillRelativePath(input.resourcePath);
      } catch {
        throw new SkillOperationError("SKILL_RESOURCE_DENIED");
      }
      // The core has one non-paged read path. Supplying its path explicitly cannot turn it into a
      // supplemental read or produce a second binding.
      if (relativePath.toLocaleLowerCase("en-US") === "skill.md") {
        throw new SkillOperationError("SKILL_RESOURCE_DENIED");
      }

      let resource;
      try {
        resource = await options.bundles.read({
          bundle: skill.bundle,
          relativePath,
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal.aborted) throw abortReason(input.signal);
        throw mapResourceReadError(error);
      }
      if (input.signal.aborted) throw abortReason(input.signal);
      if (
        !resource.complete ||
        resource.relativePath !== relativePath ||
        !/^sha256:[a-f0-9]{64}$/u.test(resource.fingerprint)
      ) {
        throw new SkillOperationError("SKILL_RESOURCE_INVALID");
      }
      if (
        resource.kind === "TEXT" &&
        createSkillFileFingerprint(new TextEncoder().encode(resource.text)) !== resource.fingerprint
      ) {
        throw new SkillOperationError("SKILL_RESOURCE_INVALID");
      }
      if (
        resource.kind === "BYTES" &&
        createSkillFileFingerprint(resource.bytes) !== resource.fingerprint
      ) {
        throw new SkillOperationError("SKILL_RESOURCE_INVALID");
      }
      return Object.freeze({ kind: "SUPPLEMENTAL_RESOURCE" as const, resource });
    },

    async runScript(
      input: Parameters<SkillOperations["runScript"]>[0],
      evaluationContext: Parameters<SkillOperations["runScript"]>[1],
    ) {
      if (options.scriptExecution === undefined) {
        return Object.freeze({ kind: "UNAVAILABLE" as const });
      }
      return options.scriptExecution(input, evaluationContext);
    },
  });
}

async function readCore(
  options: RunSkillOperationsAdapterOptions,
  input: {
    readonly runId: RunId;
    readonly invocationId: ToolInvocationId;
    readonly skill: Awaited<ReturnType<typeof readFrozenCatalog>>["snapshot"]["skills"][number];
    readonly signal: AbortSignal;
  },
) {
  let resource;
  try {
    resource = await options.bundles.read({
      bundle: input.skill.bundle,
      relativePath: "SKILL.md",
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    throw mapCoreReadError(error);
  }
  if (input.signal.aborted) throw abortReason(input.signal);
  if (
    resource.kind !== "TEXT" ||
    !resource.complete ||
    resource.relativePath !== "SKILL.md" ||
    resource.fingerprint !== input.skill.bundle.manifestFingerprint ||
    createSkillFileFingerprint(new TextEncoder().encode(resource.text)) !==
      input.skill.bundle.manifestFingerprint
  ) {
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }

  const parsed = parseSkillManifest(resource.text);
  if (
    !parsed.ok ||
    parsed.manifest.name !== input.skill.name ||
    parsed.manifest.description !== input.skill.description
  ) {
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  const utf8Bytes = Buffer.byteLength(parsed.manifest.body, "utf8");
  const tokenEstimate = Math.ceil(utf8Bytes / 3);
  if (
    utf8Bytes > MAX_SINGLE_SKILL_CORE_UTF8_BYTES ||
    utf8Bytes > MAX_WORKFLOW_INSTRUCTION_BYTES ||
    tokenEstimate > MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS
  ) {
    throw new SkillOperationError("SKILL_CORE_BUDGET_EXCEEDED");
  }

  const bindingDraft = WorkflowResourceBindingDraftV1Schema.parse({
    runId: input.runId,
    resourceKind: "WORKFLOW_INSTRUCTION",
    resourceId: input.skill.skillId,
    resourceRevision: input.skill.bundle.bundleRevision,
    artifactRef: input.skill.bundle.artifactRef,
    sourceFingerprint: input.skill.bundle.manifestFingerprint,
    utf8Bytes,
    tokenEstimate,
    sourceToolInvocationId: input.invocationId,
  });
  return Object.freeze({ kind: "CORE_CONTENT_READY" as const, bindingDraft });
}

async function readFrozenCatalog(
  options: RunSkillOperationsAdapterOptions,
  runId: RunId,
  signal: AbortSignal,
) {
  if (signal.aborted) throw abortReason(signal);
  if (options.runs.readWorkflowProfile === undefined) {
    throw new SkillOperationError("SKILL_NOT_FOUND");
  }
  const run = await options.runs.get(runId);
  if (run === null) throw new SkillOperationError("SKILL_NOT_FOUND");
  const profile = await options.runs.readWorkflowProfile(runId);
  if (profile === null) throw new SkillOperationError("SKILL_NOT_FOUND");
  let frozenProfile;
  try {
    frozenProfile = RunWorkflowExecutionProfileV1Schema.parse(profile);
  } catch {
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  if (
    frozenProfile.runId !== runId ||
    frozenProfile.workflowRendererVersion !== WORKFLOW_RENDERER_VERSION
  ) {
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  let snapshot;
  try {
    snapshot = await options.snapshots.readRunSkillCatalogSnapshot(
      frozenProfile.catalogSnapshotRef,
    );
  } catch {
    if (signal.aborted) throw abortReason(signal);
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  if (
    snapshot.workspaceId !== run.workspace.id ||
    snapshot.catalogRevision !== frozenProfile.catalogSnapshotRef.catalogRevision ||
    snapshot.artifactRef !== frozenProfile.catalogSnapshotRef.artifactRef ||
    snapshot.manifestFingerprint !== frozenProfile.catalogSnapshotRef.manifestFingerprint ||
    snapshot.complete !== true
  ) {
    throw new SkillOperationError("SKILL_CORE_INVALID");
  }
  if (signal.aborted) throw abortReason(signal);
  return Object.freeze({ profile: frozenProfile, snapshot });
}

function mapCoreReadError(error: unknown): SkillOperationError {
  if (!(error instanceof SkillBundleStoreError)) {
    return new SkillOperationError("SKILL_CORE_INVALID");
  }
  if (error.code === "SKILL_RESOURCE_DENIED" || error.code === "SKILL_NOT_FOUND") {
    return new SkillOperationError("SKILL_NOT_FOUND");
  }
  return new SkillOperationError("SKILL_CORE_INVALID");
}

function mapResourceReadError(error: unknown): SkillOperationError {
  if (error instanceof SkillBundleStoreError && error.code === "SKILL_RESOURCE_DENIED") {
    return new SkillOperationError("SKILL_RESOURCE_DENIED");
  }
  return new SkillOperationError("SKILL_RESOURCE_INVALID");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Skill read was cancelled.", "AbortError");
}
