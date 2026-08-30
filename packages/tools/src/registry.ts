import type { ToolDefinition, ToolName } from "@caelush/protocol";
import type { ToolHandler } from "./handler.js";
import type { CompiledToolSchema } from "./schema-runtime.js";
import type { ToolEffectProjector } from "./tool-effects.js";

export interface ResolvedTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
  readonly inputValidator: CompiledToolSchema;
  readonly outputValidator: CompiledToolSchema;
  readonly effectProjector?: ToolEffectProjector;
}

export interface ToolRegistry {
  readonly size: number;
  has(name: ToolName): boolean;
  resolve(name: ToolName): ResolvedTool | undefined;
  modelDefinitions(): readonly ToolDefinition[];
  names(): readonly ToolName[];
}

class ImmutableToolRegistry implements ToolRegistry {
  private readonly byName: ReadonlyMap<ToolName, ResolvedTool>;
  private readonly orderedNames: readonly ToolName[];
  private readonly orderedDefinitions: readonly ToolDefinition[];

  constructor(resolvedTools: readonly ResolvedTool[]) {
    const byName = new Map<ToolName, ResolvedTool>();
    const orderedNames: ToolName[] = [];
    const orderedDefinitions: ToolDefinition[] = [];
    for (const resolved of resolvedTools) {
      byName.set(resolved.definition.name, Object.freeze(resolved));
      orderedNames.push(resolved.definition.name);
      orderedDefinitions.push(resolved.definition);
    }
    this.byName = byName;
    this.orderedNames = Object.freeze(orderedNames);
    this.orderedDefinitions = Object.freeze(orderedDefinitions);
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
}

export function createToolRegistry(resolvedTools: readonly ResolvedTool[]): ToolRegistry {
  return new ImmutableToolRegistry(resolvedTools);
}
