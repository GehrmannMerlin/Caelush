import type { AIToolSpec } from "@caelush/ai";
import type { ToolName } from "@caelush/protocol";

import type { CompiledToolSchema } from "../schema/schema-runtime.js";
import type { AgentTool } from "../types/agent-tool.js";

/**
 * A registered Tool and the validators compiled for it at build time.
 *
 * ```text
 * tool             the executable contract
 * inputValidator   compiled from AgentTool.inputSchema
 * resultValidator  compiled from AgentTool.resultDetailsSchema
 * ```
 *
 * Three fields, and nothing else. In particular there is **no** security facts projector, effect
 * projector, presentation port, prompt snippet, risk level, capability list or runtime requirement
 * here: those are Coding overlay metadata and live in `@caelush/coding-agent`'s `CodingToolCatalog`,
 * keyed by the same `ToolName`. A registry that carried them would make the general Agent Tool Layer
 * know about Coding policy, and every consumer of one would receive the other.
 *
 * The validators are the same objects for the life of the registry: a caller cannot swap one out,
 * and a schema is never recompiled per invocation.
 */
export interface ResolvedAgentTool {
  readonly tool: AgentTool;
  readonly inputValidator: CompiledToolSchema;
  readonly resultValidator: CompiledToolSchema;
}

/**
 * The immutable, ordered Tool registry.
 *
 * ```text
 * size          how many Tools are active
 * has(name)     is this Tool registered
 * resolve(name) its AgentTool and compiled validators
 * names()       the registration order, stable for the life of the registry
 * modelSpecs()  exactly three fields per Tool, in registration order
 * ```
 *
 * ## Immutability is a contract, not a convention
 *
 * Prompt-cache stability, recovery determinism, approval identity stability, schema reproducibility
 * and trace reproducibility all depend on one Run's active registry not changing underneath it. The
 * registry therefore freezes:
 *
 * ```text
 * the registration order               a frozen array of names
 * the model specs                      frozen AIToolSpec objects with frozen schemas
 * the resolved entries                 frozen ResolvedAgentTool wrappers
 * write access to the maps             no API mutates them after build
 * ```
 *
 * `modelSpecs()` returns stored frozen objects rather than building new ones per call, so mutating
 * what it returned cannot change what it returns next, and two calls are the same objects.
 *
 * ## What `modelSpecs()` must never leak
 *
 * ```text
 * execute            prepareArguments   label
 * resultDetailsSchema                  executionMode
 * security           effects           presentation   promptSnippet
 * ```
 *
 * Only `name`, `description` and `inputSchema` travel to the AI Layer. Anything else would put
 * runtime metadata into a provider request.
 */
export interface AgentToolRegistry {
  readonly size: number;
  has(name: ToolName): boolean;
  resolve(name: ToolName): ResolvedAgentTool | undefined;
  names(): readonly ToolName[];
  modelSpecs(): readonly AIToolSpec[];
}

/** The immutable implementation. Constructed by `AgentToolRegistryBuilder`. */
export class ImmutableAgentToolRegistry implements AgentToolRegistry {
  readonly #byName: ReadonlyMap<ToolName, ResolvedAgentTool>;
  readonly #orderedNames: readonly ToolName[];
  readonly #orderedSpecs: readonly AIToolSpec[];

  constructor(
    entries: readonly { readonly spec: AIToolSpec; readonly resolved: ResolvedAgentTool }[],
  ) {
    const byName = new Map<ToolName, ResolvedAgentTool>();
    const orderedNames: ToolName[] = [];
    const orderedSpecs: AIToolSpec[] = [];
    for (const entry of entries) {
      const name = entry.resolved.tool.name;
      byName.set(name, entry.resolved);
      orderedNames.push(name);
      orderedSpecs.push(entry.spec);
    }
    this.#byName = byName;
    this.#orderedNames = Object.freeze(orderedNames);
    this.#orderedSpecs = Object.freeze(orderedSpecs);
  }

  get size(): number {
    return this.#orderedNames.length;
  }

  has(name: ToolName): boolean {
    return this.#byName.has(name);
  }

  resolve(name: ToolName): ResolvedAgentTool | undefined {
    return this.#byName.get(name);
  }

  names(): readonly ToolName[] {
    return this.#orderedNames;
  }

  modelSpecs(): readonly AIToolSpec[] {
    return this.#orderedSpecs;
  }
}
