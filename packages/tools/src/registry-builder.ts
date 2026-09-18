import { ToolDefinitionSchema, type ToolName } from "@caelush/protocol";
import {
  DefaultAgentToolRegistryBuilder,
  type AgentToolRegistry,
  type ToolRegistryOptions as CanonicalToolRegistryOptions,
} from "@caelush/agent";

import { ToolRegistryStateError, ToolRegistrationError } from "./errors.js";
import { cloneToolDefinition } from "./legacy-definition.js";
import {
  DEFAULT_TOOL_REGISTRY_OPTIONS,
  toCanonicalToolRegistryOptions,
  type ToolRegistryOptions,
} from "./options.js";
import { validateToolDefinitionSemantics } from "./schema-policy.js";
import type { ToolRegistration } from "./registration.js";
import { createToolRegistry, type ResolvedTool, type ToolRegistry } from "./registry.js";
import { appendToolModelGuidance, normalizeToolModelGuidance } from "./model-guidance.js";
import { buildLegacyCodingToolCatalog, resolveAgentToolRegistration } from "./tool-adapters.js";
import { throwLegacyRegistrationError } from "./tool-system-bridge.js";

/**
 * The legacy registry builder facade.
 *
 * ```text
 * ToolRegistryBuilder  (compatibility facade, this file)
 *        └── delegates ──▶  DefaultAgentToolRegistryBuilder  (@caelush/agent)
 * ```
 *
 * It owns no schema compiler, no resolution rule and no duplicate detection — the canonical builder
 * does all of it. What this file owns is the *legacy outside*: the `ToolDefinitionSchema` shape a
 * caller passes in, the `ToolRegistration` field names, model-guidance folding, and the projection of
 * canonical entries back into `ResolvedTool` views.
 *
 * The Coding overlay is separated here rather than carried into the registry: risk level,
 * capabilities, runtime requirements, projectors, presentation and guidance become a
 * `CodingToolDefinition` in the `CodingToolCatalog` that `@caelush/coding-agent` owns, so the
 * canonical entry remains an executable Tool and its validators.
 *
 * ## Why `build()` is synchronous
 *
 * The build is a pure derivation: the canonical builder compiles and freezes, and this file projects
 * the result. The Coding catalog is a *separate* build (`buildCodingCatalog()`), because it is a
 * different artifact produced by a different package, and folding an asynchronous overlay build into
 * the registry build would make every existing synchronous caller wait on something it does not use.
 */
export type AgentToolRegistration = ToolRegistration;

export class ToolRegistryBuilder {
  private readonly canonicalOptions: CanonicalToolRegistryOptions;
  private readonly registrations: ToolRegistration[] = [];
  private readonly names = new Set<ToolName>();
  private readonly canonical: DefaultAgentToolRegistryBuilder;
  private finalized = false;
  private builtRegistry: ToolRegistry | undefined;

  constructor(options: ToolRegistryOptions = DEFAULT_TOOL_REGISTRY_OPTIONS) {
    this.canonicalOptions = Object.freeze(toCanonicalToolRegistryOptions(options));
    this.canonical = new DefaultAgentToolRegistryBuilder(this.canonicalOptions);
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
    const parsedDefinition = parsed.data;
    if (this.names.has(parsedDefinition.name)) {
      throw new ToolRegistrationError(`Tool "${parsedDefinition.name}" is already registered.`, {
        reason: "DUPLICATE_TOOL_NAME",
        toolName: parsedDefinition.name,
      });
    }

    let modelGuidance: ToolRegistration["modelGuidance"];
    if (registration.modelGuidance !== undefined) {
      try {
        modelGuidance = normalizeToolModelGuidance(
          registration.modelGuidance,
          parsedDefinition.name,
        );
      } catch {
        throw new ToolRegistrationError("Tool model guidance is invalid.", {
          reason: "INVALID_MODEL_GUIDANCE",
          toolName: parsedDefinition.name,
        });
      }
    }

    // Guidance is folded into the description *before* the canonical builder sees it, so the model
    // catalog byte budget is measured against what a model actually receives. That is the legacy
    // builder's observable behaviour, preserved exactly.
    const definition = cloneToolDefinition({
      ...parsedDefinition,
      ...(modelGuidance === undefined
        ? {}
        : { description: appendToolModelGuidance(parsedDefinition.description, modelGuidance) }),
    });

    const classified = resolveAgentToolRegistration(registration, definition, modelGuidance);
    try {
      this.canonical.register(classified.agentTool);
    } catch (error) {
      throwLegacyRegistrationError(error);
    }

    this.names.add(definition.name);
    this.registrations.push({
      definition,
      handler: registration.handler,
      ...(registration.effectProjector === undefined
        ? {}
        : { effectProjector: registration.effectProjector }),
      ...(registration.securityFactsProjector === undefined
        ? {}
        : { securityFactsProjector: registration.securityFactsProjector }),
      ...(modelGuidance === undefined ? {} : { modelGuidance }),
      adapters: { agent: classified.agentTool, coding: classified.coding },
    });
    return this;
  }

  /**
   * Build the canonical registry.
   *
   * Synchronous, and the only place schema compilation happens: the canonical builder compiles both
   * schemas for every Tool once, with this builder's own runtime.
   */
  buildAgentRegistry(): AgentToolRegistry {
    try {
      return this.canonical.build();
    } catch (error) {
      throwLegacyRegistrationError(error);
    }
  }

  /** The compiler the canonical build uses, so a legacy caller never creates a second one. */
  buildSchemaRuntime(): import("@caelush/agent").ToolSchemaRuntime {
    return this.canonical.buildSchemaRuntime();
  }

  build(): ToolRegistry {
    if (this.builtRegistry !== undefined) return this.builtRegistry;

    const canonicalRegistry = this.buildAgentRegistry();
    const runtime = this.canonical.buildSchemaRuntime();
    const resolvedTools: ResolvedTool[] = [];
    for (const registration of this.registrations) {
      const definition = registration.definition;
      const validators = validateToolDefinitionSemantics(
        definition,
        this.canonicalOptions,
        runtime,
      );
      resolvedTools.push({
        definition,
        handler: registration.handler,
        inputValidator: validators.input,
        outputValidator: validators.output,
        ...(registration.effectProjector === undefined
          ? {}
          : { effectProjector: registration.effectProjector }),
        ...(registration.securityFactsProjector === undefined
          ? {}
          : { securityFactsProjector: registration.securityFactsProjector }),
        ...(registration.modelGuidance === undefined
          ? {}
          : { modelGuidance: registration.modelGuidance }),
        ...(registration.adapters?.agent === undefined
          ? {}
          : { agentTool: registration.adapters.agent }),
        ...(registration.adapters?.coding === undefined
          ? {}
          : { coding: registration.adapters.coding }),
      });
    }

    this.builtRegistry = createToolRegistry(resolvedTools, canonicalRegistry);
    this.finalized = true;
    return this.builtRegistry;
  }

  /**
   * Build the Coding overlay for the Tools this builder registered.
   *
   * Separate from `build()` on purpose: the registry is a general artifact and the catalog is a
   * Coding artifact, and only the caller that owns Coding policy needs to wait for it. It is also
   * what refuses a *dangling* overlay — a catalog entry whose Tool the active registry cannot execute.
   */
  async buildCodingCatalog(): Promise<void> {
    const canonicalRegistry = this.buildAgentRegistry();
    await buildLegacyCodingToolCatalog({
      agentRegistry: canonicalRegistry,
      entries: this.registrations.map((registration) => {
        const agentTool = registration.adapters?.agent;
        const coding = registration.adapters?.coding;
        if (agentTool === undefined || coding === undefined) {
          throw new ToolRegistrationError("Tool registration is invalid.", {
            reason: "INVALID_DEFINITION",
            toolName: registration.definition.name,
          });
        }
        return { agentTool, coding };
      }),
    });
  }
}

function invalidRegistration(): never {
  throw new ToolRegistrationError("Tool registration is invalid.", {
    reason: "INVALID_DEFINITION",
  });
}
