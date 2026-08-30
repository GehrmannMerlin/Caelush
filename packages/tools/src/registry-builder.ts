import { ToolDefinitionSchema, type ToolName } from "@caelush/protocol";
import { ToolRegistryStateError, ToolRegistrationError } from "./errors.js";
import { cloneToolDefinition, canonicalJsonString, jsonUtf8ByteLength } from "./json-canonical.js";
import {
  DEFAULT_TOOL_REGISTRY_OPTIONS,
  validateToolRegistryOptions,
  type ToolRegistryOptions,
} from "./options.js";
import { validateToolDefinitionSemantics } from "./schema-policy.js";
import { ToolSchemaRuntime } from "./schema-runtime.js";
import type { ToolRegistration } from "./registration.js";
import { createToolRegistry, type ResolvedTool, type ToolRegistry } from "./registry.js";

function invalidRegistration(): never {
  throw new ToolRegistrationError("Tool registration is invalid.", {
    reason: "INVALID_DEFINITION",
  });
}

export class ToolRegistryBuilder {
  private readonly options: ToolRegistryOptions;
  private readonly registrations: ToolRegistration[] = [];
  private readonly names = new Set<ToolName>();
  private readonly schemaRuntime = new ToolSchemaRuntime();
  private finalized = false;
  private builtRegistry: ToolRegistry | undefined;

  constructor(options: ToolRegistryOptions = DEFAULT_TOOL_REGISTRY_OPTIONS) {
    validateToolRegistryOptions(options);
    this.options = Object.freeze({ ...options });
  }

  register(registration: ToolRegistration): this {
    if (this.finalized) {
      throw new ToolRegistryStateError("Tool registry builder is already finalized.", {
        reason: "BUILDER_FINALIZED",
      });
    }
    if (registration === null || typeof registration !== "object") invalidRegistration();
    const parsed = ToolDefinitionSchema.safeParse(registration.definition);
    if (!parsed.success || typeof registration.handler?.execute !== "function") {
      invalidRegistration();
    }
    const definition = cloneToolDefinition(parsed.data);
    if (this.names.has(definition.name)) {
      throw new ToolRegistrationError(`Tool "${definition.name}" is already registered.`, {
        reason: "DUPLICATE_TOOL_NAME",
        toolName: definition.name,
      });
    }
    if (this.registrations.length >= this.options.maxTools) {
      throw new ToolRegistrationError("Tool registry tool limit exceeded.", {
        reason: "TOOL_LIMIT_EXCEEDED",
      });
    }
    this.names.add(definition.name);
    this.registrations.push({
      definition,
      handler: registration.handler,
      ...(registration.effectProjector === undefined
        ? {}
        : { effectProjector: registration.effectProjector }),
    });
    return this;
  }

  build(): ToolRegistry {
    if (this.builtRegistry !== undefined) return this.builtRegistry;

    const resolvedTools: ResolvedTool[] = [];
    let catalogBytes = 0;
    for (const registration of this.registrations) {
      const validators = validateToolDefinitionSemantics(
        registration.definition,
        this.options,
        this.schemaRuntime,
      );
      const modelMetadata = {
        name: registration.definition.name,
        description: registration.definition.description,
        inputSchema: registration.definition.inputSchema,
      } as const;
      catalogBytes += jsonUtf8ByteLength(canonicalJsonString(modelMetadata));
      if (catalogBytes > this.options.maxCatalogBytes) {
        throw new ToolRegistrationError("Tool model catalog exceeds its byte budget.", {
          reason: "TOOL_CATALOG_TOO_LARGE",
        });
      }
      resolvedTools.push({
        definition: registration.definition,
        handler: registration.handler,
        inputValidator: validators.input,
        outputValidator: validators.output,
        ...(registration.effectProjector === undefined
          ? {}
          : { effectProjector: registration.effectProjector }),
      });
    }

    this.builtRegistry = createToolRegistry(resolvedTools);
    this.finalized = true;
    return this.builtRegistry;
  }
}
