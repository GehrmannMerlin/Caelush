/**
 * `@caelush/coding-agent/tools` — the Coding Tool product layer.
 *
 * ```text
 * @caelush/agent          AgentTool, AgentToolRegistry, ToolCallPreparer, canonical Tool pipeline
 * @caelush/coding-agent   the nine Coding builtins, their narrow Operations ports, Runtime adapters,
 *                         security metadata and facts, approval identity, effects, presentation and
 *                         prompt snippets
 * ```
 *
 * Phase 4E moved the Coding Tool *business authority* here. The nine builtins, the default order, the
 * Operations ports, the Runtime adapters, the security facts, the effects and the prompt snippets are
 * this package's; `@caelush/tools` keeps compatibility facades that delegate here and owns no algorithm
 * of its own.
 *
 * The dependency direction is one-way and permanent:
 *
 * ```text
 * @caelush/tools  ──delegates──▶  @caelush/coding-agent  ──▶  @caelush/agent  ──▶  @caelush/ai
 * ```
 */

/* The Coding overlay contracts. */
export type {
  CodingToolEffectProjector,
  CodingToolSecurityFactsProjector,
  CodingToolSecurityMetadata,
} from "./security-metadata.js";
export type {
  CodingToolDefinition,
  CodingToolRegistration,
  CodingToolRuntimeRequirements,
} from "./coding-tool-definition.js";
export {
  CodingToolCatalogError,
  type CodingToolCatalog,
  type CodingToolCatalogErrorReason,
} from "./coding-tool-catalog.js";
export {
  CodingToolCatalogBuilder,
  CODING_TOOL_CATALOG_ERROR_REASONS,
  createCodingToolCatalog,
  DEFAULT_MAX_CODING_TOOLS,
} from "./coding-tool-catalog-builder.js";
export type { CodingToolCatalogBuilderOptions } from "./coding-tool-catalog-builder.js";

/* The one compatibility normalization, so a builtin never grows a second copy of it. */
export {
  createLegacyNumericArgumentNormalization,
  normalizeSchemaDeclaredNumericStrings,
  normalizeToolArgumentsForCompatibility,
} from "./legacy-argument-normalization.js";

/* The narrow Operations ports and their Runtime adapters. */
export { OPERATIONS_INTERFACE_NAMES } from "./operations/operations.js";
export type {
  ExecOperations,
  FindFilesOperations,
  GitOperations,
  ListDirectoryOperations,
  PatchOperations,
  ProcessOperations,
  ReadFileOperations,
  SearchTextOperations,
} from "./operations/operations.js";
export {
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  READ_FILE_MAX_BYTES,
  resolveRuntimeWorkspace,
} from "./operations/runtime-adapters/index.js";
export type {
  RuntimeOperationsAll,
  RuntimeOperationsProcess,
  RuntimeOperationsReadOnly,
} from "./operations/runtime-adapters/index.js";
export type { RuntimeReadOnlyOperations } from "./operations/runtime-adapters/runtime-read-only-operations.js";
export type {
  CodingReadOnlyOperations,
  CodingToolPathKind,
} from "./operations/coding-read-only-operations.js";

/* The nine builtins and the default set. */
export { createReadFileTool, readFileInputSchema } from "./builtins/read-file.js";
export { createListDirectoryTool, listDirectoryInputSchema } from "./builtins/list-directory.js";
export { createFindFilesTool, findFilesInputSchema } from "./builtins/find-files.js";
export { createSearchTextTool, searchTextInputSchema } from "./builtins/search-text.js";
export { createApplyPatchTool, applyPatchInputSchema } from "./builtins/apply-patch.js";
export { createExecCommandTool, execCommandInputSchema } from "./builtins/exec-command.js";
export { createWriteStdinTool, writeStdinInputSchema } from "./builtins/write-stdin.js";
export { createGitStatusTool, gitStatusInputSchema } from "./builtins/git-status.js";
export { createGitDiffTool, gitDiffInputSchema } from "./builtins/git-diff.js";
export {
  createDefaultCodingTools,
  DEFAULT_CODING_TOOL_ORDER,
  GIT_TOOL_NAMES,
  withoutGitTools,
} from "./builtins/default-tools.js";
export type { DefaultCodingToolOperations } from "./builtins/default-tools.js";
export { defineCodingTool, humanizeToolName } from "./builtins/define-coding-tool.js";
export { asOverlayEffectProjector, asOverlaySecurityFactsProjector } from "./builtins/result.js";
export type { CodingToolDefinitionInput } from "./builtins/define-coding-tool.js";

/* The Coding builtin result helpers and bounds. */
export {
  errorResult,
  EXEC_OUTPUT_SCHEMA,
  FIND_FILES_DEFAULT_LIMIT,
  FIND_FILES_MAX_LIMIT,
  LIST_DIRECTORY_DEFAULT_LIMIT,
  LIST_DIRECTORY_MAX_LIMIT,
  MAX_FIND_PATTERN_BYTES,
  MAX_SEARCH_GLOB_BYTES,
  MAX_SEARCH_MATCH_CHARS,
  positiveBoundedInteger,
  READ_FILE_DEFAULT_LIMIT,
  READ_FILE_MAX_LIMIT,
  READ_ONLY_OUTPUT_SCHEMA,
  runtimeErrorToResult,
  safeRuntimeMessage,
  SEARCH_TEXT_DEFAULT_LIMIT,
  SEARCH_TEXT_MAX_LIMIT,
  successResult,
} from "./builtins/result.js";

/* The Coding output policy. */
export {
  boundToolModelContent,
  DEFAULT_TOOL_OUTPUT_POLICY,
  TOOL_OUTPUT_TRUNCATION_MARKER,
  toCanonicalToolResultLimits,
} from "./output/output-policy.js";
export type { CodingToolOutputPolicy } from "./output/output-policy.js";

/* Coding security: the facts vocabulary, the per-Tool projectors and the approval identity. */
export {
  assertToolSecurityFactsProjector,
  emptyToolSecurityFacts,
  projectApplyPatchSecurityFacts,
  projectExecCommandSecurityFacts,
  projectFindFilesSecurityFacts,
  projectGitDiffSecurityFacts,
  projectGitStatusSecurityFacts,
  projectListDirectorySecurityFacts,
  projectReadFileSecurityFacts,
  projectSearchTextSecurityFacts,
  projectWriteStdinSecurityFacts,
  ToolSecurityFactsProjectionError,
} from "./security/security-facts.js";
export type {
  ToolResourceAccess,
  ToolResourceOperation,
  ToolSecretScanInput,
  ToolSecurityFacts,
  ToolSecurityFactsProjector,
  ToolShellCommandFact,
} from "./security/security-facts.js";
export { computeCodingToolApprovalKey } from "./security/approval-identity.js";
export type { CodingToolApprovalIdentityInput } from "./security/approval-identity.js";

/* Coding effects: the vocabulary and its three projections. */
export {
  CODING_TOOL_EFFECTS_PAYLOAD_KIND,
  codingToolEffectsPayload,
  effectsChangeAgentState,
  MAX_CHANGED_FILES,
  SAFE_SHELL_COMMAND_LABEL,
} from "./effects/effects.js";
export type { ToolEffect } from "./effects/effects.js";
export {
  projectExecEffects,
  projectPatchEffects,
  projectReadFileEffect,
  projectStdinEffects,
} from "./effects/effect-projectors.js";
export type { ToolEffectProjector, ToolEffectProjectorInput } from "./effects/effect-projectors.js";
export { applyToolEffectsToAgentState } from "./effects/state-projector.js";
export { toolEffectsToEvents } from "./effects/event-projector.js";
export type {
  CodingToolEffectEventDraft,
  ToolEffectEventContext,
} from "./effects/event-projector.js";

/* Prompt snippets and the prompt context provider. */
export {
  APPLY_PATCH_PROMPT_SNIPPET,
  CODING_TOOL_PROMPT_SNIPPETS,
  EXEC_COMMAND_PROMPT_SNIPPET,
  FIND_FILES_PROMPT_SNIPPET,
  GIT_DIFF_PROMPT_SNIPPET,
  GIT_STATUS_PROMPT_SNIPPET,
  LIST_DIRECTORY_PROMPT_SNIPPET,
  MAX_PROMPT_SNIPPET_BYTES,
  MAX_TOOL_PROMPT_TOTAL_BYTES,
  promptSnippetFor,
  READ_FILE_PROMPT_SNIPPET,
  SEARCH_TEXT_PROMPT_SNIPPET,
  WRITE_STDIN_PROMPT_SNIPPET,
} from "./prompt/prompt-snippets.js";
export { createToolPromptContextProvider } from "./prompt/tool-prompt-context-provider.js";
export type {
  ToolPromptContextItem,
  ToolPromptContextProvider,
  ToolPromptContextProviderInput,
} from "./prompt/tool-prompt-context-provider.js";
