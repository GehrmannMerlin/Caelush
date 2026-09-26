import type { RunId, TimestampMs } from "@caelush/protocol";

import type { ContextArtifactId } from "../item/context-item.js";

export type ArtifactSensitivity = "PUBLIC" | "INTERNAL" | "SENSITIVE";

export interface ContextArtifactMetadata {
  readonly artifactId: ContextArtifactId;
  readonly runId: RunId;
  readonly kind: string;
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
}

export interface ContextArtifact extends ContextArtifactMetadata {
  readonly content: string;
}

export interface ContextArtifactCreateInput {
  readonly artifactId?: ContextArtifactId;
  readonly runId: RunId;
  readonly kind: string;
  readonly sourceRef: string;
  readonly content: string;
  readonly mimeType: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
}

export interface ContextArtifactStorePort {
  createOrGet(input: ContextArtifactCreateInput): Promise<ContextArtifact>;
  getMetadata(artifactId: ContextArtifactId): Promise<ContextArtifactMetadata | undefined>;
  readInternal(artifactId: ContextArtifactId): Promise<ContextArtifact | undefined>;
  readSafeProjection(artifactId: ContextArtifactId, maxBytes: number): Promise<string | undefined>;
}

export type { ContextArtifactId } from "../item/context-item.js";
