import { assertContextSourceCoverage } from "../compaction/context-source-coverage.js";

/**
 * The source range carried by the V1 StructuredCheckpoint payload.
 *
 * The durable V2 record owns the full message identity. In a V2 writer these
 * two numbers are StoredAgentMessage.sequence values, not array indexes.
 */
export interface CheckpointSourceRange {
  readonly from: number;
  readonly to: number;
}

/** The canonical semantic payload retained inside a V2 checkpoint envelope. */
export interface StructuredCheckpoint {
  readonly version: 1;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly completedWork: readonly string[];
  readonly inProgress: readonly string[];
  readonly blocked: readonly string[];
  readonly importantDiscoveries: readonly string[];
  readonly keyDecisions: readonly string[];
  readonly changedFiles: readonly string[];
  readonly readFiles: readonly string[];
  readonly recentErrors: readonly string[];
  readonly verificationState: string;
  readonly activeProcesses: readonly string[];
  readonly pendingApprovals: readonly string[];
  readonly resourceGovernance: string;
  readonly criticalReferences: readonly string[];
  readonly nextIntent: string;
  readonly sourceRange: CheckpointSourceRange;
}

/** The canonical payload for a V3 checkpoint with Session-scoped multi-range coverage. */
export interface StructuredCheckpointV2 extends Omit<
  StructuredCheckpoint,
  "version" | "sourceRange"
> {
  readonly version: 2;
  readonly sourceCoverage: ContextSourceCoverage;
}

const STRUCTURED_CHECKPOINT_KEYS = [
  "version",
  "goal",
  "constraints",
  "completedWork",
  "inProgress",
  "blocked",
  "importantDiscoveries",
  "keyDecisions",
  "changedFiles",
  "readFiles",
  "recentErrors",
  "verificationState",
  "activeProcesses",
  "pendingApprovals",
  "resourceGovernance",
  "criticalReferences",
  "nextIntent",
  "sourceRange",
] as const;

/** Validate a canonical checkpoint at a JSON-facing boundary. */
export function assertStructuredCheckpoint(value: unknown): asserts value is StructuredCheckpoint {
  if (!isRecord(value)) throw new TypeError("StructuredCheckpoint must be an object.");
  assertExactKeys(value, STRUCTURED_CHECKPOINT_KEYS);
  if (value.version !== 1) throw new TypeError("StructuredCheckpoint version must be 1.");
  assertString(value.goal, "StructuredCheckpoint goal");
  for (const field of [
    "constraints",
    "completedWork",
    "inProgress",
    "blocked",
    "importantDiscoveries",
    "keyDecisions",
    "changedFiles",
    "readFiles",
    "recentErrors",
    "activeProcesses",
    "pendingApprovals",
    "criticalReferences",
  ] as const) {
    assertStringArray(value[field], `StructuredCheckpoint ${field}`);
  }
  assertString(value.verificationState, "StructuredCheckpoint verificationState");
  assertString(value.resourceGovernance, "StructuredCheckpoint resourceGovernance");
  assertString(value.nextIntent, "StructuredCheckpoint nextIntent");
  if (!isRecord(value.sourceRange)) {
    throw new TypeError("StructuredCheckpoint sourceRange must be an object.");
  }
  assertExactKeys(value.sourceRange, ["from", "to"]);
  assertPositiveSafeInteger(value.sourceRange.from, "StructuredCheckpoint sourceRange.from");
  assertPositiveSafeInteger(value.sourceRange.to, "StructuredCheckpoint sourceRange.to");
  if (value.sourceRange.from > value.sourceRange.to) {
    throw new TypeError("StructuredCheckpoint sourceRange must be ordered.");
  }
}

/** Clone and deeply freeze a canonical checkpoint. */
export function createStructuredCheckpoint(input: StructuredCheckpoint): StructuredCheckpoint {
  assertStructuredCheckpoint(input);
  return deepFreeze({
    ...input,
    constraints: [...input.constraints],
    completedWork: [...input.completedWork],
    inProgress: [...input.inProgress],
    blocked: [...input.blocked],
    importantDiscoveries: [...input.importantDiscoveries],
    keyDecisions: [...input.keyDecisions],
    changedFiles: [...input.changedFiles],
    readFiles: [...input.readFiles],
    recentErrors: [...input.recentErrors],
    activeProcesses: [...input.activeProcesses],
    pendingApprovals: [...input.pendingApprovals],
    criticalReferences: [...input.criticalReferences],
    sourceRange: { ...input.sourceRange },
  });
}

/** Validate a V3 structured payload without changing any V1 durable payload semantics. */
export function assertStructuredCheckpointV2(
  value: unknown,
): asserts value is StructuredCheckpointV2 {
  if (!isRecord(value)) throw new TypeError("StructuredCheckpointV2 must be an object.");
  const expected = STRUCTURED_CHECKPOINT_KEYS.filter((key) => key !== "sourceRange");
  const keys = new Set([...expected, "sourceCoverage"]);
  if (Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) {
    throw new TypeError("StructuredCheckpointV2 has an invalid shape.");
  }
  if (value.version !== 2) throw new TypeError("StructuredCheckpointV2 version must be 2.");
  const semanticFields = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "sourceCoverage"),
  );
  const semantic = { ...semanticFields, version: 1, sourceRange: { from: 1, to: 1 } };
  assertStructuredCheckpoint(semantic);
  assertContextSourceCoverage(value.sourceCoverage);
}

/** Clone and deeply freeze a canonical V2 payload. */
export function createStructuredCheckpointV2(
  input: StructuredCheckpointV2,
): StructuredCheckpointV2 {
  assertStructuredCheckpointV2(input);
  return deepFreeze({
    ...input,
    constraints: [...input.constraints],
    completedWork: [...input.completedWork],
    inProgress: [...input.inProgress],
    blocked: [...input.blocked],
    importantDiscoveries: [...input.importantDiscoveries],
    keyDecisions: [...input.keyDecisions],
    changedFiles: [...input.changedFiles],
    readFiles: [...input.readFiles],
    recentErrors: [...input.recentErrors],
    activeProcesses: [...input.activeProcesses],
    pendingApprovals: [...input.pendingApprovals],
    criticalReferences: [...input.criticalReferences],
    sourceCoverage: {
      ...input.sourceCoverage,
      segments: input.sourceCoverage.segments.map((segment) => ({ ...segment })),
    },
  });
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
}

function assertStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be an array of strings.`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`Unexpected StructuredCheckpoint field: ${key}.`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new TypeError(`Missing StructuredCheckpoint field: ${key}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
import type { ContextSourceCoverage } from "../compaction/context-source-coverage.js";
