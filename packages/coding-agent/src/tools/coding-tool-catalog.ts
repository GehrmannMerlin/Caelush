import type { ToolName } from "@caelush/protocol";

import type { CodingToolDefinition } from "./coding-tool-definition.js";

/** Why a Coding Tool entry was refused. */
export type CodingToolCatalogErrorReason =
  | "INVALID_CODING_TOOL"
  | "DUPLICATE_CODING_TOOL"
  | "DANGLING_CODING_TOOL"
  | "CODING_TOOL_LIMIT_EXCEEDED"
  | "CATALOG_BUILDER_FINALIZED";

/** A Coding Tool overlay could not be defined or aligned with the active registry. */
export class CodingToolCatalogError extends Error {
  readonly reason: CodingToolCatalogErrorReason;
  readonly toolName: ToolName | undefined;

  constructor(
    message: string,
    metadata: {
      readonly reason: CodingToolCatalogErrorReason;
      readonly toolName?: ToolName | undefined;
    },
  ) {
    super(message);
    this.name = "CodingToolCatalogError";
    this.reason = metadata.reason;
    this.toolName = metadata.toolName;
  }
}

/**
 * The Coding overlay, keyed by `ToolName`.
 *
 * ```text
 * has(name)    is there Coding metadata for this Tool
 * get(name)    the CodingToolDefinition for this Tool
 * names()      the overlay's own stable order
 * size         how many Tools have Coding metadata
 * ```
 *
 * ## Correspondence with the Agent registry
 *
 * ```text
 * every name in the catalog must exist in the active AgentToolRegistry
 * not every name in the registry must exist in the catalog
 * ```
 *
 * The second line is the one that matters for a general kernel: a purely generic `AgentTool` — an
 * echo tool, an MCP tool, a plugin tool — is a first-class registered Tool with **no** Coding
 * metadata. The catalog is an overlay, not a mirror, and `get()` returning `undefined` is a normal
 * answer rather than an error.
 *
 * The first line is what the builder enforces when it is given the registry it must correspond to: a
 * Coding entry whose Tool is not registered is a dangling overlay, and a dangling overlay is either
 * a typo or a filtered registry that forgot its catalog. Both fail closed at build.
 *
 * ## What the catalog never does
 *
 * It executes no Security policy, performs no Runtime operation, projects no effect and renders
 * nothing. It holds functions and data; the components that own those stages call them.
 */
export interface CodingToolCatalog {
  readonly size: number;
  has(name: ToolName): boolean;
  get(name: ToolName): CodingToolDefinition | undefined;
  names(): readonly ToolName[];
}
