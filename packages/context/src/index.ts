export {
  ContextBoundaryError,
  ContextError,
  ContextInstructionError,
  ContextIOError,
  ContextInvalidWorkspaceError,
} from "./errors.js";
export type {
  ContextDirectoryEntry,
  ContextFileKind,
  ContextFileMetadata,
  ContextFileSystem,
  ContextTextFile,
} from "./filesystem.js";
export { LocalEnvironmentDetector } from "./environment.js";
export type { EnvironmentDetector, EnvironmentSnapshot } from "./environment.js";
export { ProjectInstructionDiscovery } from "./instructions.js";
export type {
  InstructionKind,
  ProjectInstruction,
  ProjectInstructionDiscoveryOptions,
  ProjectInstructions,
} from "./instructions.js";
export { ProjectInspector, createLocalProjectInspector } from "./project-inspector.js";
export type { ProjectInspectorDependencies, ProjectInspectorInput } from "./project-inspector.js";
export type {
  ContextDiagnostic,
  PackageManagerInfo,
  PackageManagerName,
  ProjectEcosystem,
  ProjectLanguageSignal,
  ProjectManifestEvidence,
  ProjectPackage,
  ProjectProfile,
  ProjectScript,
  ProjectToolEvidence,
} from "./project-profile.js";
export { ProjectProfileDetector } from "./project-profile.js";
export { ProjectRootDetector } from "./project-root.js";
export type { ProjectRootDetectionResult, ProjectRootReason } from "./project-root.js";
export type { ProjectIntelligenceSnapshot } from "./snapshot.js";
export { WorkspaceScopeResolver } from "./workspace.js";
export type { WorkspaceScope } from "./workspace.js";
