import {
  RunWorkflowExecutionProfileV1Schema,
  WorkflowResourceBindingV1Schema,
  type RunId,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";
import { parseSkillManifest, type SkillBundlePort } from "@caelush/skills";
import type { RunRepository } from "@caelush/storage";
import type { RunSkillCatalogSnapshotService } from "./run-catalog-snapshot.js";
import { WORKFLOW_RENDERER_VERSION } from "./selected-skill-preparer.js";
import type { ActiveWorkflowResource, ActiveWorkflowResourceReader } from "@caelush/agent";

export interface WorkflowResourceReaderOptions {
  readonly runs: Pick<RunRepository, "get" | "readWorkflowProfile" | "readPreparedResources">;
  readonly snapshots: Pick<RunSkillCatalogSnapshotService, "readRunSkillCatalogSnapshot">;
  readonly bundles: SkillBundlePort;
}

/** Read the exact Run-bound catalog and bundle artifacts used during preparation. */
export function createWorkflowResourceReader(
  options: WorkflowResourceReaderOptions,
): ActiveWorkflowResourceReader {
  return Object.freeze({
    async load(
      input: Parameters<ActiveWorkflowResourceReader["load"]>[0],
    ): Promise<readonly ActiveWorkflowResource[]> {
      const run = await options.runs.get(input.runId);
      if (run === null || input.signal.aborted)
        throw new TypeError("Workflow Run binding is unavailable.");
      if (
        options.runs.readPreparedResources === undefined ||
        options.runs.readWorkflowProfile === undefined
      ) {
        throw new TypeError("Workflow resource persistence is unavailable.");
      }
      const [profile, storedBindings] = await Promise.all([
        options.runs.readWorkflowProfile(input.runId),
        options.runs.readPreparedResources(input.runId),
      ]);
      if (profile === null) {
        if (storedBindings.length > 0)
          throw new TypeError("Workflow profile is missing for bound resources.");
        return Object.freeze([]);
      }
      const frozenProfile = RunWorkflowExecutionProfileV1Schema.parse(profile);
      if (
        frozenProfile.runId !== input.runId ||
        frozenProfile.workflowRendererVersion !== WORKFLOW_RENDERER_VERSION
      ) {
        throw new TypeError("Workflow profile identity or renderer is unsupported.");
      }
      const bindings = storedBindings.map((binding) =>
        WorkflowResourceBindingV1Schema.parse(binding),
      );
      if (bindings.some((binding) => binding.runId !== input.runId)) {
        throw new TypeError("Workflow resource belongs to another Run.");
      }
      if (bindings.length === 0) return Object.freeze([]);

      const snapshot = await options.snapshots.readRunSkillCatalogSnapshot(
        frozenProfile.catalogSnapshotRef,
      );
      if (
        snapshot.workspaceId !== run.workspace.id ||
        snapshot.catalogRevision !== frozenProfile.catalogSnapshotRef.catalogRevision ||
        snapshot.complete !== true
      ) {
        throw new TypeError("Run Skill catalog snapshot binding is invalid.");
      }

      const active: ActiveWorkflowResource[] = [];
      for (const binding of bindings) {
        if (input.signal.aborted)
          throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
        const skill = snapshot.skills.find((candidate) => candidate.skillId === binding.resourceId);
        if (
          skill === undefined ||
          skill.bundle.bundleRevision !== binding.resourceRevision ||
          skill.bundle.artifactRef !== binding.artifactRef ||
          skill.bundle.manifestFingerprint !== binding.sourceFingerprint
        ) {
          throw new TypeError("Run workflow binding does not match its fixed catalog snapshot.");
        }
        const resource = await options.bundles.read({
          bundle: skill.bundle,
          relativePath: "SKILL.md",
          signal: input.signal,
        });
        if (
          resource.kind !== "TEXT" ||
          !resource.complete ||
          resource.relativePath !== "SKILL.md" ||
          resource.fingerprint !== binding.sourceFingerprint
        ) {
          throw new TypeError(
            "Run workflow core artifact failed its fixed reference integrity check.",
          );
        }
        const manifest = parseSkillManifest(resource.text);
        if (
          !manifest.ok ||
          manifest.manifest.name !== skill.name ||
          Buffer.byteLength(manifest.manifest.body, "utf8") !== binding.utf8Bytes ||
          Math.ceil(binding.utf8Bytes / 3) !== binding.tokenEstimate
        ) {
          throw new TypeError("Run workflow core artifact does not match its durable binding.");
        }
        active.push(
          Object.freeze({
            binding,
            rendererVersion: frozenProfile.workflowRendererVersion,
            body: manifest.manifest.body,
          }),
        );
      }
      return Object.freeze(active);
    },
  });
}

export type { RunId, WorkflowResourceBindingV1 };
