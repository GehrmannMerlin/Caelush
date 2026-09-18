import type { AgentToolRegistry } from "@caelush/agent";
import type { ToolName } from "@caelush/protocol";

import {
  CodingToolCatalogError,
  type CodingToolCatalog,
  type CodingToolCatalogErrorReason,
} from "./coding-tool-catalog.js";
import type { CodingToolDefinition } from "./coding-tool-definition.js";

/** The overlay size limit, mirroring the Agent registry's own tool limit. */
export const DEFAULT_MAX_CODING_TOOLS = 64;

export interface CodingToolCatalogBuilderOptions {
  readonly maxTools?: number | undefined;
}

/**
 * Builds one immutable `CodingToolCatalog`.
 *
 * ```text
 * register(definition)   validate the overlay entry, reject duplicate names
 * forRegistry(registry)  declare which AgentToolRegistry this overlay must correspond to
 * build()                reject dangling entries, freeze everything, finalize
 * ```
 *
 * `forRegistry` is the alignment step. When a builder has been told which registry it belongs to,
 * `build()` refuses any entry whose `ToolName` is not registered there: a Coding overlay that names
 * a Tool the registry cannot execute would make Security metadata describe a call that can never
 * happen, and — worse — could let a filtered registry silently drop a Tool while its metadata
 * remained, inviting a later reader to re-register it without its policy.
 *
 * A builder that was never given a registry builds an unaligned overlay. That is legitimate for a
 * standalone consumer that only wants the definitions, and it makes no correspondence claim.
 *
 * The entries themselves are copied and frozen. A caller that keeps its own reference to a
 * definition object cannot change a built catalog by mutating it, and `names()` returns the same
 * frozen array every time.
 */
export class CodingToolCatalogBuilder {
  readonly #definitions: CodingToolDefinition[] = [];
  readonly #names = new Set<ToolName>();
  readonly #maxTools: number;
  #registry: AgentToolRegistry | undefined;
  #finalized = false;
  #builtCatalog: CodingToolCatalog | undefined;

  constructor(options: CodingToolCatalogBuilderOptions = {}) {
    const maxTools = options.maxTools ?? DEFAULT_MAX_CODING_TOOLS;
    if (!Number.isSafeInteger(maxTools) || maxTools <= 0) {
      throw new CodingToolCatalogError("Coding Tool catalog limit must be a positive integer.", {
        reason: "INVALID_CODING_TOOL",
      });
    }
    this.#maxTools = maxTools;
  }

  forRegistry(registry: AgentToolRegistry): this {
    this.#registry = registry;
    return this;
  }

  register(definition: CodingToolDefinition): this {
    if (this.#finalized) {
      throw new CodingToolCatalogError("Coding Tool catalog builder is already finalized.", {
        reason: "CATALOG_BUILDER_FINALIZED",
      });
    }
    const name = readCodingToolName(definition);
    if (this.#names.has(name)) {
      throw new CodingToolCatalogError(`Coding Tool "${name}" is already registered.`, {
        reason: "DUPLICATE_CODING_TOOL",
        toolName: name,
      });
    }
    if (this.#definitions.length >= this.#maxTools) {
      throw new CodingToolCatalogError("Coding Tool catalog limit exceeded.", {
        reason: "CODING_TOOL_LIMIT_EXCEEDED",
      });
    }
    this.#names.add(name);
    this.#definitions.push(copyDefinition(definition));
    return this;
  }

  build(): CodingToolCatalog {
    if (this.#builtCatalog !== undefined) return this.#builtCatalog;

    const registry = this.#registry;
    if (registry !== undefined) {
      for (const definition of this.#definitions) {
        const name = definition.tool.name;
        if (!registry.has(name)) {
          throw new CodingToolCatalogError(
            `Coding Tool "${name}" has no entry in the active Agent tool registry.`,
            { reason: "DANGLING_CODING_TOOL", toolName: name },
          );
        }
      }
    }

    const byName = new Map<ToolName, CodingToolDefinition>();
    const orderedNames: ToolName[] = [];
    for (const definition of this.#definitions) {
      byName.set(definition.tool.name, definition);
      orderedNames.push(definition.tool.name);
    }

    this.#builtCatalog = new ImmutableCodingToolCatalog(byName, Object.freeze(orderedNames));
    this.#finalized = true;
    return this.#builtCatalog;
  }
}

class ImmutableCodingToolCatalog implements CodingToolCatalog {
  readonly #byName: ReadonlyMap<ToolName, CodingToolDefinition>;
  readonly #orderedNames: readonly ToolName[];

  constructor(
    byName: ReadonlyMap<ToolName, CodingToolDefinition>,
    orderedNames: readonly ToolName[],
  ) {
    this.#byName = byName;
    this.#orderedNames = orderedNames;
  }

  get size(): number {
    return this.#orderedNames.length;
  }

  has(name: ToolName): boolean {
    return this.#byName.has(name);
  }

  get(name: ToolName): CodingToolDefinition | undefined {
    return this.#byName.get(name);
  }

  names(): readonly ToolName[] {
    return this.#orderedNames;
  }
}

function copyDefinition(definition: CodingToolDefinition): CodingToolDefinition {
  return Object.freeze({
    tool: definition.tool,
    security: Object.freeze({
      riskLevel: definition.security.riskLevel,
      requiredCapabilities: Object.freeze([...definition.security.requiredCapabilities]),
      runtimeRequirements: definition.security.runtimeRequirements,
    }),
    ...(definition.securityFactsProjector === undefined
      ? {}
      : { securityFactsProjector: definition.securityFactsProjector }),
    ...(definition.effectProjector === undefined
      ? {}
      : { effectProjector: definition.effectProjector }),
    ...(definition.presentation === undefined ? {} : { presentation: definition.presentation }),
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
  });
}

function readCodingToolName(definition: CodingToolDefinition): ToolName {
  const tool: unknown = definition?.tool;
  const candidate =
    tool !== null && typeof tool === "object"
      ? (tool as { readonly name?: unknown; readonly execute?: unknown })
      : undefined;
  if (
    definition === null ||
    typeof definition !== "object" ||
    candidate === undefined ||
    typeof candidate.name !== "string" ||
    typeof candidate.execute !== "function" ||
    definition.security === null ||
    typeof definition.security !== "object"
  ) {
    throw new CodingToolCatalogError("Coding Tool definition is invalid.", {
      reason: "INVALID_CODING_TOOL",
    });
  }
  return candidate.name as ToolName;
}

/** The reasons a catalog build can be refused. Exported for consumers that classify the failure. */
export const CODING_TOOL_CATALOG_ERROR_REASONS = [
  "INVALID_CODING_TOOL",
  "DUPLICATE_CODING_TOOL",
  "DANGLING_CODING_TOOL",
  "CODING_TOOL_LIMIT_EXCEEDED",
  "CATALOG_BUILDER_FINALIZED",
] as const satisfies readonly CodingToolCatalogErrorReason[];

/** Create a catalog from definitions in one call. */
export function createCodingToolCatalog(input: {
  readonly registry: AgentToolRegistry;
  readonly definitions: readonly CodingToolDefinition[];
  readonly maxTools?: number | undefined;
}): CodingToolCatalog {
  const builder = new CodingToolCatalogBuilder(
    input.maxTools === undefined ? {} : { maxTools: input.maxTools },
  ).forRegistry(input.registry);
  for (const definition of input.definitions) builder.register(definition);
  return builder.build();
}
