import type { ModelContextProfile } from "./model-context-profile.js";
import type { StructuredCheckpoint } from "./checkpoint.js";
import type { Artifact, ArtifactSensitivity } from "./observation-projector.js";

export interface ContextCheckpointRecord {
  readonly checkpointId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly previousCheckpointId?: string;
  readonly sourceSequenceFrom: number;
  readonly sourceSequenceTo: number;
  readonly structuredCheckpoint: StructuredCheckpoint;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly modelRef: Pick<ModelContextProfile, "providerId" | "modelId">;
  readonly createdAt: number;
}

export interface ContextCheckpointCreateInput extends Omit<
  ContextCheckpointRecord,
  "schemaVersion"
> {
  readonly previousCheckpointId?: string;
}

export interface ContextCheckpointRepository {
  create(input: ContextCheckpointCreateInput): Promise<ContextCheckpointRecord>;
  getLatestByRun(runId: string): Promise<ContextCheckpointRecord | undefined>;
  getById(checkpointId: string): Promise<ContextCheckpointRecord | undefined>;
  listByRun(runId: string): Promise<readonly ContextCheckpointRecord[]>;
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
