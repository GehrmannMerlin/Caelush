import type { ToolDefinition, ToolName } from "@caelush/protocol";
import type { AgentTool, AgentToolRegistry } from "@caelush/agent";

import type { ToolHandler } from "./handler.js";
import type { CompiledToolSchema } from "./schema-policy.js";
import type { ToolEffectProjector } from "./tool-effects.js";
import type { ToolSecurityFactsProjector } from "./security-facts.js";
import type { ToolModelGuidance } from "./model-guidance.js";
import type { ClassifiedCodingMetadata } from "./tool-adapters.js";
import type { RegistrationCodingOverlay } from "./registration.js";

/**
 * A resolved legacy Tool.
 *
 * The same seven fields a caller already reads, now populated from the canonical registry:
 *
 * ```text
 * definition               the legacy data description, preserved field for field
 * handler                  the legacy handler
 * inputValidator           the canonical compiled input validator
 * outputValidator          the canonical compiled result validator
 * effectProjector          Coding overlay metadata
 * securityFactsProjector   Coding overlay metadata
 * modelGuidance            Coding overlay metadata
 * ```
 *
 * `agentTool` is the canonical entry this view was projected from. It is the link that lets a legacy
 * caller (and the environment filter) reach the canonical Tool without re-deriving it, and it is how
 * the Coding overlay stays aligned with the registry instead of drifting beside it.
 *
 * ## `coding` carries whichever overlay the registration supplied
 *
 * A Phase 4E builtin facade registers a whole `CodingToolDefinition`, so `coding` *is* the target's own
 * overlay — its projectors, its risk metadata and its prompt snippet included. A hand-written
 * registration carries the narrower `LegacyCodingToolMetadata`. Both are the same field, because both
 * are what the catalog build needs; a reader that wants one shape narrows it rather than the registry
 * keeping two.
 */
export interface ResolvedTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
  readonly inputValidator: CompiledToolSchema;
  readonly outputValidator: CompiledToolSchema;
  readonly effectProjector?: ToolEffectProjector;
  readonly securityFactsProjector?: ToolSecurityFactsProjector;
  readonly modelGuidance?: ToolModelGuidance;
  /** The canonical AgentTool and compiled validators this legacy view mirrors. */
  readonly agentTool?: AgentTool | undefined;
  /** The Coding overlay metadata, before it is projected into a `CodingToolDefinition`. */
  readonly coding?: RegistrationCodingOverlay | undefined;
  /**
   * The Coding overlay read as the legacy seven-field view.
   *
   * A registration may carry either overlay shape — a whole `CodingToolDefinition` from a Phase 4E
   * builtin facade, or the narrower `LegacyCodingToolMetadata` from a hand-written one — and a reader
   * that wants the *metadata* rather than the overlay should not have to branch. This is that reading,
   * produced once at build time by the same classifier the registry builder uses.
   *
   * It is derived, never independent: both fields describe one object, so `codingMetadata.riskLevel`
   * and the Coding catalog entry for the same Tool cannot disagree.
   */
  readonly codingMetadata?: ClassifiedCodingMetadata | undefined;
}

/**
 * The legacy Tool registry facade.
 *
 * It is immutable and ordered like the canonical `AgentToolRegistry` it wraps, and it answers the
 * legacy questions a caller already asks:
 *
 * ```text
 * size
 * has(name)
 * resolve(name)            -> ResolvedTool
 * modelDefinitions()       -> ToolDefinition[]
 * modelGuidance()          -> ToolModelGuidance[]
 * names()                  -> ToolName[]
 * agentRegistry()          -> the canonical registry behind it
 * ```
 *
 * It owns no registry logic. Duplicate detection, the tool limit, ordering and immutability are the
 * canonical builder's; this type only projects the canonical entries back into legacy shapes.
 */
export interface ToolRegistry {
  readonly size: number;
  has(name: ToolName): boolean;
  resolve(name: ToolName): ResolvedTool | undefined;
  modelDefinitions(): readonly ToolDefinition[];
  modelGuidance(): readonly ToolModelGuidance[];
  names(): readonly ToolName[];
  /** The canonical registry this facade delegates to. */
  agentRegistry(): AgentToolRegistry;
}

class ImmutableToolRegistry implements ToolRegistry {
  private readonly byName: ReadonlyMap<ToolName, ResolvedTool>;
  private readonly orderedNames: readonly ToolName[];
  private readonly orderedDefinitions: readonly ToolDefinition[];
  private readonly orderedGuidance: readonly ToolModelGuidance[];

  constructor(
    resolvedTools: readonly ResolvedTool[],
    private readonly canonical: AgentToolRegistry,
  ) {
    const byName = new Map<ToolName, ResolvedTool>();
    const orderedNames: ToolName[] = [];
    const orderedDefinitions: ToolDefinition[] = [];
    const orderedGuidance: ToolModelGuidance[] = [];
    for (const resolved of resolvedTools) {
      byName.set(resolved.definition.name, Object.freeze(resolved));
      orderedNames.push(resolved.definition.name);
      orderedDefinitions.push(resolved.definition);
      if (resolved.modelGuidance !== undefined) orderedGuidance.push(resolved.modelGuidance);
    }
    this.byName = byName;
    this.orderedNames = Object.freeze(orderedNames);
    this.orderedDefinitions = Object.freeze(orderedDefinitions);
    this.orderedGuidance = Object.freeze(orderedGuidance);
  }

  get size(): number {
    return this.orderedNames.length;
  }

  has(name: ToolName): boolean {
    return this.byName.has(name);
  }

  resolve(name: ToolName): ResolvedTool | undefined {
    return this.byName.get(name);
  }

  modelDefinitions(): readonly ToolDefinition[] {
    return this.orderedDefinitions;
  }

  names(): readonly ToolName[] {
    return this.orderedNames;
  }

  modelGuidance(): readonly ToolModelGuidance[] {
    return this.orderedGuidance;
  }

  agentRegistry(): AgentToolRegistry {
    return this.canonical;
  }
}

export function createToolRegistry(
  resolvedTools: readonly ResolvedTool[],
  canonical: AgentToolRegistry,
): ToolRegistry {
  return new ImmutableToolRegistry(resolvedTools, canonical);
}
