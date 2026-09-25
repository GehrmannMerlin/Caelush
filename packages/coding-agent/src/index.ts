/**
 * `@caelush/coding-agent` — Architecture V2 coding composition layer.
 *
 * Responsibility (Architecture V2, frozen):
 *   - General Agent to Coding Agent composition
 *   - Workspace Context Providers, Relevant File Providers, Project Instructions
 *   - Coding Tools, Coding Security, Coding Verification, Coding Prompt
 *   - Future Extension, Skill, and MCP surfaces
 *
 * This package may depend on `@caelush/agent`, `@caelush/ai`,
 * `@caelush/runtime`, and `@caelush/protocol`. It may never depend on
 * `@caelush/storage`, `@caelush/client`, or the Daemon, and no package may
 * depend back on it. Those boundaries are enforced by
 * `pnpm check:architecture`.
 *
 * Phase 4A landed the Coding Tool overlay contracts here. **Phase 4E made this package the Coding Tool
 * product authority**:
 *
 * ```text
 * the nine Coding builtins              read_file · list_directory · find_files · search_text
 *                                       apply_patch · exec_command · write_stdin
 *                                       git_status · git_diff
 * the default order and composition     DEFAULT_CODING_TOOL_ORDER · createDefaultCodingTools
 * the narrow Operations ports           ReadFileOperations … GitOperations
 * the Runtime Operations adapters       the only code allowed to hold a RuntimeResolver
 * Coding security metadata and facts    risk levels, capabilities, facts projectors
 * the Coding approval identity          computeCodingToolApprovalKey
 * the Coding effect vocabulary          effects, effect/state/event projectors
 * the Coding output policy              Coding bounds and the canonical content bounder
 * prompt snippets + the Context provider  usage guidance delivered through Context, not description
 * ```
 *
 * `@caelush/tools` — the legacy Tool System package that once held a second implementation of every
 * one of these — was removed in Phase 4F. The dependency direction this package participates in is
 * one-way and permanent:
 *
 * ```text
 * @caelush/coding-agent  ──▶  @caelush/agent  ──▶  @caelush/ai
 * ```
 */

export {
  CODING_CONTEXT_SOURCE_IDS,
  createProjectInstructionContextSourceProvider,
  createProjectMetadataContextSourceProvider,
  createRuntimeFactsContextSourceProvider,
  createWorkspaceContextSourceProvider,
} from "./context/index.js";
export type {
  CodingContextProviderOptions,
  CodingRuntimeFactsProjection,
  CodingRuntimeFactsPort,
  CodingWorkspaceDescriptor,
  CodingWorkspacePort,
  ProjectInstructionContextPort,
  ProjectInstructionContextSourceProviderOptions,
  ProjectInstructionEntry,
  ProjectInstructionProjection,
  ProjectMetadataContextPort,
  ProjectMetadataContextSourceProviderOptions,
  ProjectMetadataProjection,
  RuntimeFactsContextSourceProviderOptions,
  WorkspaceContextSourceProviderOptions,
} from "./context/index.js";

export {
  APPLY_PATCH_PROMPT_SNIPPET,
  applyToolEffectsToAgentState,
  assertToolSecurityFactsProjector,
  boundToolModelContent,
  CODING_TOOL_CATALOG_ERROR_REASONS,
  CODING_TOOL_EFFECTS_PAYLOAD_KIND,
  CODING_TOOL_PROMPT_SNIPPETS,
  CodingSettlementExtensionError,
  codingToolEffectsPayload,
  CodingToolCatalogBuilder,
  CodingToolCatalogError,
  computeCodingToolApprovalKey,
  createApplyPatchTool,
  createCodingToolAdmissionPort,
  createCodingToolCatalog,
  createCodingToolDurableMetadataPort,
  createCodingToolSettlementExtensionDecoder,
  createCodingToolSettlementExtensionProjector,
  createDefaultCodingTools,
  createDurableInvocationGatePort,
  createExecCommandTool,
  createFindFilesTool,
  createGitDiffTool,
  createGitStatusTool,
  createLegacyNumericArgumentNormalization,
  createListDirectoryTool,
  createReadFileTool,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeProgressSignalProjector,
  createRuntimeReadOnlyOperations,
  createSearchTextTool,
  createToolPromptContextProvider,
  createWriteStdinTool,
  decodeCodingToolEffects,
  DEFAULT_CODING_APPROVAL_SCOPE,
  DEFAULT_CODING_TOOL_ORDER,
  DEFAULT_MAX_CODING_TOOLS,
  DEFAULT_TOOL_OUTPUT_POLICY,
  defineCodingTool,
  deniedFeedback,
  effectsChangeAgentState,
  emptyToolSecurityFacts,
  errorResult,
  EXEC_COMMAND_PROMPT_SNIPPET,
  EXEC_OUTPUT_SCHEMA,
  FIND_FILES_DEFAULT_LIMIT,
  FIND_FILES_MAX_LIMIT,
  FIND_FILES_PROMPT_SNIPPET,
  GIT_DIFF_PROMPT_SNIPPET,
  GIT_STATUS_PROMPT_SNIPPET,
  GIT_TOOL_NAMES,
  humanizeToolName,
  LIST_DIRECTORY_DEFAULT_LIMIT,
  LIST_DIRECTORY_MAX_LIMIT,
  LIST_DIRECTORY_PROMPT_SNIPPET,
  MAX_CHANGED_FILES,
  MAX_FIND_PATTERN_BYTES,
  MAX_PROMPT_SNIPPET_BYTES,
  MAX_SEARCH_GLOB_BYTES,
  MAX_SEARCH_MATCH_CHARS,
  MAX_TOOL_PROMPT_TOTAL_BYTES,
  normalizeSchemaDeclaredNumericStrings,
  normalizeToolArgumentsForCompatibility,
  OPERATIONS_INTERFACE_NAMES,
  positiveBoundedInteger,
  projectApplyPatchSecurityFacts,
  projectExecCommandSecurityFacts,
  projectExecEffects,
  projectFindFilesSecurityFacts,
  projectGitDiffSecurityFacts,
  projectGitStatusSecurityFacts,
  projectListDirectorySecurityFacts,
  projectPatchEffects,
  projectReadFileEffect,
  projectReadFileSecurityFacts,
  projectSearchTextSecurityFacts,
  projectStdinEffects,
  projectWriteStdinSecurityFacts,
  promptSnippetFor,
  READ_FILE_DEFAULT_LIMIT,
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_LIMIT,
  READ_FILE_PROMPT_SNIPPET,
  READ_ONLY_OUTPUT_SCHEMA,
  resolveRuntimeWorkspace,
  runtimeErrorToResult,
  safeRuntimeMessage,
  SAFE_SHELL_COMMAND_LABEL,
  SEARCH_TEXT_DEFAULT_LIMIT,
  SEARCH_TEXT_MAX_LIMIT,
  SEARCH_TEXT_PROMPT_SNIPPET,
  successResult,
  toCanonicalToolResultLimits,
  toolEffectsToEvents,
  TOOL_OUTPUT_TRUNCATION_MARKER,
  ToolSecurityFactsProjectionError,
  withoutGitTools,
  WRITE_STDIN_PROMPT_SNIPPET,
} from "./tools/index.js";
export type {
  CodingReadOnlyOperations,
  CodingSettlementContext,
  CodingToolAdmissionPortOptions,
  CodingToolApprovalIdentityInput,
  CodingToolCatalog,
  CodingToolCatalogBuilderOptions,
  CodingToolCatalogErrorReason,
  CodingToolDefinition,
  CodingToolDefinitionInput,
  CodingToolEffectEventDraft,
  CodingToolEffectProjector,
  CodingToolOutputPolicy,
  CodingToolPathKind,
  CodingToolRegistration,
  CodingToolRuntimeRequirements,
  CodingToolSecurityFactsProjector,
  CodingToolSecurityMetadata,
  DefaultCodingToolOperations,
  GitToolAvailability,
  ExecOperations,
  FindFilesOperations,
  GitOperations,
  ListDirectoryOperations,
  PatchOperations,
  ProcessOperations,
  ReadFileOperations,
  RuntimeOperationsAll,
  RuntimeOperationsProcess,
  RuntimeOperationsReadOnly,
  CodingRuntimeProgressEnvelope,
  RuntimeProgressSignalProjector,
  RuntimeProgressSignalProjectorDependencies,
  RuntimeReadOnlyOperations,
  SearchTextOperations,
  ToolEffect,
  ToolEffectEventContext,
  ToolEffectProjector,
  ToolEffectProjectorInput,
  ToolPromptContextItem,
  ToolPromptContextProvider,
  ToolPromptContextProviderInput,
  ToolResourceAccess,
  ToolResourceOperation,
  ToolSecretScanInput,
  ToolSecurityFacts,
  ToolSecurityFactsProjector,
  ToolShellCommandFact,
} from "./tools/index.js";

export {
  createToolFeedbackContributionPipeline,
  createToolGuardPipeline,
  fingerprintPreparedToolArgs,
  projectSafeToolGuardFacts,
  DEFAULT_TOOL_FEEDBACK_CONTRIBUTION_BUDGET,
  MAX_TOOL_FEEDBACK_CONTRIBUTION_ID_BYTES,
  MAX_TOOL_FEEDBACK_CONTRIBUTION_TEXT_BYTES,
  MAX_TOOL_FEEDBACK_CONTRIBUTIONS_PER_HOOK,
  MAX_TOOL_GUARD_CODE_BYTES,
  MAX_TOOL_GUARD_REASON_BYTES,
  TOOL_FEEDBACK_SEPARATOR,
} from "./hooks/index.js";
export type {
  BeforeToolDispatchControlHook,
  BeforeToolDispatchHook,
  BeforeToolDispatchInput,
  BeforeToolDispatchRegistration,
  ToolFeedbackContribution,
  ToolFeedbackContributionBudget,
  ToolFeedbackContributionControlHook,
  ToolFeedbackContributionHook,
  ToolFeedbackContributionInput,
  ToolFeedbackContributionPipelineOptions,
  ToolFeedbackContributionPipelineResult,
  ToolFeedbackContributionPipeline,
  ToolFeedbackContributionRegistration,
  ToolGuardDecision,
  ToolGuardPipelineOptions,
  ToolGuardPipelineResult,
  ToolGuardPipeline,
  ToolGuardProjectionInput,
} from "./hooks/index.js";

export {
  CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1,
  CODING_COMMAND_EXECUTION_MESSAGE_PROJECTOR_V1,
  CODING_COMMAND_EXECUTION_TRANSCRIPT_PROJECTOR,
} from "./messages/command-execution.js";
export type { CodingCommandExecutionMessage } from "./messages/command-execution.js";
