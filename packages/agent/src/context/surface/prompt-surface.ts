import type { RunId, TimestampMs } from "@caelush/protocol";

import type { AgentMessageId, ConversationTurnId } from "../../messages/types/ids.js";
import {
  applyPromptSurfaceSectionUpdates,
  assertPromptSurfaceSectionStates,
  assertSectionUpdate,
  renderPromptSurfaceRecord,
} from "./prompt-surface-v3.js";
import type { PromptSurfaceSectionState, PromptSurfaceSectionUpdate } from "./prompt-surface-v3.js";
import {
  PromptSurfaceIntegrityError,
  hashPromptSurfaceContent,
} from "./prompt-surface-integrity.js";

export {
  PromptSurfaceIntegrityError,
  hashPromptSurfaceContent,
} from "./prompt-surface-integrity.js";

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
  maxEpochRecords: 4_096,
  maxEpochSectionStates: 2_048,
  maxSnapshotUtf8Bytes: 1_048_576,
  maxEpochUtf8Bytes: 4_194_304,
});

export const PROMPT_SURFACE_ANCHOR_VERSION = 2 as const;

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
  readonly formatVersion: 2 | 3;
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
  | "formatVersion"
  | "epochId"
  | "stableHeadFingerprint"
  | "toolSchemaFingerprint"
  | "cacheSettingsFingerprint"
> {
  readonly formatVersion?: 2 | 3;
  readonly epochId: string;
  readonly stableHeadFingerprint: string;
  readonly toolSchemaFingerprint: string;
  readonly cacheSettingsFingerprint: string;
}

/** Scoped durable identity for a Prompt Surface boundary message. */
export interface PromptSurfaceAnchor {
  readonly messageId: AgentMessageId;
  readonly runId: RunId;
  readonly conversationTurnId: ConversationTurnId;
  /** Run-local position for validation and diagnostics only. */
  readonly sequence: number;
}

export interface PromptSurfaceSnapshot {
  readonly runId: RunId;
  readonly epochId: PromptSurfaceEpochId;
  readonly ordinal: number;
  readonly anchor: PromptSurfaceAnchor;
  readonly sourceStepSequence: number;
  readonly kind: "RUNTIME_CONTEXT_SNAPSHOT";
  readonly contentHash: string;
  readonly content: string;
  readonly createdAt: TimestampMs;
}

export type PromptSurfaceSnapshotInput = Omit<PromptSurfaceSnapshot, "contentHash">;

export interface PromptSurfaceEpochWithSnapshots extends PromptSurfaceEpoch {
  readonly snapshots: readonly PromptSurfaceSnapshot[];
  readonly records?: readonly PromptSurfaceRecord[];
  readonly sectionStates?: readonly PromptSurfaceSectionState[];
}

export type PromptSurfaceRecordKind = "BASELINE" | "DELTA" | "NOOP";

export interface PromptSurfaceRecord {
  readonly runId: RunId;
  readonly epochId: PromptSurfaceEpochId;
  readonly ordinal: number;
  readonly anchor: PromptSurfaceAnchor;
  readonly sourceStepSequence: number;
  readonly kind: PromptSurfaceRecordKind;
  readonly updates: readonly PromptSurfaceSectionUpdate[];
  readonly decisionFingerprint: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly createdAt: TimestampMs;
}

export type PromptSurfaceRecordInput = Omit<PromptSurfaceRecord, "contentHash" | "byteLength">;

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
  const versionedInput = { ...input, formatVersion: input.formatVersion ?? 2 };
  assertPromptSurfaceEpoch(versionedInput);
  const epoch: PromptSurfaceEpoch = {
    ...versionedInput,
    epochId: createPromptSurfaceEpochId(input.epochId),
    stableHeadFingerprint: createPromptSurfaceFingerprint(input.stableHeadFingerprint),
    toolSchemaFingerprint: createPromptSurfaceFingerprint(input.toolSchemaFingerprint),
    cacheSettingsFingerprint: createPromptSurfaceFingerprint(input.cacheSettingsFingerprint),
    modelRef: Object.freeze({ ...input.modelRef }),
  };
  return Object.freeze(epoch);
}

export function createPromptSurfaceAnchor(input: PromptSurfaceAnchor): PromptSurfaceAnchor {
  assertPromptSurfaceAnchor(input);
  return Object.freeze({ ...input });
}

export function assertPromptSurfaceEpoch(value: unknown): asserts value is PromptSurfaceEpoch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Prompt Surface epoch must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = [
    "runId",
    "epochId",
    "modelRef",
    "stableHeadFingerprint",
    "toolSchemaFingerprint",
    "cacheSettingsFingerprint",
    "resetReason",
    "createdStepSequence",
    "createdAt",
  ];
  if (candidate["formatVersion"] !== undefined) expectedKeys.push("formatVersion");
  assertExactKeys(candidate, expectedKeys, "Prompt Surface epoch");
  assertBoundedText(candidate.runId, "Prompt Surface run id", 256);
  createPromptSurfaceEpochId(requiredText(candidate.epochId, "Prompt Surface epoch id"));
  assertModelRef(candidate.modelRef);
  if (
    candidate["formatVersion"] !== undefined &&
    candidate["formatVersion"] !== 2 &&
    candidate["formatVersion"] !== 3
  ) {
    throw new TypeError("Prompt Surface format version is invalid.");
  }
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
  const records = epoch.records;
  const sectionStates = epoch.sectionStates;
  delete epoch.snapshots;
  delete epoch.records;
  delete epoch.sectionStates;
  assertPromptSurfaceEpoch(epoch);
  if (!Array.isArray(snapshots)) {
    throw new PromptSurfaceIntegrityError("Prompt Surface snapshots must be an ordered list.");
  }

  if (candidate.formatVersion === 3) {
    if (snapshots.length !== 0 || !Array.isArray(records) || !Array.isArray(sectionStates)) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface V3 records or Section state are missing.",
      );
    }
    assertPromptSurfaceV3Records(
      candidate as unknown as PromptSurfaceEpoch,
      records,
      sectionStates,
    );
    return;
  }
  if (records !== undefined || sectionStates !== undefined) {
    throw new PromptSurfaceIntegrityError("Prompt Surface V2 epoch contains V3 state.");
  }
  if (snapshots.length > PROMPT_SURFACE_LIMITS.maxEpochSnapshots) {
    throw new RangeError("Prompt Surface epoch exceeds its snapshot count limit.");
  }

  const encoder = new TextEncoder();
  let totalBytes = 0;
  let previousStepSequence = epoch.createdStepSequence - 1;
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
    if (snapshot.sourceStepSequence <= previousStepSequence) {
      throw new PromptSurfaceIntegrityError("Prompt Surface snapshot order is invalid.");
    }
    totalBytes += encoder.encode(snapshot.content).byteLength;
    if (totalBytes > PROMPT_SURFACE_LIMITS.maxEpochUtf8Bytes) {
      throw new RangeError("Prompt Surface epoch exceeds its UTF-8 byte limit.");
    }
    previousStepSequence = snapshot.sourceStepSequence;
  }
}

function assertPromptSurfaceV3Records(
  epoch: PromptSurfaceEpoch,
  records: readonly PromptSurfaceRecord[],
  sectionStates: readonly PromptSurfaceSectionState[],
): void {
  if (records.length > PROMPT_SURFACE_LIMITS.maxEpochRecords) {
    throw new RangeError("Prompt Surface V3 epoch exceeds its decision record limit.");
  }
  if (records.length === 0) {
    assertPromptSurfaceSectionStates(sectionStates);
    if (sectionStates.length !== 0) {
      throw new PromptSurfaceIntegrityError(
        "Empty Prompt Surface V3 log has non-empty Section state.",
      );
    }
    return;
  }
  if (records[0]?.kind !== "BASELINE") {
    throw new PromptSurfaceIntegrityError(
      "Prompt Surface V3 epoch has no initial baseline decision.",
    );
  }
  let state: readonly PromptSurfaceSectionState[] = Object.freeze([]);
  let previousStepSequence = epoch.createdStepSequence - 1;
  let visibleCount = 0;
  let totalBytes = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    assertPromptSurfaceRecord(record);
    if (
      record.runId !== epoch.runId ||
      record.epochId !== epoch.epochId ||
      record.ordinal !== index + 1 ||
      record.sourceStepSequence <= previousStepSequence ||
      record.sourceStepSequence < epoch.createdStepSequence ||
      (index > 0 && record.kind === "BASELINE")
    ) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface V3 record identity or ordering is invalid.",
      );
    }
    state = applyPromptSurfaceSectionUpdates(state, record.kind, record.updates);
    if (record.kind !== "NOOP") visibleCount += 1;
    totalBytes += record.byteLength;
    if (totalBytes > PROMPT_SURFACE_LIMITS.maxEpochUtf8Bytes) {
      throw new RangeError("Prompt Surface V3 epoch exceeds its UTF-8 byte limit.");
    }
    previousStepSequence = record.sourceStepSequence;
  }
  if (visibleCount > PROMPT_SURFACE_LIMITS.maxEpochSnapshots) {
    throw new RangeError("Prompt Surface V3 epoch exceeds its visible message limit.");
  }
  assertPromptSurfaceSectionStates(sectionStates);
  if (stableJson(state) !== stableJson(sectionStates)) {
    throw new PromptSurfaceIntegrityError(
      "Prompt Surface V3 current Section state does not match its log.",
    );
  }
}

function recordCanonicalJson(input: PromptSurfaceRecordInput): string {
  return stableJson({
    runId: input.runId,
    epochId: input.epochId,
    ordinal: input.ordinal,
    anchor: input.anchor,
    sourceStepSequence: input.sourceStepSequence,
    kind: input.kind,
    updates: input.updates,
    decisionFingerprint: input.decisionFingerprint,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createPromptSurfaceRecord(input: PromptSurfaceRecordInput): PromptSurfaceRecord {
  assertPromptSurfaceRecordInput(input);
  const content = input.kind === "NOOP" ? "" : renderPromptSurfaceRecord(input.kind, input.updates);
  const record: PromptSurfaceRecord = Object.freeze({
    ...input,
    anchor: createPromptSurfaceAnchor(input.anchor),
    updates: Object.freeze(input.updates.map((update) => Object.freeze({ ...update }))),
    contentHash: hashPromptSurfaceContent(recordCanonicalJson(input)),
    byteLength: Buffer.byteLength(content, "utf8"),
  });
  assertPromptSurfaceRecord(record);
  return record;
}

export function assertPromptSurfaceRecord(value: unknown): asserts value is PromptSurfaceRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PromptSurfaceIntegrityError("Prompt Surface V3 record must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(
    candidate,
    [
      "runId",
      "epochId",
      "ordinal",
      "anchor",
      "sourceStepSequence",
      "kind",
      "updates",
      "decisionFingerprint",
      "contentHash",
      "byteLength",
      "createdAt",
    ],
    "Prompt Surface V3 record",
  );
  const input = { ...candidate };
  delete input.contentHash;
  delete input.byteLength;
  assertPromptSurfaceRecordInput(input);
  const content =
    candidate["kind"] === "NOOP"
      ? ""
      : renderPromptSurfaceRecord(
          candidate["kind"] as "BASELINE" | "DELTA",
          candidate["updates"] as readonly PromptSurfaceSectionUpdate[],
        );
  if (
    candidate["contentHash"] !==
      hashPromptSurfaceContent(
        recordCanonicalJson(candidate as unknown as PromptSurfaceRecordInput),
      ) ||
    candidate["byteLength"] !== Buffer.byteLength(content, "utf8")
  ) {
    throw new PromptSurfaceIntegrityError(
      "Prompt Surface V3 record checksum or byte length is invalid.",
    );
  }
}

export function assertPromptSurfaceRecordInput(
  value: unknown,
): asserts value is PromptSurfaceRecordInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PromptSurfaceIntegrityError("Prompt Surface V3 record input is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(
    candidate,
    [
      "runId",
      "epochId",
      "ordinal",
      "anchor",
      "sourceStepSequence",
      "kind",
      "updates",
      "decisionFingerprint",
      "createdAt",
    ],
    "Prompt Surface V3 record input",
  );
  assertBoundedText(candidate["runId"], "Prompt Surface Run id", 256);
  createPromptSurfaceEpochId(requiredText(candidate["epochId"], "Prompt Surface epoch id"));
  assertPositiveSafeInteger(candidate["ordinal"], "Prompt Surface V3 record ordinal");
  assertPromptSurfaceAnchor(candidate["anchor"]);
  assertPositiveSafeInteger(candidate["sourceStepSequence"], "Prompt Surface source Step sequence");
  if (!["BASELINE", "DELTA", "NOOP"].includes(String(candidate["kind"]))) {
    throw new PromptSurfaceIntegrityError("Prompt Surface V3 record kind is invalid.");
  }
  if (!Array.isArray(candidate["updates"])) {
    throw new PromptSurfaceIntegrityError("Prompt Surface V3 record operations are invalid.");
  }
  const anchor = candidate["anchor"] as PromptSurfaceAnchor;
  for (const update of candidate["updates"]) assertSectionUpdate(update);
  const kind = candidate["kind"] as PromptSurfaceRecordKind;
  if (
    (kind === "NOOP" && candidate["updates"].length !== 0) ||
    (kind === "DELTA" && candidate["updates"].length === 0)
  ) {
    throw new PromptSurfaceIntegrityError("Prompt Surface V3 record kind and operations disagree.");
  }
  const fingerprint = candidate["decisionFingerprint"];
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new PromptSurfaceIntegrityError("Prompt Surface decision fingerprint is invalid.");
  }
  assertTimestamp(candidate["createdAt"], "Prompt Surface V3 record timestamp");
  const content =
    kind === "NOOP"
      ? ""
      : renderPromptSurfaceRecord(
          kind as "BASELINE" | "DELTA",
          candidate["updates"] as readonly PromptSurfaceSectionUpdate[],
        );
  if (Buffer.byteLength(content, "utf8") > PROMPT_SURFACE_LIMITS.maxSnapshotUtf8Bytes) {
    throw new RangeError("Prompt Surface V3 record exceeds its UTF-8 byte limit.");
  }
}

export function createPromptSurfaceSnapshot(
  input: PromptSurfaceSnapshotInput,
): PromptSurfaceSnapshot {
  assertPromptSurfaceSnapshotInput(input);
  const snapshot: PromptSurfaceSnapshot = {
    ...input,
    anchor: createPromptSurfaceAnchor(input.anchor),
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
      "anchor",
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
  assertPromptSurfaceAnchor(candidate.anchor);
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
    ["runId", "epochId", "ordinal", "anchor", "sourceStepSequence", "kind", "content", "createdAt"],
    "Prompt Surface snapshot input",
  );
  assertBoundedText(candidate.runId, "Prompt Surface run id", 256);
  createPromptSurfaceEpochId(requiredText(candidate.epochId, "Prompt Surface epoch id"));
  assertPositiveSafeInteger(candidate.ordinal, "Prompt Surface ordinal");
  assertPromptSurfaceAnchor(candidate.anchor);
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

export function assertPromptSurfaceAnchor(value: unknown): asserts value is PromptSurfaceAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Prompt Surface anchor must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(
    candidate,
    ["messageId", "runId", "conversationTurnId", "sequence"],
    "Prompt Surface anchor",
  );
  assertBoundedText(candidate.messageId, "Prompt Surface anchor message id", 256);
  assertBoundedText(candidate.runId, "Prompt Surface anchor Run id", 256);
  assertBoundedText(candidate.conversationTurnId, "Prompt Surface anchor ConversationTurn id", 256);
  assertPositiveSafeInteger(candidate.sequence, "Prompt Surface anchor Run-local sequence");
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
