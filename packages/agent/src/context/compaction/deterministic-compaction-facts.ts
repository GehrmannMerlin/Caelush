import type { AgentExecutionIdentity } from "../../loop/types.js";
import type { ContextMessageRange } from "./context-compaction-contracts.js";

export interface DeterministicCompactionFacts {
  readonly readFiles: readonly string[];
  readonly changedFiles: readonly string[];
  readonly recentErrors: readonly string[];
  readonly verificationState: string;
  readonly activeProcesses: readonly string[];
  readonly pendingApprovals: readonly string[];
  readonly resourceGovernance: string;
}

export interface DeterministicCompactionFactsProvider {
  collect(input: {
    readonly identity: AgentExecutionIdentity;
    readonly sourceRange: ContextMessageRange;
    readonly signal: AbortSignal;
  }): Promise<DeterministicCompactionFacts>;
}

const FACT_KEYS = [
  "readFiles",
  "changedFiles",
  "recentErrors",
  "verificationState",
  "activeProcesses",
  "pendingApprovals",
  "resourceGovernance",
] as const satisfies readonly (keyof DeterministicCompactionFacts)[];

const MAX_FACT_ITEMS = 512;
const MAX_FACT_STRING_CHARS = 4_096;

/** Validate and deeply freeze facts at the Agent boundary. */
export function createDeterministicCompactionFacts(value: unknown): DeterministicCompactionFacts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("DeterministicCompactionFacts must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const expected = new Set<string>(FACT_KEYS);
  for (const key of Object.keys(candidate)) {
    if (!expected.has(key)) throw new TypeError(`Unknown deterministic fact: ${key}.`);
  }
  for (const key of FACT_KEYS) {
    if (!(key in candidate)) throw new TypeError(`Missing deterministic fact: ${key}.`);
  }
  for (const key of [
    "readFiles",
    "changedFiles",
    "recentErrors",
    "activeProcesses",
    "pendingApprovals",
  ] as const) {
    assertBoundedStringArray(candidate[key], key);
  }
  assertBoundedString(candidate.verificationState, "verificationState");
  assertBoundedString(candidate.resourceGovernance, "resourceGovernance");
  return deepFreeze({
    readFiles: [...(candidate.readFiles as string[])],
    changedFiles: [...(candidate.changedFiles as string[])],
    recentErrors: [...(candidate.recentErrors as string[])],
    verificationState: candidate.verificationState,
    activeProcesses: [...(candidate.activeProcesses as string[])],
    pendingApprovals: [...(candidate.pendingApprovals as string[])],
    resourceGovernance: candidate.resourceGovernance,
  });
}

function assertBoundedString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string")
    throw new TypeError(`Deterministic fact ${field} must be a string.`);
  if (value.length > MAX_FACT_STRING_CHARS) {
    throw new TypeError(`Deterministic fact ${field} exceeds its bound.`);
  }
}

function assertBoundedStringArray(
  value: unknown,
  field: string,
): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Deterministic fact ${field} must be an array of strings.`);
  }
  if (value.length > MAX_FACT_ITEMS) {
    throw new TypeError(`Deterministic fact ${field} exceeds its item bound.`);
  }
  for (const item of value) assertBoundedString(item, `${field} item`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
