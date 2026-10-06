import { createHash } from "node:crypto";

import type { RunId, TimestampMs } from "@caelush/protocol";

export const PROMPT_SURFACE_RESET_REASONS = [
  "INITIAL",
  "MODEL_CHANGED",
  "TOOL_SCHEMA_CHANGED",
  "STABLE_HEAD_CHANGED",
  "CACHE_SETTINGS_CHANGED",
  "COMPACTION_COMMITTED",
  "RECOVERY_INCOMPATIBLE",
] as const;

export type PromptSurfaceResetReason = (typeof PROMPT_SURFACE_RESET_REASONS)[number];

export const PROMPT_SURFACE_LIMITS = Object.freeze({
  maxEpochSnapshots: 128,
  maxSnapshotUtf8Bytes: 1_048_576,
  maxEpochUtf8Bytes: 4_194_304,
});

declare const PromptSurfaceEpochIdBrand: unique symbol;
declare const PromptSurfaceFingerprintBrand: unique symbol;

export type PromptSurfaceEpochId = string & {
  readonly [PromptSurfaceEpochIdBrand]: true;
};

export type PromptSurfaceFingerprint = string & {
  readonly [PromptSurfaceFingerprintBrand]: true;
};

/** Model identity deliberately excludes an endpoint URL or any credential-bearing data. */
export interface PromptSurfaceModelRef {
  readonly provider: string;
  readonly model: string;
}

export interface PromptSurfaceEpoch {
  readonly runId: RunId;
  readonly epochId: PromptSurfaceEpochId;
  readonly modelRef: PromptSurfaceModelRef;
  readonly stableHeadFingerprint: PromptSurfaceFingerprint;
  readonly toolSchemaFingerprint: PromptSurfaceFingerprint;
  readonly cacheSettingsFingerprint: PromptSurfaceFingerprint;
  readonly resetReason: PromptSurfaceResetReason;
  readonly createdStepSequence: number;
  readonly createdAt: TimestampMs;
}

export interface PromptSurfaceEpochInput extends Omit<
  PromptSurfaceEpoch,
  "epochId" | "stableHeadFingerprint" | "toolSchemaFingerprint" | "cacheSettingsFingerprint"
> {
  readonly epochId: string;
  readonly stableHeadFingerprint: string;
  readonly toolSchemaFingerprint: string;
  readonly cacheSettingsFingerprint: string;
}

export interface PromptSurfaceSnapshot {
  readonly runId: RunId;
  readonly epochId: PromptSurfaceEpochId;
  readonly ordinal: number;
  readonly anchorMessageSequence: number;
  readonly sourceStepSequence: number;
  readonly kind: "RUNTIME_CONTEXT_SNAPSHOT";
  readonly contentHash: string;
  readonly content: string;
  readonly createdAt: TimestampMs;
}

export type PromptSurfaceSnapshotInput = Omit<PromptSurfaceSnapshot, "contentHash">;

export interface PromptSurfaceEpochWithSnapshots extends PromptSurfaceEpoch {
  readonly snapshots: readonly PromptSurfaceSnapshot[];
}

export class PromptSurfaceIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PromptSurfaceIntegrityError";
  }
}

export function createPromptSurfaceEpochId(value: string): PromptSurfaceEpochId {
  assertBoundedText(value, "Prompt Surface epoch id", 256);
  return value as PromptSurfaceEpochId;
}

export function createPromptSurfaceFingerprint(value: string): PromptSurfaceFingerprint {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Prompt Surface fingerprint must be a canonical SHA-256 value.");
  }
  return value as PromptSurfaceFingerprint;
}

export function createPromptSurfaceEpoch(input: PromptSurfaceEpochInput): PromptSurfaceEpoch {
  assertPromptSurfaceEpoch(input);
  const epoch: PromptSurfaceEpoch = {
    ...input,
    epochId: createPromptSurfaceEpochId(input.epochId),
    stableHeadFingerprint: createPromptSurfaceFingerprint(input.stableHeadFingerprint),
    toolSchemaFingerprint: createPromptSurfaceFingerprint(input.toolSchemaFingerprint),
    cacheSettingsFingerprint: createPromptSurfaceFingerprint(input.cacheSettingsFingerprint),
    modelRef: Object.freeze({ ...input.modelRef }),
  };
  return Object.freeze(epoch);
}

export function assertPromptSurfaceEpoch(value: unknown): asserts value is PromptSurfaceEpoch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Prompt Surface epoch must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(
    candidate,
    [
      "runId",
      "epochId",
      "modelRef",
      "stableHeadFingerprint",
      "toolSchemaFingerprint",
      "cacheSettingsFingerprint",
      "resetReason",
      "createdStepSequence",
      "createdAt",
    ],
    "Prompt Surface epoch",
  );
  assertBoundedText(candidate.runId, "Prompt Surface run id", 256);
  createPromptSurfaceEpochId(requiredText(candidate.epochId, "Prompt Surface epoch id"));
  assertModelRef(candidate.modelRef);
  createPromptSurfaceFingerprint(
    requiredText(candidate.stableHeadFingerprint, "stable head fingerprint"),
  );
  createPromptSurfaceFingerprint(
    requiredText(candidate.toolSchemaFingerprint, "tool schema fingerprint"),
  );
  createPromptSurfaceFingerprint(
    requiredText(candidate.cacheSettingsFingerprint, "cache settings fingerprint"),
  );
  if (!isPromptSurfaceResetReason(candidate.resetReason)) {
    throw new TypeError("Prompt Surface reset reason is invalid.");
  }
  assertPositiveSafeInteger(candidate.createdStepSequence, "Prompt Surface created step sequence");
  assertTimestamp(candidate.createdAt, "Prompt Surface epoch timestamp");
}

export function assertPromptSurfaceEpochWithSnapshots(
  value: unknown,
): asserts value is PromptSurfaceEpochWithSnapshots {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PromptSurfaceIntegrityError("Prompt Surface epoch record must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const epoch = { ...candidate };
  const snapshots = epoch.snapshots;
  delete epoch.snapshots;
  assertPromptSurfaceEpoch(epoch);
  if (!Array.isArray(snapshots)) {
    throw new PromptSurfaceIntegrityError("Prompt Surface snapshots must be an ordered list.");
  }
  if (snapshots.length > PROMPT_SURFACE_LIMITS.maxEpochSnapshots) {
    throw new RangeError("Prompt Surface epoch exceeds its snapshot count limit.");
  }

  const encoder = new TextEncoder();
  let totalBytes = 0;
  let previousStepSequence = epoch.createdStepSequence - 1;
  let previousAnchorSequence = 0;
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    assertPromptSurfaceSnapshot(snapshot);
    if (
      snapshot.runId !== candidate.runId ||
      snapshot.epochId !== candidate.epochId ||
      snapshot.ordinal !== index + 1
    ) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface snapshot identity or order is invalid.",
      );
    }
    if (
      snapshot.sourceStepSequence <= previousStepSequence ||
      snapshot.anchorMessageSequence < previousAnchorSequence
    ) {
      throw new PromptSurfaceIntegrityError("Prompt Surface snapshot order is invalid.");
    }
    totalBytes += encoder.encode(snapshot.content).byteLength;
    if (totalBytes > PROMPT_SURFACE_LIMITS.maxEpochUtf8Bytes) {
      throw new RangeError("Prompt Surface epoch exceeds its UTF-8 byte limit.");
    }
    previousStepSequence = snapshot.sourceStepSequence;
    previousAnchorSequence = snapshot.anchorMessageSequence;
  }
}

export function createPromptSurfaceSnapshot(
  input: PromptSurfaceSnapshotInput,
): PromptSurfaceSnapshot {
  assertPromptSurfaceSnapshotInput(input);
  const snapshot: PromptSurfaceSnapshot = {
    ...input,
    contentHash: hashPromptSurfaceContent(input.content),
  };
  assertPromptSurfaceSnapshot(snapshot);
  return Object.freeze(snapshot);
}

export function assertPromptSurfaceSnapshot(
  value: unknown,
): asserts value is PromptSurfaceSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Prompt Surface snapshot must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(
    candidate,
    [
      "runId",
      "epochId",
      "ordinal",
      "anchorMessageSequence",
      "sourceStepSequence",
      "kind",
      "contentHash",
      "content",
      "createdAt",
    ],
    "Prompt Surface snapshot",
  );
  const input = { ...candidate };
  delete input.contentHash;
  assertPromptSurfaceSnapshotInput(input);
  if (typeof candidate.content !== "string") {
    throw new PromptSurfaceIntegrityError("Prompt Surface snapshot content is invalid.");
  }
  if (typeof candidate.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(candidate.contentHash)) {
    throw new PromptSurfaceIntegrityError("Prompt Surface snapshot hash is invalid.");
  }
  if (candidate.contentHash !== hashPromptSurfaceContent(candidate.content)) {
    throw new PromptSurfaceIntegrityError("Prompt Surface snapshot content hash does not match.");
  }
}

export function assertPromptSurfaceSnapshotInput(
  value: unknown,
): asserts value is PromptSurfaceSnapshotInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Prompt Surface snapshot input must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(
    candidate,
    [
      "runId",
      "epochId",
      "ordinal",
      "anchorMessageSequence",
      "sourceStepSequence",
      "kind",
      "content",
      "createdAt",
    ],
    "Prompt Surface snapshot input",
  );
  assertBoundedText(candidate.runId, "Prompt Surface run id", 256);
  createPromptSurfaceEpochId(requiredText(candidate.epochId, "Prompt Surface epoch id"));
  assertPositiveSafeInteger(candidate.ordinal, "Prompt Surface ordinal");
  assertPositiveSafeInteger(candidate.anchorMessageSequence, "Prompt Surface anchor sequence");
  assertPositiveSafeInteger(candidate.sourceStepSequence, "Prompt Surface source step sequence");
  if (candidate.kind !== "RUNTIME_CONTEXT_SNAPSHOT") {
    throw new TypeError("Prompt Surface snapshot kind is unsupported.");
  }
  if (typeof candidate.content !== "string" || candidate.content.length === 0) {
    throw new TypeError("Prompt Surface snapshot content must be non-empty text.");
  }
  const byteLength = new TextEncoder().encode(candidate.content).byteLength;
  if (byteLength > PROMPT_SURFACE_LIMITS.maxSnapshotUtf8Bytes) {
    throw new RangeError("Prompt Surface snapshot exceeds its UTF-8 byte limit.");
  }
  assertTimestamp(candidate.createdAt, "Prompt Surface snapshot timestamp");
}

export function hashPromptSurfaceContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertModelRef(value: unknown): asserts value is PromptSurfaceModelRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Prompt Surface model reference must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, ["provider", "model"], "Prompt Surface model reference");
  assertBoundedText(candidate.provider, "Prompt Surface model provider", 128);
  assertBoundedText(candidate.model, "Prompt Surface model id", 256);
}

function assertBoundedText(
  value: unknown,
  name: string,
  maxBytes: number,
): asserts value is string {
  assertNonEmptyString(value, name);
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`${name} exceeds its UTF-8 byte limit.`);
  }
}

function requiredText(value: unknown, name: string): string {
  assertNonEmptyString(value, name);
  return value;
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertTimestamp(value: unknown, name: string): asserts value is TimestampMs {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function isPromptSurfaceResetReason(value: unknown): value is PromptSurfaceResetReason {
  return PROMPT_SURFACE_RESET_REASONS.some((reason) => reason === value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new TypeError(`${label} has an unsupported shape.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}
