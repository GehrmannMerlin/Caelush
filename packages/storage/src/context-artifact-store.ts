import { createHash } from "node:crypto";

import type {
  ContextArtifact,
  ContextArtifactCreateInput,
  ContextArtifactClaimResult,
  ContextArtifactMetadataPage,
  ContextArtifactMetadata,
  ContextArtifactStorePort,
} from "@caelush/agent";

import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "./errors.js";

interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  source_ref: string;
  content_hash: string;
  byte_length: number;
  mime_type: string;
  sensitivity: string;
  created_sequence: number;
  created_at_ms: number;
  content: string;
}

const SENSITIVITIES = new Set(["PUBLIC", "INTERNAL", "SENSITIVE"]);
const DEFAULT_SOURCE_PAGE_SIZE = 20;
const MAX_SOURCE_PAGE_SIZE = 100;

/** V2 Artifact port adapter. It shares the legacy table but never the legacy identity algorithm. */
export class SqliteContextArtifactStore implements ContextArtifactStorePort {
  constructor(private readonly database: CaelushDatabase) {}

  async createOrGet(input: ContextArtifactCreateInput): Promise<ContextArtifact> {
    assertCreateInput(input);
    const contentHash = hashContent(input.content);
    const artifactId = input.artifactId ?? createRunScopedArtifactId(input, contentHash);
    const existing = this.readRow(artifactId);
    if (existing !== undefined) {
      if (existing.run_id !== input.runId) {
        throw new StorageConflictError(
          "Context artifact ownership does not match the requested Run.",
        );
      }
      if (!sameSemanticArtifact(existing, input, contentHash)) {
        throw new StorageConflictError(
          "Context artifact identity is already bound to different content.",
        );
      }
      return decodeArtifact(existing);
    }
    try {
      this.database.client
        .prepare(
          `INSERT INTO context_artifacts
           (id, run_id, kind, source_ref, content_hash, byte_length, mime_type, sensitivity,
            created_sequence, created_at_ms, content)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          input.runId,
          input.kind,
          input.sourceRef,
          contentHash,
          Buffer.byteLength(input.content, "utf8"),
          input.mimeType,
          input.sensitivity,
          input.createdSequence,
          input.createdAt,
          input.content,
        );
    } catch (error) {
      throw new StorageError("Unable to persist Context Artifact V2.", { cause: error });
    }
    const saved = this.readRow(artifactId);
    if (saved === undefined)
      throw new StorageError("Persisted Context Artifact V2 is unavailable.");
    return decodeArtifact(saved);
  }

  async claim(input: ContextArtifactCreateInput): Promise<ContextArtifactClaimResult> {
    assertCreateInput(input);
    const contentHash = hashContent(input.content);
    const artifactId = input.artifactId ?? createRunScopedArtifactId(input, contentHash);
    let inserted: boolean;
    try {
      const result = this.database.client
        .prepare(
          `INSERT OR IGNORE INTO context_artifacts
           (id, run_id, kind, source_ref, content_hash, byte_length, mime_type, sensitivity,
            created_sequence, created_at_ms, content)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          input.runId,
          input.kind,
          input.sourceRef,
          contentHash,
          Buffer.byteLength(input.content, "utf8"),
          input.mimeType,
          input.sensitivity,
          input.createdSequence,
          input.createdAt,
          input.content,
        );
      inserted = Number(result.changes) === 1;
    } catch (error) {
      throw new StorageError("Unable to atomically claim Context Artifact V2.", { cause: error });
    }
    const row = this.readRow(artifactId);
    if (row === undefined) throw new StorageError("Claimed Context Artifact V2 is unavailable.");
    if (
      (row.run_id !== input.runId && !isCrossRunCompactionClaim(input)) ||
      !sameClaimedArtifact(row, input, contentHash)
    ) {
      throw new StorageConflictError("Context artifact claim identity is bound to different data.");
    }
    return Object.freeze({
      kind: inserted ? "CREATED" : "EXISTING",
      artifact: decodeArtifact(row),
    });
  }

  async listBySourceRef(input: {
    readonly kind: string;
    readonly sourceRef: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<ContextArtifactMetadataPage> {
    if (input.kind.trim().length === 0 || input.sourceRef.trim().length === 0) {
      throw new RangeError("Artifact source query identity is invalid.");
    }
    const limit = input.limit ?? DEFAULT_SOURCE_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SOURCE_PAGE_SIZE) {
      throw new RangeError(
        `Artifact source page size must be between 1 and ${MAX_SOURCE_PAGE_SIZE}.`,
      );
    }
    if (input.cursor !== undefined && input.cursor.trim().length === 0) {
      throw new RangeError("Artifact source cursor is invalid.");
    }
    const rows = this.database.client
      .prepare(
        `SELECT * FROM context_artifacts
         WHERE kind = ? AND source_ref = ? AND (? IS NULL OR id > ?)
         ORDER BY id ASC LIMIT ?`,
      )
      .all(
        input.kind,
        input.sourceRef,
        input.cursor ?? null,
        input.cursor ?? null,
        limit + 1,
      ) as unknown as ArtifactRow[];
    const page = (rows ?? []).slice(0, limit).map((row) => toMetadata(decodeArtifact(row)));
    const next = (rows ?? []).length > limit ? page.at(-1)?.artifactId : undefined;
    return Object.freeze({
      records: Object.freeze(page),
      ...(next === undefined ? {} : { nextCursor: String(next) }),
    });
  }

  async getMetadata(
    artifactId: ContextArtifactMetadata["artifactId"],
  ): Promise<ContextArtifactMetadata | undefined> {
    const row = this.readRow(artifactId);
    return row === undefined ? undefined : toMetadata(decodeArtifact(row));
  }

  async readInternal(
    artifactId: ContextArtifactMetadata["artifactId"],
  ): Promise<ContextArtifact | undefined> {
    const row = this.readRow(artifactId);
    return row === undefined ? undefined : decodeArtifact(row);
  }

  async readSafeProjection(
    artifactId: ContextArtifactMetadata["artifactId"],
    maxBytes: number,
  ): Promise<string | undefined> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer.");
    }
    const artifact = await this.readInternal(artifactId);
    if (artifact?.sensitivity === "SENSITIVE")
      throw new StorageError("Sensitive artifact projection is forbidden.");
    return artifact === undefined ? undefined : safeProjection(artifact.content, maxBytes);
  }

  private readRow(artifactId: string): ArtifactRow | undefined {
    return this.database.client
      .prepare("SELECT * FROM context_artifacts WHERE id = ?")
      .get(artifactId) as ArtifactRow | undefined;
  }
}

/** Insert or verify one deterministic Artifact while a caller-owned transaction is open. */
export function writeContextArtifactInTransaction(
  database: CaelushDatabase,
  input: ContextArtifactCreateInput,
): ContextArtifact {
  assertCreateInput(input);
  const contentHash = hashContent(input.content);
  const artifactId = input.artifactId ?? createRunScopedArtifactId(input, contentHash);
  const existing = database.client
    .prepare("SELECT * FROM context_artifacts WHERE id = ?")
    .get(artifactId) as ArtifactRow | undefined;
  if (existing !== undefined) {
    if (existing.run_id !== input.runId && !isCrossRunCompactionClaim(input)) {
      throw new StorageConflictError("Context Artifact transaction ownership conflicts.");
    }
    if (!sameClaimedArtifact(existing, input, contentHash)) {
      throw new StorageConflictError("Context Artifact transaction identity conflicts.");
    }
    return decodeArtifact(existing);
  }
  try {
    database.client
      .prepare(
        `INSERT INTO context_artifacts
         (id, run_id, kind, source_ref, content_hash, byte_length, mime_type, sensitivity,
          created_sequence, created_at_ms, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        input.runId,
        input.kind,
        input.sourceRef,
        contentHash,
        Buffer.byteLength(input.content, "utf8"),
        input.mimeType,
        input.sensitivity,
        input.createdSequence,
        input.createdAt,
        input.content,
      );
  } catch (error) {
    throw new StorageError("Unable to persist Context Artifact in the authority transaction.", {
      cause: error,
    });
  }
  const saved = database.client
    .prepare("SELECT * FROM context_artifacts WHERE id = ?")
    .get(artifactId) as ArtifactRow | undefined;
  if (saved === undefined) {
    throw new StorageError("Context Artifact transaction write was not visible.");
  }
  return decodeArtifact(saved);
}

function assertCreateInput(input: ContextArtifactCreateInput): void {
  for (const [value, label] of [
    [input.runId, "runId"],
    [input.kind, "kind"],
    [input.sourceRef, "sourceRef"],
    [input.mimeType, "mimeType"],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new StorageError(`Context Artifact ${label} is invalid.`);
    }
  }
  if (!SENSITIVITIES.has(input.sensitivity))
    throw new StorageError("Context Artifact sensitivity is invalid.");
  if (!Number.isSafeInteger(input.createdSequence) || input.createdSequence < 1) {
    throw new StorageError("Context Artifact sequence is invalid.");
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new StorageError("Context Artifact timestamp is invalid.");
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function createRunScopedArtifactId(input: ContextArtifactCreateInput, contentHash: string): string {
  const identity = `${input.runId}\u0000${input.kind}\u0000${input.sourceRef}\u0000${contentHash}`;
  return `artifact:v2:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function sameSemanticArtifact(
  row: ArtifactRow,
  input: ContextArtifactCreateInput,
  contentHash: string,
): boolean {
  return (
    row.kind === input.kind &&
    row.source_ref === input.sourceRef &&
    row.content_hash === contentHash &&
    row.byte_length === Buffer.byteLength(input.content, "utf8") &&
    row.mime_type === input.mimeType &&
    row.sensitivity === input.sensitivity &&
    row.created_sequence === input.createdSequence &&
    row.created_at_ms === input.createdAt &&
    row.content === input.content
  );
}

function isCrossRunCompactionClaim(input: ContextArtifactCreateInput): boolean {
  if (input.kind === "context-compaction-summary") {
    return isCrossRunCompactionSummaryClaim(input);
  }
  if (
    (input.kind !== "context-compaction-attempt" &&
      input.kind !== "context-compaction-subcall" &&
      input.kind !== "context-compaction-failure-baseline") ||
    input.sensitivity !== "INTERNAL" ||
    !input.sourceRef.startsWith("compaction-attempt:") ||
    Buffer.byteLength(input.content, "utf8") > 4_096
  ) {
    return false;
  }
  try {
    const value = JSON.parse(input.content) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const allowed = new Set([
      "version",
      "recordType",
      "attemptId",
      "state",
      "callOrdinal",
      "requestFingerprint",
      "outcome",
      "sourceCoverageDigest",
      "sourceTokens",
      "minimumGrowthTokens",
      "failureFamily",
      "retryGeneration",
      "checkpointId",
      "activationOperationId",
    ]);
    return (
      record.version === 1 &&
      typeof record.recordType === "string" &&
      typeof record.attemptId === "string" &&
      Object.keys(record).every((key) => allowed.has(key))
    );
  } catch {
    return false;
  }
}

function isCrossRunCompactionSummaryClaim(input: ContextArtifactCreateInput): boolean {
  const sourcePrefix = "compaction-summary:";
  const maxSummaryBytes = 32_768;
  if (
    input.sensitivity !== "INTERNAL" ||
    input.mimeType !== "application/json" ||
    !new RegExp(`^${sourcePrefix}sha256:[0-9a-f]{64}$`).test(input.sourceRef) ||
    Buffer.byteLength(input.content, "utf8") > maxSummaryBytes
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(input.content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    const expectedKeys = [
      "version",
      "requestFingerprint",
      "promptVersion",
      "costVersion",
      "modelRef",
      "finishReason",
      "sourceDigest",
      "semanticDigest",
      "semantic",
    ].sort();
    const actualKeys = Object.keys(record).sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      record.version !== 1 ||
      record.requestFingerprint !== input.sourceRef.slice(sourcePrefix.length) ||
      !Number.isSafeInteger(record.promptVersion) ||
      (record.promptVersion as number) < 1 ||
      typeof record.costVersion !== "string" ||
      record.costVersion.length === 0 ||
      record.finishReason !== "STOP" ||
      typeof record.sourceDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.sourceDigest) ||
      typeof record.semanticDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.semanticDigest)
    ) {
      return false;
    }
    const modelRef = record.modelRef;
    if (
      modelRef === null ||
      typeof modelRef !== "object" ||
      Array.isArray(modelRef) ||
      Object.keys(modelRef).sort().join(",") !== "model,provider" ||
      typeof (modelRef as Record<string, unknown>).provider !== "string" ||
      typeof (modelRef as Record<string, unknown>).model !== "string" ||
      ((modelRef as Record<string, string>).provider ?? "").length > 256 ||
      ((modelRef as Record<string, string>).model ?? "").length > 256
    ) {
      return false;
    }
    const semantic = record.semantic;
    if (semantic === null || typeof semantic !== "object" || Array.isArray(semantic)) return false;
    const draft = semantic as Record<string, unknown>;
    const draftKeys = [
      "constraints",
      "completedWork",
      "inProgress",
      "blocked",
      "importantDiscoveries",
      "keyDecisions",
      "criticalReferences",
      "nextIntent",
    ].sort();
    if (Object.keys(draft).sort().join(",") !== draftKeys.join(",")) return false;
    for (const field of draftKeys) {
      const value = draft[field];
      if (field === "nextIntent") {
        if (typeof value !== "string" || value.length > 8_192) return false;
        continue;
      }
      if (
        !Array.isArray(value) ||
        value.length > 64 ||
        value.some((item) => typeof item !== "string" || item.length > 8_192)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Claim replay preserves the first timestamp while requiring every operation fact to match. */
function sameClaimedArtifact(
  row: ArtifactRow,
  input: ContextArtifactCreateInput,
  contentHash: string,
): boolean {
  return (
    row.kind === input.kind &&
    row.source_ref === input.sourceRef &&
    row.content_hash === contentHash &&
    row.byte_length === Buffer.byteLength(input.content, "utf8") &&
    row.mime_type === input.mimeType &&
    row.sensitivity === input.sensitivity &&
    row.created_sequence === input.createdSequence &&
    row.content === input.content
  );
}

function decodeArtifact(row: ArtifactRow): ContextArtifact {
  try {
    if (!SENSITIVITIES.has(row.sensitivity)) throw new Error("invalid sensitivity");
    if (typeof row.content !== "string") throw new Error("invalid content");
    if (row.byte_length !== Buffer.byteLength(row.content, "utf8"))
      throw new Error("byte length mismatch");
    if (row.content_hash !== hashContent(row.content)) throw new Error("content hash mismatch");
    if (!Number.isSafeInteger(row.created_sequence) || row.created_sequence < 1)
      throw new Error("invalid sequence");
    if (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0)
      throw new Error("invalid timestamp");
    return Object.freeze({
      artifactId: row.id as ContextArtifact["artifactId"],
      runId: row.run_id as ContextArtifact["runId"],
      kind: row.kind,
      sourceRef: row.source_ref,
      contentHash: row.content_hash,
      byteLength: row.byte_length,
      mimeType: row.mime_type,
      sensitivity: row.sensitivity as ContextArtifact["sensitivity"],
      createdSequence: row.created_sequence,
      createdAt: row.created_at_ms as ContextArtifact["createdAt"],
      content: row.content,
    });
  } catch (error) {
    throw new StorageDecodeError("ContextArtifact", row.id, "context_artifacts", { cause: error });
  }
}

function toMetadata(artifact: ContextArtifact): ContextArtifactMetadata {
  return Object.freeze({
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    kind: artifact.kind,
    sourceRef: artifact.sourceRef,
    contentHash: artifact.contentHash,
    byteLength: artifact.byteLength,
    mimeType: artifact.mimeType,
    sensitivity: artifact.sensitivity,
    createdSequence: artifact.createdSequence,
    createdAt: artifact.createdAt,
  });
}

function safeProjection(content: string, maxBytes: number): string {
  const marker = "\n[artifact projection truncated]";
  const encoder = new TextEncoder();
  if (encoder.encode(content).byteLength <= maxBytes) return content;
  if (encoder.encode(marker).byteLength >= maxBytes) return prefixByBytes(content, maxBytes);
  return `${prefixByBytes(content, maxBytes - encoder.encode(marker).byteLength)}${marker}`;
}

function prefixByBytes(content: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  for (const character of content) {
    const candidate = result + character;
    if (encoder.encode(candidate).byteLength > maxBytes) break;
    result = candidate;
  }
  return result;
}
