import { createHash } from "node:crypto";
import type { CaelushDatabase } from "./database.js";
import { StorageError } from "./errors.js";

export type ArtifactSensitivity = "PUBLIC" | "INTERNAL" | "SENSITIVE";
export interface Artifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly kind: string;
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly createdSequence: number;
  readonly createdAt: number;
  readonly sensitivity: ArtifactSensitivity;
  readonly content: string;
}
export interface ContextArtifactCreateInput {
  readonly artifactId?: string;
  readonly runId: string;
  readonly kind: string;
  readonly sourceRef: string;
  readonly content: string;
  readonly mimeType: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly createdSequence: number;
  readonly createdAt: number;
}
export interface ContextArtifactRepository {
  createOrGet(input: ContextArtifactCreateInput): Promise<Artifact>;
  getMetadata(artifactId: string): Promise<Omit<Artifact, "content"> | undefined>;
  readInternal(artifactId: string): Promise<Artifact | undefined>;
  readSafeProjection(artifactId: string, maxBytes: number): Promise<string | undefined>;
}

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

function decode(row: ArtifactRow): Artifact {
  return Object.freeze({
    artifactId: row.id,
    runId: row.run_id,
    kind: row.kind,
    sourceRef: row.source_ref,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    mimeType: row.mime_type,
    createdSequence: row.created_sequence,
    createdAt: row.created_at_ms,
    sensitivity: row.sensitivity as Artifact["sensitivity"],
    content: row.content,
  });
}

function safeProjection(content: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const encoder = new TextEncoder();
  if (encoder.encode(content).byteLength <= maxBytes) return content;
  const marker = "\n[artifact projection truncated]";
  const markerBytes = encoder.encode(marker).byteLength;
  if (markerBytes >= maxBytes) return "[truncated]".slice(0, maxBytes);
  let result = "";
  for (const character of content) {
    const candidate = result + character;
    if (encoder.encode(candidate).byteLength + markerBytes > maxBytes) break;
    result = candidate;
  }
  return `${result}${marker}`;
}

export class SqliteContextArtifactRepository implements ContextArtifactRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async createOrGet(input: ContextArtifactCreateInput): Promise<Artifact> {
    const contentHash = createHash("sha256").update(input.content, "utf8").digest("hex");
    const artifactId = input.artifactId ?? `artifact:${contentHash}`;
    const existing = this.database.client
      .prepare("SELECT * FROM context_artifacts WHERE id = ?")
      .get(artifactId) as ArtifactRow | undefined;
    if (existing !== undefined) return decode(existing);
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
      throw new StorageError("Unable to persist context artifact.", { cause: error });
    }
    const saved = this.database.client
      .prepare("SELECT * FROM context_artifacts WHERE id = ?")
      .get(artifactId) as ArtifactRow | undefined;
    if (saved === undefined) throw new StorageError("Persisted context artifact is unavailable.");
    return decode(saved);
  }

  async getMetadata(artifactId: string): Promise<Omit<Artifact, "content"> | undefined> {
    const artifact = await this.readInternal(artifactId);
    if (artifact === undefined) return undefined;
    const metadata: Omit<Artifact, "content"> = {
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      kind: artifact.kind,
      sourceRef: artifact.sourceRef,
      contentHash: artifact.contentHash,
      byteLength: artifact.byteLength,
      mimeType: artifact.mimeType,
      createdSequence: artifact.createdSequence,
      createdAt: artifact.createdAt,
      sensitivity: artifact.sensitivity,
    };
    return Object.freeze(metadata);
  }

  async readInternal(artifactId: string): Promise<Artifact | undefined> {
    const row = this.database.client
      .prepare("SELECT * FROM context_artifacts WHERE id = ?")
      .get(artifactId) as ArtifactRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  async readSafeProjection(artifactId: string, maxBytes: number): Promise<string | undefined> {
    const artifact = await this.readInternal(artifactId);
    return artifact === undefined ? undefined : safeProjection(artifact.content, maxBytes);
  }
}
