export interface WorldStateInput {
  readonly revision: string;
  readonly workspaceIdentity: string;
  readonly projectManifests: readonly string[];
  readonly languageFramework: readonly string[];
  readonly projectRules: readonly string[];
  readonly changedFiles: readonly string[];
  readonly gitSummary: string;
  readonly activeProcesses: readonly string[];
  readonly approvalSummary: string;
  readonly verificationSummary: string;
  readonly resourceGovernance: string;
  readonly recentImportantFacts: readonly string[];
}

export type WorldStateProjection = WorldStateInput;

export interface WorldStateDelta {
  readonly revisionFrom: string;
  readonly revisionTo: string;
  readonly changes: Partial<Omit<WorldStateProjection, "revision">>;
}

const GENERATED_ROOTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "release-artifacts",
  "vendor",
]);

function cloneList(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

export function createWorldStateProjection(input: WorldStateInput): WorldStateProjection {
  if (input.revision.length === 0 || input.workspaceIdentity.length === 0) {
    throw new RangeError("World state requires revision and workspace identity");
  }
  return Object.freeze({
    revision: input.revision,
    workspaceIdentity: input.workspaceIdentity,
    projectManifests: cloneList(input.projectManifests),
    languageFramework: cloneList(input.languageFramework),
    projectRules: cloneList(input.projectRules),
    changedFiles: cloneList(input.changedFiles),
    gitSummary: input.gitSummary,
    activeProcesses: cloneList(input.activeProcesses),
    approvalSummary: input.approvalSummary,
    verificationSummary: input.verificationSummary,
    resourceGovernance: input.resourceGovernance,
    recentImportantFacts: cloneList(input.recentImportantFacts),
  });
}

export function diffWorldState(
  previous: WorldStateProjection,
  next: WorldStateProjection,
): WorldStateDelta {
  const changes: Partial<Omit<WorldStateProjection, "revision">> = {};
  for (const key of [
    "workspaceIdentity",
    "projectManifests",
    "languageFramework",
    "projectRules",
    "changedFiles",
    "gitSummary",
    "activeProcesses",
    "approvalSummary",
    "verificationSummary",
    "resourceGovernance",
    "recentImportantFacts",
  ] as const) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      const value = next[key];
      (changes as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return Object.freeze({
    revisionFrom: previous.revision,
    revisionTo: next.revision,
    changes: Object.freeze(changes),
  });
}

export function applyWorldStateDelta(
  previous: WorldStateProjection,
  delta: WorldStateDelta,
): WorldStateProjection {
  if (previous.revision !== delta.revisionFrom) {
    throw new Error("World state delta revision does not match the current snapshot");
  }
  return createWorldStateProjection({
    ...previous,
    ...delta.changes,
    revision: delta.revisionTo,
  });
}

export function isGeneratedTreePath(path: string): boolean {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => GENERATED_ROOTS.has(segment));
}
