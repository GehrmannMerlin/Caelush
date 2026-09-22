import type { AgentTool, AgentToolExecutionInput, AgentToolRegistry } from "@caelush/agent";
import {
  CodingToolCatalogBuilder,
  type CodingToolCatalog,
  type CodingToolDefinition,
} from "@caelush/coding-agent";
import type { Capability, JsonObject, RiskLevel, ToolDefinition } from "@caelush/protocol";

import type { ToolExecutionResult } from "./execution-result.js";
import type { ToolExecutionRequest, ToolHandler } from "./handler.js";
import type { AgentToolRegistration } from "./registry-builder.js";
import type { LegacyCodingToolMetadata, RegistrationCodingOverlay } from "./registration.js";
import type { ToolEffectProjector } from "./tool-effects.js";
import type { ToolModelGuidance } from "./model-guidance.js";
import type { ToolPresentationPort } from "./presentation.js";
import type { ToolSecurityFactsProjector } from "./security-facts.js";
import { throwLegacyRegistrationError } from "./tool-system-bridge.js";
import { isCodingToolDefinition } from "./coding-tool-adapter.js";

/**
 * Legacy definition + handler  ──adapted──▶  canonical AgentTool + CodingToolDefinition
 *
 * ```text
 * ToolDefinition  ─┬─ name, description, inputSchema ─▶ AIToolSpec half of AgentTool
 *                  ├─ outputSchema                   ─▶ resultDetailsSchema
 *                  ├─ riskLevel, capabilities,
 *                  │  runtimeRequirements            ─▶ CodingToolSecurityMetadata
 *                  └─ effect/security/presentation/
 *                     guidance projectors             ─▶ Coding overlay metadata
 * ToolHandler ──────────────────────────────────────▶  AgentTool.execute
 * ```
 *
 * This is the whole legacy adapter surface. It *classifies* a registration's fields and nothing
 * more: no schema is compiled here, no argument is validated here, and no registry is resolved here.
 * The canonical registry compiles, the canonical Preparer prepares, and this module only says which
 * canonical shape each legacy field becomes.
 *
 * `resolveAgentToolRegistration` is the single classification function, so the legacy registry
 * builder and the legacy environment filter can never disagree about what a registration means.
 */

/**
 * The Coding overlay metadata a legacy registration can carry, in legacy vocabulary.
 *
 * The projector fields keep their legacy function signatures. They are handed straight to the Coding
 * catalog, which stores them without calling them, so this file does not need — and deliberately does
 * not restate — the effect or security-fact vocabularies those functions speak.
 */
export interface ClassifiedCodingMetadata {
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly Capability[];
  readonly runtimeRequirements: JsonObject;
  readonly effectProjector?: ToolEffectProjector | undefined;
  readonly securityFactsProjector?: ToolSecurityFactsProjector | undefined;
  readonly presentation?: ToolPresentationPort | undefined;
  readonly modelGuidance?: ToolModelGuidance | undefined;
}

/** The classification of one registration, before the canonical registry compiles anything. */
export interface ClassifiedRegistration {
  readonly agentTool: AgentTool;
  readonly coding: ClassifiedCodingMetadata;
}

/** True when a registration already carries a canonical AgentTool. */
export function hasAdapterAgentTool(
  registration: AgentToolRegistration,
): registration is AgentToolRegistration & { readonly adapters: { readonly agent: AgentTool } } {
  return registration.adapters?.agent !== undefined;
}

function withOptionalModelGuidance(
  coding: ClassifiedCodingMetadata,
  modelGuidance: ToolModelGuidance | undefined,
): ClassifiedCodingMetadata {
  if (modelGuidance === undefined) {
    return coding.modelGuidance === undefined
      ? coding
      : { ...coding, modelGuidance: coding.modelGuidance };
  }
  return { ...coding, modelGuidance };
}

/**
 * Classify a legacy registration.
 *
 * A registration that supplies its own canonical `AgentTool` keeps it; one that does not gets an
 * AgentTool built from its definition and handler. Either way the Coding metadata is separated out,
 * so the value handed to the canonical registry never carries it.
 *
 * ## Two overlay shapes, one classification
 *
 * Phase 4E's builtin facades carry a whole `CodingToolDefinition`; a hand-written or external
 * registration carries the narrower `LegacyCodingToolMetadata`. Both are read here so the rest of the
 * builder sees one `ClassifiedCodingMetadata` — which is what keeps the legacy registry builder, the
 * environment filter and the catalog build from each needing their own branch.
 */
export function resolveAgentToolRegistration(
  registration: AgentToolRegistration,
  definition: ToolDefinition,
  modelGuidance: ToolModelGuidance | undefined,
): ClassifiedRegistration {
  const provided = registration.adapters?.agent;
  const coding = classifyCodingOverlay(registration.adapters?.coding);
  const model = withOptionalModelGuidance(
    {
      riskLevel: coding?.riskLevel ?? definition.riskLevel,
      requiredCapabilities: Object.freeze([
        ...(coding?.requiredCapabilities ?? definition.requiredCapabilities),
      ]),
      runtimeRequirements: coding?.runtimeRequirements ?? definition.runtimeRequirements,
      ...(coding?.effectProjector === undefined ? {} : { effectProjector: coding.effectProjector }),
      ...(coding?.securityFactsProjector === undefined
        ? {}
        : { securityFactsProjector: coding.securityFactsProjector }),
      ...(coding?.presentation === undefined ? {} : { presentation: coding.presentation }),
      ...(coding?.modelGuidance === undefined ? {} : { modelGuidance: coding.modelGuidance }),
    },
    modelGuidance,
  );

  const agentTool: AgentTool =
    provided === undefined
      ? (Object.freeze({
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
          label: humanizeToolName(definition.name),
          resultDetailsSchema: definition.outputSchema,
          executionMode: "SEQUENTIAL",
          execute: createLegacyExecute(registration.handler),
        }) as AgentTool)
      : provided;

  return { agentTool, coding: model };
}

/**
 * Read either overlay shape as the legacy classification.
 *
 * A `CodingToolDefinition` already holds its metadata under `security`, and its projectors are the
 * canonical ones — the same values, read rather than restated.
 *
 * Exported because three places in the legacy package ask the same question of a resolved Tool's
 * overlay — the admission adapter, the dispatcher's durable metadata and this classifier — and three
 * copies of the branch would be three places for the two shapes to drift.
 */
export function classifyCodingOverlay(
  coding: RegistrationCodingOverlay | undefined,
): ClassifiedCodingMetadata | undefined {
  if (coding === undefined) return undefined;
  if (!isCodingToolDefinition(coding)) return coding;
  return {
    riskLevel: coding.security.riskLevel,
    requiredCapabilities: coding.security.requiredCapabilities,
    runtimeRequirements: coding.security.runtimeRequirements as unknown as JsonObject,
    ...(coding.securityFactsProjector === undefined
      ? {}
      : { securityFactsProjector: asOverlayProjector(coding.securityFactsProjector) }),
    ...(coding.effectProjector === undefined
      ? {}
      : { effectProjector: asOverlayProjector(coding.effectProjector) }),
    ...(coding.presentation === undefined ? {} : { presentation: coding.presentation }),
  };
}

/**
 * Adapt a legacy handler to `AgentTool.execute`.
 *
 * ```text
 * canonical input  { identity, args, environment, signal, updates }
 * legacy request   { runId, stepId, invocationId, externalCallId, args, environment, signal? }
 * canonical result { content, details, isError }
 * ```
 *
 * The handler receives the argument semantics it always received: the same prepared, frozen `args`,
 * the same environment locator, the same identity fields, and the caller's signal. `updates` is a
 * canonical addition a legacy handler cannot publish through, so the adapter neither forwards it nor
 * fabricates anything in its place.
 *
 * The request is frozen when it is built, exactly as the canonical input is.
 */
export function createLegacyExecute(
  handler: ToolHandler,
): (input: AgentToolExecutionInput) => Promise<ToolExecutionResult> {
  return async (input) => {
    const request = Object.freeze({
      runId: input.identity.runId,
      stepId: input.identity.sourceStepId,
      invocationId: input.identity.invocationId,
      externalCallId: input.identity.externalCallId,
      args: input.args,
      environment: input.environment,
      signal: input.signal,
    }) as unknown as ToolExecutionRequest;
    return handler.execute(request);
  };
}

/** A stable, human-readable label derived from a tool name. */
export function humanizeToolName(name: string): string {
  const words = name.split("_").filter((part) => part.length > 0);
  if (words.length === 0) return name;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * Resolve an AgentTool out of the canonical registry by name.
 *
 * Used by the environment filter so the filtered registry, the filtered model definitions and the
 * filtered Coding overlay are all rebuilt from one canonical source.
 */
export function resolveRegisteredAgentTool(
  registry: AgentToolRegistry,
  name: ToolDefinition["name"],
): AgentTool | undefined {
  return registry.resolve(name)?.tool;
}

/**
 * The vocabulary boundary between the legacy projector and the Coding overlay contract.
 *
 * The legacy facts projector is typed over the Protocol `JsonObject` and the overlay contract is
 * typed over the AI-local one. The two describe the same JSON value model, but they are declared by
 * different packages — `@caelush/ai` cannot depend on `@caelush/protocol` — so TypeScript sees two
 * structurally-similar-but-distinct recursive types.
 *
 * This cast crosses that boundary once, in the adapter that exists to cross boundaries. It cannot
 * change behaviour: the value is only stored here, and the layer that calls a projector is the legacy
 * layer that declared it, which still sees its own signature.
 */
function asOverlayProjector<TProjector>(projector: TProjector): never {
  return projector as never;
}

/**
 * Build the Coding overlay for a set of legacy registrations.
 *
 * This is the one place a legacy registration becomes a `CodingToolDefinition`, and it is a pure
 * projection — the catalog implementation, the duplicate and dangling checks and the immutability
 * all belong to `@caelush/coding-agent`.
 *
 * ## A registration that already carries a target Coding Tool
 *
 * Phase 4E's builtin facades adapt a whole `CodingToolDefinition`: `adapters.coding` *is* the target
 * definition, projectors and prompt snippet included. That case is registered verbatim, so the catalog
 * entry a legacy registration produces is the same object the Coding product layer built. Nothing is
 * re-derived, and in particular the `promptSnippet` survives — which is what lets the legacy default
 * set and a direct `createDefaultCodingTools(...)` call describe the same tools to a model.
 *
 * The lifecycle points that guard a legacy catalog build — dropping a dangling entry, rebuilding a
 * filtered overlay against the wrong registry — are the ones the target builder already enforces, so
 * this function still delegates both checks rather than restating them.
 *
 * ## Synchronous, because the catalog is a derivation
 *
 * Phase 4E replaced the cached dynamic import with the declared static dependency: `@caelush/tools`
 * depends on `@caelush/coding-agent` in its manifest now, so nothing has to be discovered at runtime.
 * The catalog is therefore available wherever a registry is, with no initialisation step for a host to
 * forget — which is what lets production read its durable metadata out of the catalog itself.
 */
export function buildLegacyCodingToolCatalog(input: {
  readonly agentRegistry: AgentToolRegistry;
  readonly entries: readonly {
    readonly agentTool: AgentTool;
    readonly coding: RegistrationCodingOverlay;
  }[];
}): CodingToolCatalog {
  const builder = new CodingToolCatalogBuilder().forRegistry(input.agentRegistry);
  try {
    for (const entry of input.entries) {
      builder.register(
        isCodingToolDefinition(entry.coding)
          ? entry.coding
          : toCodingToolDefinition(entry.agentTool, entry.coding),
      );
    }
    return builder.build();
  } catch (error) {
    throwLegacyRegistrationError(error);
  }
}

/**
 * Assemble the target `CodingToolDefinition` a narrow legacy registration describes.
 *
 * The executable Tool is the canonical `AgentTool` the registry will run, so a catalog entry built
 * here names the same Tool the registry resolves — it cannot become a dangling overlay.
 */
function toCodingToolDefinition(
  agentTool: AgentTool,
  coding: LegacyCodingToolMetadata,
): CodingToolDefinition {
  return {
    tool: agentTool,
    security: {
      riskLevel: coding.riskLevel,
      requiredCapabilities: coding.requiredCapabilities,
      runtimeRequirements: coding.runtimeRequirements,
    },
    ...(coding.securityFactsProjector === undefined
      ? {}
      : { securityFactsProjector: asOverlayProjector(coding.securityFactsProjector) }),
    ...(coding.effectProjector === undefined
      ? {}
      : { effectProjector: asOverlayProjector(coding.effectProjector) }),
    ...(coding.presentation === undefined ? {} : { presentation: coding.presentation }),
  };
}
