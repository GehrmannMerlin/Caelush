/**
 * `@caelush/coding-agent/tools` — the Coding overlay for the Agent Tool framework.
 *
 * ```text
 * @caelush/agent          AgentTool, AgentToolRegistry, ToolCallPreparer, schema runtime
 * @caelush/coding-agent   CodingToolDefinition, CodingToolCatalog, security metadata
 * ```
 *
 * The overlay adds what a Coding product knows and a general kernel must not: risk level, required
 * capabilities, runtime requirements, security facts projection, effect projection, presentation and
 * prompt snippets — all keyed by the same `ToolName` the registry resolves.
 *
 * Phase 4A establishes the contracts and the catalog. It does not move the nine built-in Tools, their
 * Operations interfaces or their projectors: those follow in Phase 4E.
 */
export type {
  CodingToolEffectProjector,
  CodingToolSecurityFactsProjector,
  CodingToolSecurityMetadata,
} from "./security-metadata.js";
export type { CodingToolDefinition, CodingToolRegistration } from "./coding-tool-definition.js";
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
export {
  createLegacyNumericArgumentNormalization,
  normalizeSchemaDeclaredNumericStrings,
  normalizeToolArgumentsForCompatibility,
} from "./legacy-argument-normalization.js";
