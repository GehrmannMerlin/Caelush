import { ToolDefinitionSchema, type JsonObject, type ToolName } from "@caelush/protocol";
import type { CodingToolCatalog, CodingToolDefinition } from "@caelush/coding-agent";
import {
  DefaultAgentToolRegistryBuilder,
  type AgentTool,
  type AgentToolRegistry,
  type ToolRegistryOptions as CanonicalToolRegistryOptions,
} from "@caelush/agent";

import { ToolRegistryStateError, ToolRegistrationError } from "./errors.js";
import {
  bridgeEffectProjector,
  bridgeSecurityFactsProjector,
  createDelegatingToolHandler,
  isCodingToolDefinition,
  toolDefinitionFromCodingTool,
} from "./coding-tool-adapter.js";
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
import { buildLegacyCodingToolCatalog, classifyCodingOverlay, resolveAgentToolRegistration } from "./tool-adapters.js";
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

  /**
   * Register a Tool.
   *
   * ```text
   * ToolRegistration        a legacy definition + handler (+ optional overlay, + optional AgentTool)
   * CodingToolDefinition    a Tool built by @caelush/coding-agent
   * ```
   *
   * Both are accepted because Phase 4E's production composition builds its Tools with the Coding
   * product layer and still needs to reach the canonical registry through this builder. Registering a
   * `CodingToolDefinition` is a projection, not a second registration path: the executor it registers
   * *is* the target `AgentTool`, and the overlay it stores *is* the target definition — so the catalog
   * this builder can subsequently build carries the target's own projectors and prompt snippet rather
   * than a re-derivation of them.
   */
  register(registration: ToolRegistration | CodingToolDefinition): this {
    if (this.finalized) {
      throw new ToolRegistryStateError("Tool registry builder is already finalized.", {
        reason: "BUILDER_FINALIZED",
      });
    }
    const entry = toRegistrationEntry(registration);
    if (entry === null || typeof entry !== "object") invalidRegistration();

    const parsed = ToolDefinitionSchema.safeParse(entry.definition);
    if (!parsed.success || typeof entry.handler?.execute !== "function") {
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
    if (entry.modelGuidance !== undefined) {
      try {
        modelGuidance = normalizeToolModelGuidance(entry.modelGuidance, parsedDefinition.name);
      } catch {
        throw new ToolRegistrationError("Tool model guidance is invalid.", {
          reason: "INVALID_MODEL_GUIDANCE",
          toolName: parsedDefinition.name,
        });
      }
    }

    // Guidance is folded into the description *before* the canonical builder sees it, so the model
    // catalog byte budget is measured against what a model actually receives. That is the legacy
    // builder's observable behaviour, preserved exactly for a caller that supplies guidance; the nine
    // Coding builtins no longer do, because Phase 4E delivers their guidance through Context.
    const definition = cloneToolDefinition({
      ...parsedDefinition,
      ...(modelGuidance === undefined
        ? {}
        : { description: appendToolModelGuidance(parsedDefinition.description, modelGuidance) }),
    });

    const classified = resolveAgentToolRegistration(entry, definition, modelGuidance);
    try {
      this.canonical.register(classified.agentTool);
    } catch (error) {
      throwLegacyRegistrationError(error);
    }

    this.names.add(definition.name);
    this.registrations.push({
      definition,
      handler: entry.handler,
      ...(entry.effectProjector === undefined
        ? {}
        : { effectProjector: entry.effectProjector }),
      ...(entry.securityFactsProjector === undefined
        ? {}
        : { securityFactsProjector: entry.securityFactsProjector }),
      ...(modelGuidance === undefined ? {} : { modelGuidance }),
      adapters: {
        agent: classified.agentTool,
        // The overlay the catalog will receive. A Coding Tool carries its own — projectors and prompt
        // snippet included, so nothing is re-derived and the legacy path cannot strip what the Coding
        // product layer attached. A narrow hand-written overlay is widened into the same shape, which
        // keeps one overlay type flowing through the builder, the filter and the catalog.
        coding: codingOverlayFor(entry, classified),
      },
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
      // The overlay read as the legacy seven-field view, so a reader that wants Coding *metadata*
      // — the admission adapter, the dispatcher's durable row, the security composition — does not
      // have to branch on which of the two overlay shapes this registration carried.
      const codingMetadata = classifyCodingOverlay(registration.adapters?.coding);
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
        ...(codingMetadata === undefined ? {} : { codingMetadata }),
      });
    }

    this.builtRegistry = createToolRegistry(resolvedTools, canonicalRegistry);
    this.finalized = true;
    return this.builtRegistry;
  }

  /**
   * Build the Coding overlay for the Tools this builder registered, and return it.
   *
   * ```text
   * ToolRegistryBuilder  (compatibility facade, this file)
   *        └── delegates ──▶  CodingToolCatalogBuilder  (@caelush/coding-agent)
   * ```
   *
   * Separate from `build()` on purpose: the registry is a general artifact and the catalog is a Coding
   * artifact, and only the caller that owns Coding policy needs it. It is also what refuses a
   * *dangling* overlay — a catalog entry whose Tool the active registry cannot execute.
   *
   * Returned rather than only validated, because Phase 4E's composition root is the layer that reads
   * Coding metadata (a durable `riskLevel`, a security facts projector, a prompt snippet) and it must
   * read it from the catalog rather than from a second derivation. It is still `async`, so an existing
   * `await` — and an existing caller that ignores the answer — keeps working unchanged.
   */
  async buildCodingCatalog(): Promise<CodingToolCatalog> {
    const canonicalRegistry = this.buildAgentRegistry();
    return buildLegacyCodingToolCatalog({
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

/**
 * The overlay the catalog will receive for one registration.
 *
 * ```text
 * CodingToolDefinition       carried through unchanged — projectors and prompt snippet included
 * LegacyCodingToolMetadata   widened into the same shape, so one overlay type flows onward
 * ```
 *
 * The widening is what keeps the builder, the environment filter and the catalog from each needing a
 * branch, and it is why a narrow hand-written registration produces exactly the catalog entry a Coding
 * Tool would: the executable Tool is the canonical `AgentTool` the registry will run, so the entry
 * cannot become a dangling overlay.
 */
function codingOverlayFor(
  entry: ToolRegistration,
  classified: import("./tool-adapters.js").ClassifiedRegistration,
): CodingToolDefinition {
  const declared = entry.adapters?.coding;
  if (declared !== undefined && isCodingToolDefinition(declared)) return declared;
  const metadata = classified.coding;
  return {
    tool: classified.agentTool,
    security: {
      riskLevel: metadata.riskLevel,
      requiredCapabilities: metadata.requiredCapabilities,
      runtimeRequirements: metadata.runtimeRequirements as JsonObject,
    },
    ...(metadata.securityFactsProjector === undefined
      ? {}
      : { securityFactsProjector: metadata.securityFactsProjector as never }),
    ...(metadata.effectProjector === undefined
      ? {}
      : { effectProjector: metadata.effectProjector as never }),
    ...(metadata.presentation === undefined ? {} : { presentation: metadata.presentation }),
  };
}

/**
 * Read either accepted registration form as the legacy entry this builder works on.
 * ```text
 * ToolRegistration       used as given
 * CodingToolDefinition   projected: definition from the target Tool, handler from the target
 *                        execute, adapters.agent from the target AgentTool
 * ```
 *
 * The projection reads every value out of the Coding Tool, so the legacy entry cannot describe a Tool
 * the Coding product layer does not. It is deliberately the same projection the legacy builtin facades
 * use, expressed through the one builder that consumes it.
 */
function toRegistrationEntry(input: ToolRegistration | CodingToolDefinition): ToolRegistration {
  if (!isCodingToolDefinition(input)) return input;
  const tool: AgentTool = input.tool;
  return {
    definition: toolDefinitionFromCodingTool(input),
    handler: createDelegatingToolHandler(tool.execute),
    adapters: { agent: tool, coding: input },
    ...(input.securityFactsProjector === undefined
      ? {}
      : { securityFactsProjector: bridgeSecurityFactsProjector(input.securityFactsProjector) }),
    ...(input.effectProjector === undefined
      ? {}
      : { effectProjector: bridgeEffectProjector(input.effectProjector) }),
  };
}
