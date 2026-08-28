export {
  ContextBoundaryError,
  ContextError,
  ContextDiscoveryError,
  ContextIgnoreError,
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
export { IgnorePolicy } from "./ignore-policy.js";
export type { IgnoreDecision, IgnorePolicyDependencies } from "./ignore-policy.js";
export { CandidateFileDiscovery } from "./file-discovery.js";
export type {
  CandidateDiscoveryOptions,
  CandidateFile,
  CandidateFileDiscoveryDependencies,
  CandidateFileDiscoveryResult,
  RelevantFileDiscoveryStats,
} from "./file-discovery.js";
export { RelevantPathRanker, tokenizeRelevantQuery } from "./relevance.js";
export type {
  RelevantFileCandidate,
  RelevantFileQuery,
  RelevanceReason,
  RelevantPathRankerOptions,
} from "./relevance.js";
export { Utf8HeuristicTokenEstimator } from "./token-estimator.js";
export type { TokenEstimator } from "./token-estimator.js";
export {
  FileBudgetSelector,
  defaultRelevantFileBudget,
  validateRelevantFileBudget,
} from "./file-budget.js";
export type { FileBudgetSelectionResult, FileBudgetSelectorDependencies } from "./file-budget.js";
export type {
  FileContextProvenance,
  RelevantFileBudget,
  RelevantFileBudgetReport,
  RelevantFileContextPlan,
  RelevantFileContextSection,
} from "./relevant-file-plan.js";
export { RelevantFilePlanner, createLocalRelevantFilePlanner } from "./relevant-file-planner.js";
export type {
  RelevantFilePlannerDependencies,
  RelevantFilePlannerInput,
} from "./relevant-file-planner.js";
