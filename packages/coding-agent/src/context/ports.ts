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

export interface RelevantFileSectionProjection {
  readonly relativePath: string;
  readonly sourceRef: string;
  readonly version: string;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly bytesIncluded: number;
  readonly truncated: boolean;
  readonly maxReadBytes?: number;
}

export interface RelevantFileProjection {
  readonly sections: readonly RelevantFileSectionProjection[];
}

export interface RelevantFileContextPort {
  load(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<RelevantFileProjection>;
}

export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly resourceRef: string;
  readonly version: string;
}

export interface SkillCatalogPort {
  list(input: {
    readonly projectId?: string;
    readonly signal: AbortSignal;
  }): Promise<readonly SkillCatalogEntry[]>;
}

export interface GitStateProjection {
  readonly sourceRef: string;
  readonly version: string;
  readonly branch?: string;
  readonly changedPaths: readonly string[];
  readonly summary: string;
}

export interface GitStateContextPort {
  read(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<GitStateProjection>;
}

export interface VerificationRepairProjection {
  readonly repairRef?: string;
  readonly sourceRef: string;
  readonly version: string;
  readonly text: string;
}

export interface VerificationRepairContextPort {
  read(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<VerificationRepairProjection | undefined>;
}

export interface ContextClock {
  now(): number;
}

export type CodingContextClock = ContextClock;
