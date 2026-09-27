/**
 * The only fields a semantic compaction model may author.
 *
 * Current operational facts deliberately do not appear here. They are read
 * from durable authorities after the summary attempt and are added by the
 * checkpoint enricher.
 */
export interface SemanticCheckpointDraft {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly completedWork: readonly string[];
  readonly inProgress: readonly string[];
  readonly blocked: readonly string[];
  readonly importantDiscoveries: readonly string[];
  readonly keyDecisions: readonly string[];
  readonly criticalReferences: readonly string[];
  readonly nextIntent: string;
}

const SEMANTIC_KEYS = [
  "goal",
  "constraints",
  "completedWork",
  "inProgress",
  "blocked",
  "importantDiscoveries",
  "keyDecisions",
  "criticalReferences",
  "nextIntent",
] as const satisfies readonly (keyof SemanticCheckpointDraft)[];

// These are intentionally implementation-local bounds. They bound one model
// response without creating a cross-package Protocol policy.
const MAX_SEMANTIC_STRING_CHARS = 8_192;
const MAX_SEMANTIC_LIST_ITEMS = 64;
const MAX_SEMANTIC_UTF8_BYTES = 24_000;

export function createSemanticCheckpointDraft(value: unknown): SemanticCheckpointDraft {
  assertSemanticCheckpointDraft(value);
  const draft = {
    goal: value.goal,
    constraints: [...value.constraints],
    completedWork: [...value.completedWork],
    inProgress: [...value.inProgress],
    blocked: [...value.blocked],
    importantDiscoveries: [...value.importantDiscoveries],
    keyDecisions: [...value.keyDecisions],
    criticalReferences: [...value.criticalReferences],
    nextIntent: value.nextIntent,
  } satisfies SemanticCheckpointDraft;
  return deepFreeze(draft);
}

export function assertSemanticCheckpointDraft(
  value: unknown,
): asserts value is SemanticCheckpointDraft {
  if (!isRecord(value)) throw new TypeError("SemanticCheckpointDraft must be an object.");
  assertExactKeys(value, SEMANTIC_KEYS);

  const listFields = [
    "constraints",
    "completedWork",
    "inProgress",
    "blocked",
    "importantDiscoveries",
    "keyDecisions",
    "criticalReferences",
  ] as const;
  assertBoundedString(value.goal, "goal");
  assertBoundedString(value.nextIntent, "nextIntent");
  for (const field of listFields) assertBoundedStringArray(value[field], field);

  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_SEMANTIC_UTF8_BYTES) {
    throw new TypeError("SemanticCheckpointDraft exceeds its bounded UTF-8 size.");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown SemanticCheckpointDraft field: ${key}.`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new TypeError(`Missing SemanticCheckpointDraft field: ${key}.`);
  }
}

function assertBoundedString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string")
    throw new TypeError(`SemanticCheckpointDraft ${field} must be a string.`);
  if (value.length > MAX_SEMANTIC_STRING_CHARS) {
    throw new TypeError(`SemanticCheckpointDraft ${field} is oversized.`);
  }
}

function assertBoundedStringArray(
  value: unknown,
  field: string,
): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`SemanticCheckpointDraft ${field} must be an array of strings.`);
  }
  if (value.length > MAX_SEMANTIC_LIST_ITEMS) {
    throw new TypeError(`SemanticCheckpointDraft ${field} has too many items.`);
  }
  for (const item of value) assertBoundedString(item, `${field} item`);
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
