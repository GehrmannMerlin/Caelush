import { createHash } from "node:crypto";

import type {
  ContextArtifact,
  ContextArtifactCreateInput,
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
    return artifact === undefined ? undefined : safeProjection(artifact.content, maxBytes);
  }

  private readRow(artifactId: string): ArtifactRow | undefined {
    return this.database.client
      .prepare("SELECT * FROM context_artifacts WHERE id = ?")
      .get(artifactId) as ArtifactRow | undefined;
  }
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
