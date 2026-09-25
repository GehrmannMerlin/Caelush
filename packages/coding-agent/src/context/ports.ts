import type { AgentExecutionIdentity } from "@caelush/agent";

export interface CodingWorkspaceDescriptor {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly workspaceRef: string;
  readonly projectRef: string;
  readonly cwdRef: string;
  readonly runtimeKind: string;
  readonly safeMetadata: Readonly<Record<string, string>>;
}

export interface CodingWorkspacePort {
  describe(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<CodingWorkspaceDescriptor>;
}

export interface CodingRuntimeFactsProjection {
  readonly sourceRef: string;
  readonly version: string;
  readonly facts: readonly string[];
}

export interface CodingRuntimeFactsPort {
  read(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<CodingRuntimeFactsProjection>;
}

export interface ProjectInstructionEntry {
  readonly relativePath: string;
  readonly kind: string;
  readonly content: string;
}

export interface ProjectInstructionProjection {
  readonly sourceRef: string;
  readonly version: string;
  readonly entries: readonly ProjectInstructionEntry[];
}

export interface ProjectInstructionContextPort {
  load(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<ProjectInstructionProjection>;
}

export interface ProjectMetadataProjection {
  readonly sourceRef: string;
  readonly version: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ProjectMetadataContextPort {
  load(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<ProjectMetadataProjection>;
}
