import type { AgentMessage, StoredAgentMessage } from "../../messages/index.js";

declare const ContextItemIdBrand: unique symbol;
declare const ContextSourceIdBrand: unique symbol;
declare const ContextArtifactIdBrand: unique symbol;

export type ContextItemId = string & { readonly [ContextItemIdBrand]: true };
export type ContextSourceId = string & { readonly [ContextSourceIdBrand]: true };
export type ContextArtifactId = string & { readonly [ContextArtifactIdBrand]: true };

export function createContextItemId(value: string): ContextItemId {
  assertNonEmptyString(value, "ContextItem id");
  return value as ContextItemId;
}

export function createContextSourceId(value: string): ContextSourceId {
  assertNonEmptyString(value, "Context source id");
  return value as ContextSourceId;
}

export function createContextArtifactId(value: string): ContextArtifactId {
  assertNonEmptyString(value, "Context artifact id");
  return value as ContextArtifactId;
}

export type ContextScope = "TURN" | "RUN" | "SESSION" | "PROJECT" | "GLOBAL";
export type ContextRetention =
  "PINNED" | "REHYDRATABLE" | "RECENT" | "COMPRESSIBLE" | "RETRIEVABLE" | "EPHEMERAL";
export type ContextPriorityClass = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
export type ContextCacheStability = "STABLE" | "SEMI_STABLE" | "DYNAMIC";
export type ContextFreshness = "CURRENT" | "STALE" | "UNKNOWN";
export type ContextSensitivity = "PUBLIC" | "INTERNAL" | "SENSITIVE";

export interface ContextItemSource {
  readonly providerId: ContextSourceId;
  readonly sourceRef: string;
  readonly version: string;
}

/**
 * The checkpoint shape is intentionally opaque in 7A. Checkpoint V2 owns its
 * canonical payload and persistence in a later round; the ContextItem boundary
 * only needs to carry a JSON-safe checkpoint value.
 */
export type StructuredCheckpoint = Readonly<Record<string, unknown>>;

export type ContextItemPayload =
  | { readonly kind: "TEXT"; readonly text: string }
  | { readonly kind: "AGENT_MESSAGE"; readonly message: StoredAgentMessage }
  | { readonly kind: "CHECKPOINT"; readonly checkpoint: StructuredCheckpoint }
  | {
      readonly kind: "ARTIFACT_REFERENCE";
      readonly artifactId: ContextArtifactId;
      readonly preview?: string;
    };

export interface ContextItem {
  readonly id: ContextItemId;
  readonly type: string;
  readonly source: ContextItemSource;
  readonly scope: ContextScope;
  readonly retention: ContextRetention;
  readonly priorityClass: ContextPriorityClass;
  readonly tokenEstimate: number;
  readonly cacheStability: ContextCacheStability;
  readonly freshness: ContextFreshness;
  readonly sensitivity: ContextSensitivity;
  readonly atomicGroupId?: string;
  readonly whyLoaded: string;
  readonly payload: ContextItemPayload;
}

const SCOPES = ["TURN", "RUN", "SESSION", "PROJECT", "GLOBAL"] as const;
const RETENTIONS = [
  "PINNED",
  "REHYDRATABLE",
  "RECENT",
  "COMPRESSIBLE",
  "RETRIEVABLE",
  "EPHEMERAL",
] as const;
const PRIORITIES = ["CRITICAL", "HIGH", "NORMAL", "LOW"] as const;
const CACHE_STABILITIES = ["STABLE", "SEMI_STABLE", "DYNAMIC"] as const;
const FRESHNESSES = ["CURRENT", "STALE", "UNKNOWN"] as const;
const SENSITIVITIES = ["PUBLIC", "INTERNAL", "SENSITIVE"] as const;

export function createContextItem(input: ContextItem): ContextItem {
  assertContextItem(input);
  return deepFreeze(clone(input));
}

export function assertContextItem(value: unknown): asserts value is ContextItem {
  if (!isRecord(value)) throw new TypeError("ContextItem must be an object.");
  assertExactKeys(value, [
    "id",
    "type",
    "source",
    "scope",
    "retention",
    "priorityClass",
    "tokenEstimate",
    "cacheStability",
    "freshness",
    "sensitivity",
    "atomicGroupId",
    "whyLoaded",
    "payload",
  ]);
  assertNonEmptyString(value.id, "ContextItem id");
  assertNonEmptyString(value.type, "ContextItem type");
  if (!isRecord(value.source)) throw new TypeError("ContextItem source must be an object.");
  assertExactKeys(value.source, ["providerId", "sourceRef", "version"]);
  assertNonEmptyString(value.source.providerId, "ContextItem source providerId");
  assertNonEmptyString(value.source.sourceRef, "ContextItem source sourceRef");
  assertNonEmptyString(value.source.version, "ContextItem source version");
  assertEnum(value.scope, SCOPES, "ContextItem scope");
  assertEnum(value.retention, RETENTIONS, "ContextItem retention");
  assertEnum(value.priorityClass, PRIORITIES, "ContextItem priorityClass");
  assertNonNegativeSafeInteger(value.tokenEstimate, "ContextItem tokenEstimate");
  assertEnum(value.cacheStability, CACHE_STABILITIES, "ContextItem cacheStability");
  assertEnum(value.freshness, FRESHNESSES, "ContextItem freshness");
  assertEnum(value.sensitivity, SENSITIVITIES, "ContextItem sensitivity");
  if (value.atomicGroupId !== undefined) {
    assertNonEmptyString(value.atomicGroupId, "ContextItem atomicGroupId");
  }
  assertNonEmptyString(value.whyLoaded, "ContextItem whyLoaded");
  assertContextItemPayload(value.payload);
}

function assertContextItemPayload(value: unknown): asserts value is ContextItemPayload {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("ContextItem payload must be a discriminated object.");
  }
  switch (value.kind) {
    case "TEXT":
      assertExactKeys(value, ["kind", "text"]);
      if (typeof value.text !== "string")
        throw new TypeError("TEXT payload text must be a string.");
      return;
    case "AGENT_MESSAGE":
      assertExactKeys(value, ["kind", "message"]);
      assertStoredAgentMessage(value.message);
      return;
    case "CHECKPOINT":
      assertExactKeys(value, ["kind", "checkpoint"]);
      if (!isRecord(value.checkpoint)) throw new TypeError("CHECKPOINT payload must be an object.");
      return;
    case "ARTIFACT_REFERENCE":
      assertExactKeys(value, ["kind", "artifactId", "preview"]);
      assertNonEmptyString(value.artifactId, "ARTIFACT_REFERENCE artifactId");
      if (value.preview !== undefined && typeof value.preview !== "string") {
        throw new TypeError("ARTIFACT_REFERENCE preview must be a string.");
      }
      return;
    default:
      throw new TypeError(`Unsupported ContextItem payload kind: ${value.kind}.`);
  }
}

function assertStoredAgentMessage(value: unknown): asserts value is StoredAgentMessage {
  if (!isRecord(value)) throw new TypeError("AGENT_MESSAGE payload message must be an object.");
  assertExactKeys(value, ["sequence", "schemaVersion", "modelProjectionVersion", "message"]);
  assertPositiveSafeInteger(value.sequence, "StoredAgentMessage sequence");
  assertPositiveSafeInteger(value.schemaVersion, "StoredAgentMessage schemaVersion");
  if (value.modelProjectionVersion !== undefined) {
    assertPositiveSafeInteger(
      value.modelProjectionVersion,
      "StoredAgentMessage modelProjectionVersion",
    );
  }
  if (!isRecord(value.message)) throw new TypeError("AGENT_MESSAGE payload message is invalid.");
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`Unexpected ContextItem field: ${key}.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${label} must not be empty.`);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new TypeError(`${label} is invalid.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = clone(entry);
  return output as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export type { AgentMessage };
