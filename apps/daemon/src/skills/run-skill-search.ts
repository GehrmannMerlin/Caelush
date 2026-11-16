import { RunWorkflowExecutionProfileV1Schema, type RunId } from "@caelush/protocol";
import { searchSkillCatalog, type SkillSearchCatalog, type SkillSearchPage } from "@caelush/skills";
import type { RunRepository } from "@caelush/storage";
import type { RunSkillCatalogSnapshotService } from "./run-catalog-snapshot.js";

const EMPTY_CATALOG: SkillSearchCatalog = Object.freeze({
  revision: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  entries: Object.freeze([]),
  diagnostics: Object.freeze([]),
  complete: true,
});

export interface RunSkillModelCatalogService {
  list(input: { readonly runId: RunId; readonly signal: AbortSignal }): Promise<SkillSearchCatalog>;
  search(input: {
    readonly runId: RunId;
    readonly query: string;
    readonly cursor?: string;
    readonly pageSize?: number;
    readonly signal: AbortSignal;
  }): Promise<SkillSearchPage>;
}

export interface RunSkillModelCatalogServiceOptions {
  readonly runs: Pick<RunRepository, "get" | "readWorkflowProfile">;
  readonly snapshots: Pick<RunSkillCatalogSnapshotService, "readRunSkillCatalogSnapshot">;
}

export function createRunSkillModelCatalogService(
  options: RunSkillModelCatalogServiceOptions,
): RunSkillModelCatalogService {
  return Object.freeze({
    list: async (input: Parameters<RunSkillModelCatalogService["list"]>[0]) =>
      readCatalog(options, input),
    async search(input: Parameters<RunSkillModelCatalogService["search"]>[0]) {
      const catalog = await readCatalog(options, input);
      return searchSkillCatalog({
        catalog,
        query: input.query,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        pageSize: input.pageSize ?? 20,
        audience: "MODEL",
        cursorBinding: String(input.runId),
      });
    },
  });
}

async function readCatalog(
  options: RunSkillModelCatalogServiceOptions,
  input: { readonly runId: RunId; readonly signal: AbortSignal },
): Promise<SkillSearchCatalog> {
  if (input.signal.aborted) {
    throw (
      input.signal.reason ?? new DOMException("Skill catalog read was cancelled.", "AbortError")
    );
  }
  if (options.runs.readWorkflowProfile === undefined) return EMPTY_CATALOG;
  const run = await options.runs.get(input.runId);
  if (run === null) throw new TypeError("The Skill catalog Run is unavailable.");
  const profile = await options.runs.readWorkflowProfile(input.runId);
  if (input.signal.aborted) {
    throw (
      input.signal.reason ?? new DOMException("Skill catalog read was cancelled.", "AbortError")
    );
  }
  if (profile === null) return EMPTY_CATALOG;

  const frozenProfile = RunWorkflowExecutionProfileV1Schema.parse(profile);
  if (frozenProfile.runId !== input.runId) {
    throw new TypeError("The Skill catalog profile belongs to another Run.");
  }
  const snapshot = await options.snapshots.readRunSkillCatalogSnapshot(
    frozenProfile.catalogSnapshotRef,
  );
  if (
    snapshot.workspaceId !== run.workspace.id ||
    snapshot.catalogRevision !== frozenProfile.catalogSnapshotRef.catalogRevision ||
    snapshot.complete !== true
  ) {
    throw new TypeError("The Run-bound Skill catalog snapshot is invalid.");
  }
  if (input.signal.aborted) {
    throw (
      input.signal.reason ?? new DOMException("Skill catalog read was cancelled.", "AbortError")
    );
  }

  return Object.freeze({
    revision: snapshot.catalogRevision,
    complete: snapshot.complete,
    diagnostics: Object.freeze([]),
    entries: Object.freeze(
      snapshot.skills.map((skill) =>
        Object.freeze({
          skillId: skill.skillId,
          name: skill.name,
          description: skill.description,
          ...(skill.displayName === undefined ? {} : { displayName: skill.displayName }),
          searchTerms: Object.freeze([...(skill.searchTerms ?? [])]),
          enabled: skill.enabled,
          userInvocable: skill.userInvocable,
          modelInvocable: skill.modelInvocable,
        }),
      ),
    ),
  });
}
