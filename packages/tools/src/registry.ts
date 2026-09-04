import type { ToolDefinition, ToolName } from "@caelush/protocol";
import type { ToolHandler } from "./handler.js";
import type { CompiledToolSchema } from "./schema-runtime.js";
import type { ToolEffectProjector } from "./tool-effects.js";
import type { ToolSecurityFactsProjector } from "./security-facts.js";
import type { ToolModelGuidance } from "./model-guidance.js";

export interface ResolvedTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
  readonly inputValidator: CompiledToolSchema;
  readonly outputValidator: CompiledToolSchema;
  readonly effectProjector?: ToolEffectProjector;
  readonly securityFactsProjector?: ToolSecurityFactsProjector;
  readonly modelGuidance?: ToolModelGuidance;
}

export interface ToolRegistry {
  readonly size: number;
  has(name: ToolName): boolean;
  resolve(name: ToolName): ResolvedTool | undefined;
  modelDefinitions(): readonly ToolDefinition[];
  modelGuidance(): readonly ToolModelGuidance[];
  names(): readonly ToolName[];
}

class ImmutableToolRegistry implements ToolRegistry {
  private readonly byName: ReadonlyMap<ToolName, ResolvedTool>;
  private readonly orderedNames: readonly ToolName[];
  private readonly orderedDefinitions: readonly ToolDefinition[];
  private readonly orderedGuidance: readonly ToolModelGuidance[];

  constructor(resolvedTools: readonly ResolvedTool[]) {
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
}

export function createToolRegistry(resolvedTools: readonly ResolvedTool[]): ToolRegistry {
  return new ImmutableToolRegistry(resolvedTools);
}
