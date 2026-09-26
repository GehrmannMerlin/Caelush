export { CODING_CONTEXT_SOURCE_IDS } from "./source-ids.js";
export type {
  CodingRuntimeFactsProjection,
  CodingRuntimeFactsPort,
  CodingWorkspaceDescriptor,
  CodingWorkspacePort,
  ProjectInstructionContextPort,
  ProjectInstructionEntry,
  ProjectInstructionProjection,
  ProjectMetadataContextPort,
  ProjectMetadataProjection,
  RelevantFileContextPort,
  RelevantFileProjection,
  RelevantFileSectionProjection,
  SkillCatalogEntry,
  SkillCatalogPort,
  GitStateContextPort,
  GitStateProjection,
  VerificationRepairContextPort,
  VerificationRepairProjection,
  ContextClock,
  CodingContextClock,
} from "./ports.js";
export type { CodingContextProviderOptions } from "./provider-helpers.js";
export {
  CODING_RELEVANT_FILE_LIMITS,
  createRelevantFileContextSourceProvider,
} from "./providers/relevant-file-provider.js";
export type { RelevantFileContextSourceProviderOptions } from "./providers/relevant-file-provider.js";
export {
  createNoOpSkillCatalogPort,
  createSkillCatalogContextSourceProvider,
} from "./providers/skill-catalog-provider.js";
export type { SkillCatalogContextSourceProviderOptions } from "./providers/skill-catalog-provider.js";
export { createGitStateContextSourceProvider } from "./providers/git-state-provider.js";
export type { GitStateContextSourceProviderOptions } from "./providers/git-state-provider.js";
export { createVerificationRepairContextSourceProvider } from "./providers/verification-repair-provider.js";
export type { VerificationRepairContextSourceProviderOptions } from "./providers/verification-repair-provider.js";
export { createTemporalContextSourceProvider } from "./providers/temporal-context-provider.js";
export type { TemporalContextSourceProviderOptions } from "./providers/temporal-context-provider.js";
export { createWorkspaceContextSourceProvider } from "./providers/workspace-provider.js";
export type { WorkspaceContextSourceProviderOptions } from "./providers/workspace-provider.js";
export { createRuntimeFactsContextSourceProvider } from "./providers/runtime-facts-provider.js";
export type { RuntimeFactsContextSourceProviderOptions } from "./providers/runtime-facts-provider.js";
export { createProjectInstructionContextSourceProvider } from "./providers/project-instruction-provider.js";
export type { ProjectInstructionContextSourceProviderOptions } from "./providers/project-instruction-provider.js";
export { createProjectMetadataContextSourceProvider } from "./providers/project-metadata-provider.js";
export type { ProjectMetadataContextSourceProviderOptions } from "./providers/project-metadata-provider.js";
export { createLocalCodingContextPorts } from "./local-ports.js";
export type { LocalCodingContextPorts, LocalCodingContextPortOptions } from "./local-ports.js";
export { createLocalProjectInspector } from "./project-intelligence.js";
export type {
  CodingProjectDiagnostic,
  CodingWorkspaceScope,
  EnvironmentSnapshot,
  InstructionKind,
  PackageManagerInfo,
  ProjectEcosystem,
  ProjectInspector,
  ProjectInspectorInput,
  ProjectInstruction,
  ProjectInstructions,
  ProjectIntelligenceSnapshot,
  ProjectLanguageSignal,
  ProjectManifestEvidence,
  ProjectPackage,
  ProjectProfile,
  ProjectRootDetectionResult,
  ProjectScript,
  ProjectToolEvidence,
} from "./project-intelligence.js";
