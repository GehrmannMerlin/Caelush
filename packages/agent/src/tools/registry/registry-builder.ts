import { ToolNameSchema, type ToolName } from "@caelush/protocol";

import { AgentToolRegistrationError, AgentToolRegistryStateError } from "../types/errors.js";
import type { AgentTool } from "../types/agent-tool.js";
import { cloneJsonValue, deepFreezeJson } from "../schema/json-canonical.js";
import {
  DEFAULT_TOOL_REGISTRY_OPTIONS,
  toolModelSpecByteLength,
  validateToolRegistryOptions,
  validateToolSchemaSemantics,
  type ToolRegistryOptions,
} from "../schema/schema-policy.js";
import type { AIToolSpec } from "@caelush/ai";
import { ToolSchemaRuntime } from "../schema/schema-runtime.js";
import {
  ImmutableAgentToolRegistry,
  type AgentToolRegistry,
  type ResolvedAgentTool,
} from "./registry.js";

/**
 * Builds one immutable `AgentToolRegistry`.
 *
 * ```text
 * register(tool)             validate the definition, reject duplicates, enforce the Tool count limit
 * build(runtime?)            compile both schemas, enforce budgets, freeze everything, finalize
 * buildSchemaRuntime()       the compiler this builder's schemas will be compiled with
 * ```
 *
 * ## What registration preserves
 *
 * ```text
 * duplicate name rejection     a duplicate is a configuration error, never a silent overwrite
 * tool count limit             maxTools
 * schema compilation           once per Tool, at build
 * schema semantic validation   object root, closed object, no external $ref, no $async
 * byte limits                  description, inputSchema, resultDetailsSchema, catalog
 * stable registration order    the model sees Tools in the order they were registered
 * immutable built registry     nothing mutates it afterwards
 * ```
 *
 * ## Copies, not references
 *
 * A Tool's `name`, `description`, `inputSchema` and `resultDetailsSchema` are deep-copied and frozen
 * at registration. A caller that keeps a reference to the object it registered — or to one of its
 * schemas — cannot change an already-built registry by mutating it. This is the same guarantee the
 * legacy registry made, kept because approval identity, prompt caching and recovery all depend on
 * it.
 *
 * ## Build is once
 *
 * `build()` is idempotent: a second call returns the same registry rather than recompiling. A
 * `register()` after a successful `build()` throws `BUILDER_FINALIZED`. Both behaviours are explicit
 * and testable rather than emergent.
 */
export interface AgentToolRegistryBuilder {
  register(tool: AgentTool): this;
  build(runtime?: ToolSchemaRuntime): AgentToolRegistry;
}

export class DefaultAgentToolRegistryBuilder implements AgentToolRegistryBuilder {
  readonly #options: ToolRegistryOptions;
  readonly #registrations: { readonly tool: AgentTool; readonly spec: AIToolSpec }[] = [];
  readonly #names = new Set<ToolName>();
  readonly #schemaRuntime = new ToolSchemaRuntime();
  #finalized = false;
  #builtRegistry: AgentToolRegistry | undefined;

  constructor(options: ToolRegistryOptions = DEFAULT_TOOL_REGISTRY_OPTIONS) {
    validateToolRegistryOptions(options);
    this.#options = Object.freeze({ ...options });
  }

  /**
   * The compiler this builder compiles with.
   *
   * A caller that must validate the same schemas outside the registry — a legacy caller projecting a
   * `CompiledToolSchema` for a `ToolPreflight`, for instance — asks for it here rather than creating a
   * second runtime, so there is one compiler and one compiled schema per Tool.
   */
  buildSchemaRuntime(): ToolSchemaRuntime {
    return this.#schemaRuntime;
  }

  register(tool: AgentTool): this {
    if (this.#finalized) {
      throw new AgentToolRegistryStateError("Tool registry builder is already finalized.", {
        reason: "BUILDER_FINALIZED",
      });
    }

    const name = readToolName(tool);
    if (this.#names.has(name)) {
      throw new AgentToolRegistrationError(`Tool "${name}" is already registered.`, {
        reason: "DUPLICATE_TOOL_NAME",
        toolName: name,
      });
    }
    if (this.#registrations.length >= this.#options.maxTools) {
      throw new AgentToolRegistrationError("Tool registry tool limit exceeded.", {
        reason: "TOOL_LIMIT_EXCEEDED",
      });
    }

    const clonedSchema = deepFreezeJson(cloneJsonValue(tool.inputSchema));
    const spec: AIToolSpec = Object.freeze({
      name,
      description: tool.description,
      inputSchema: clonedSchema,
    });
    const clonedTool: AgentTool = Object.freeze({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      label: tool.label,
      resultDetailsSchema: deepFreezeJson(cloneJsonValue(tool.resultDetailsSchema)),
      executionMode: tool.executionMode,
      ...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
      execute: tool.execute,
    });

    this.#names.add(name);
    this.#registrations.push({ tool: clonedTool, spec });
    return this;
  }

  build(runtime?: ToolSchemaRuntime): AgentToolRegistry {
    if (this.#builtRegistry !== undefined) return this.#builtRegistry;

    const schemaRuntime = runtime ?? this.#schemaRuntime;
    const entries: { readonly spec: AIToolSpec; readonly resolved: ResolvedAgentTool }[] = [];
    let catalogBytes = 0;
    for (const registration of this.#registrations) {
      const validators = validateToolSchemaSemantics(
        {
          name: registration.spec.name,
          description: registration.spec.description,
          inputSchema: registration.spec.inputSchema,
        },
        registration.tool.resultDetailsSchema,
        this.#options,
        schemaRuntime,
      );
      catalogBytes += toolModelSpecByteLength({
        name: registration.spec.name,
        description: registration.spec.description,
        inputSchema: registration.spec.inputSchema,
      });
      if (catalogBytes > this.#options.maxCatalogBytes) {
        throw new AgentToolRegistrationError("Tool model catalog exceeds its byte budget.", {
          reason: "TOOL_CATALOG_TOO_LARGE",
        });
      }
      entries.push({
        spec: registration.spec,
        resolved: Object.freeze({
          tool: registration.tool,
          inputValidator: validators.input,
          resultValidator: validators.result,
        }),
      });
    }

    this.#builtRegistry = new ImmutableAgentToolRegistry(entries);
    this.#finalized = true;
    return this.#builtRegistry;
  }
}

function readToolName(tool: AgentTool): ToolName {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    throw new AgentToolRegistrationError("Tool registration is invalid.", {
      reason: "INVALID_DEFINITION",
    });
  }
  const parsed = ToolNameSchema.safeParse((tool as { readonly name?: unknown }).name);
  if (
    !parsed.success ||
    typeof tool.description !== "string" ||
    typeof tool.label !== "string" ||
    typeof tool.execute !== "function" ||
    tool.inputSchema === null ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema) ||
    tool.resultDetailsSchema === null ||
    typeof tool.resultDetailsSchema !== "object" ||
    Array.isArray(tool.resultDetailsSchema)
  ) {
    throw new AgentToolRegistrationError("Tool registration is invalid.", {
      reason: "INVALID_DEFINITION",
    });
  }
  return parsed.data;
}
