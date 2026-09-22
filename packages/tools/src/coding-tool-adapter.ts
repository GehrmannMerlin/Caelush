import type {
  AgentTool,
  AgentToolExecutionInput,
  ToolExecutionUpdateSink,
} from "@caelush/agent";
import type { CodingToolDefinition, CodingToolSecurityMetadata } from "@caelush/coding-agent";
import { DISCARDING_TOOL_EXECUTION_UPDATE_SINK } from "@caelush/agent";
import type { Capability, JsonObject, ToolDefinition, ToolName } from "@caelush/protocol";
import type { RuntimeResolver } from "@caelush/runtime";

import type { ToolExecutionRequest, ToolHandler } from "./handler.js";
import type { RegistrationCodingOverlay, ToolRegistration } from "./registration.js";
import type { ToolSecurityFactsProjector } from "./security-facts.js";
import type { ToolEffectProjector, ToolEffectProjectorInput } from "./tool-effects.js";

/**
 * `CodingToolDefinition`  ──adapted──▶  legacy `ToolRegistration`.
 *
 * ```text
 * target Coding Tool                legacy compatibility registration
 * ─────────────────────────────     ────────────────────────────────────────────
 * tool.name                     →   definition.name
 * tool.description              →   definition.description
 * tool.inputSchema              →   definition.inputSchema
 * tool.resultDetailsSchema      →   definition.outputSchema
 * security.riskLevel            →   definition.riskLevel
 * security.requiredCapabilities →   definition.requiredCapabilities
 * security.runtimeRequirements  →   definition.runtimeRequirements
 * tool (the AgentTool itself)   →   adapters.agent
 * the whole definition          →   adapters.coding
 * tool.execute                  →   handler.execute (a projection, not a second algorithm)
 * ```
 *
 * ## Why this exists
 *
 * Phase 4E made `@caelush/coding-agent` the **only** Coding builtin business authority. The legacy
 * package still publishes the factory names its callers import — `createReadFileRegistration`,
 * `createGitToolRegistrations`, `createDefaultBuiltinToolRegistrations` — but those names must resolve
 * to the target implementation rather than to a second copy of it.
 *
 * So a legacy builtin module does exactly three things, and this module is the second of them:
 *
 * ```text
 * 1  construct the Runtime Operations adapter for its capability family
 * 2  call the target factory                ← createReadFileTool(operations)
 * 3  adapt the result into the legacy shape ← this function
 * ```
 *
 * ## What it deliberately does not do
 *
 * There is no schema, no default, no bound, no failure code, no security fact, no effect and no
 * presentation here. Every one of those is read *out of* the `CodingToolDefinition` the target factory
 * produced, which is what makes "one implementation" a structural property rather than a promise: a
 * divergence is impossible because there is only one value to diverge from.
 *
 * ## `adapters.agent` carries the real Tool
 *
 * The canonical registry executes `adapters.agent`, not `handler`. Passing the target `AgentTool`
 * through is what keeps the canonical transient-update channel working — `exec_command` and
 * `write_stdin` publish through `input.updates`, which only exists on the canonical execution input.
 * The legacy `handler` is the compatibility projection of the *same* `execute` for a legacy direct
 * caller; it is not a second implementation and it is never the production execution path.
 */

/**
 * Read the legacy data description out of a target Coding Tool.
 *
 * The target is the single source for all seven fields, so a legacy reader cannot observe a value the
 * Coding product layer does not itself use.
 */
export function toolDefinitionFromCodingTool(definition: CodingToolDefinition): ToolDefinition {
  const tool = definition.tool;
  const security: CodingToolSecurityMetadata = definition.security;
  const capabilities: Capability[] = [...security.requiredCapabilities];
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as unknown as JsonObject,
    outputSchema: tool.resultDetailsSchema as unknown as JsonObject,
    riskLevel: security.riskLevel,
    requiredCapabilities: capabilities,
    runtimeRequirements: security.runtimeRequirements as unknown as JsonObject,
  };
}

/**
 * Project the canonical execution input onto the legacy Tool execution request.
 *
 * ```text
 * canonical   { identity: { runId, sessionId, sourceStepId, invocationId, externalCallId },
 *               args, environment, signal, updates }
 * legacy      { runId, stepId, invocationId, externalCallId, args, environment, signal? }
 * ```
 *
 * A bridge for a legacy direct caller, not a second implementation: the function it calls *is* the
 * target Tool's `execute`. Two consequences are deliberate and stated rather than papered over:
 *
 * ```text
 * updates   the legacy request has no sink, so this path publishes through the discarding sink.
 *           Production never takes it: the registry executes `adapters.agent`, which receives the
 *           canonical input and the real sink, so `exec_command` and `write_stdin` stream normally.
 * signal    the legacy request's signal is optional and the canonical one is required, so an absent
 *           signal becomes a non-aborted one — the same fallback the canonical coordinator uses for
 *           a caller that supplied none.
 * ```
 */
export function createDelegatingToolHandler(execute: AgentTool["execute"]): ToolHandler {
  const sink: ToolExecutionUpdateSink = DISCARDING_TOOL_EXECUTION_UPDATE_SINK;
  return {
    async execute(request: ToolExecutionRequest) {
      const input: AgentToolExecutionInput = {
        identity: {
          runId: request.runId,
          // The legacy request predates the Session on the identity and carries no field for it. The
          // canonical projection it is standing in for does carry one, and this bridge has to put
          // *something* there. No Coding builtin reads it, and the registry never runs this path.
          sessionId: request.runId as never,
          sourceStepId: request.stepId,
          invocationId: request.invocationId,
          externalCallId: request.externalCallId,
        },
        args: request.args as JsonObject,
        environment: request.environment,
        signal: request.signal ?? new AbortController().signal,
        updates: sink,
      };
      return await execute(input);
    },
  };
}

/**
 * Adapt one target Coding Tool into the legacy registration shape.
 *
 * The returned registration carries no model guidance. Usage guidance is a Coding prompt snippet, and
 * Phase 4E moved it out of `AIToolSpec.description` and into the budgeted Context path, so a legacy
 * registration that appended it to the description would be the very duplication the round forbids.
 * The compatibility module `model-guidance.ts` still serves an external caller that supplies guidance
 * explicitly, and it reads the same canonical snippet text.
 */
export function toLegacyToolRegistration(definition: CodingToolDefinition): ToolRegistration {
  const tool: AgentTool = definition.tool;
  return {
    definition: toolDefinitionFromCodingTool(definition),
    handler: createDelegatingToolHandler(tool.execute),
    // The overlay carries the canonical projectors and the prompt snippet, so the catalog entry a
    // legacy registration produces is the object the Coding product layer built.
    adapters: { agent: tool, coding: definition },
    // The two projector fields are also surfaced at the top level, because that is where a legacy
    // reader looks for them. Both are the canonical functions behind one typed bridge.
    ...(definition.securityFactsProjector === undefined
      ? {}
      : { securityFactsProjector: bridgeSecurityFactsProjector(definition.securityFactsProjector) }),
    ...(definition.effectProjector === undefined
      ? {}
      : { effectProjector: bridgeEffectProjector(definition.effectProjector) }),
  };
}

/**
 * Present a canonical security facts projector under the legacy projector signature.
 *
 * Both declarations describe a pure function from prepared arguments to a facts bundle, and the two
 * `JsonObject` types involved are the same JSON value model declared by two packages. The canonical
 * function is stored as-is — the identity of the projector the Security admission path calls does not
 * change — and only its static signature is restated.
 */
export function bridgeSecurityFactsProjector(
  projector: CodingToolDefinition["securityFactsProjector"] & object,
): ToolSecurityFactsProjector {
  return projector as unknown as ToolSecurityFactsProjector;
}

/**
 * Present a canonical effect projector under the legacy projector signature.
 *
 * ```text
 * canonical input   request: { invocationId, externalCallId, args, environment, runId, stepId, ... }
 * legacy input      request:  ToolExecutionRequest — the same fields, named by a legacy interface
 * ```
 *
 * The legacy request *is* the earlier name for exactly that shape, so the call is forwarded unchanged.
 * This is a call-shape bridge, not a projection: the effects are still computed by the canonical
 * function, and the settlement path that reads this field is the same one that already assembled the
 * wider request.
 */
export function bridgeEffectProjector(
  projector: CodingToolDefinition["effectProjector"] & object,
): ToolEffectProjector {
  const canonical = projector as unknown as (
    input: ToolEffectProjectorInput,
  ) => ReturnType<ToolEffectProjector>;
  return (input: ToolEffectProjectorInput): ReturnType<ToolEffectProjector> => canonical(input);
}

/** Read the target Tool name back out of an adapted registration. */
export function codingToolName(definition: CodingToolDefinition): ToolName {
  return definition.tool.name;
}

/**
 * The Coding overlay entry a legacy registration carries.
 *
 * Exposed so a composition root that built its Tools from the Coding product layer can register them
 * through the legacy builder without re-deriving the overlay, and so `buildCodingCatalog()` can read
 * back the shape it was given.
 */
export function codingOverlayOf(
  registration: ToolRegistration,
): RegistrationCodingOverlay | undefined {
  return registration.adapters?.coding;
}

/** True when a registration's overlay is already a complete target Coding Tool definition. */
export function isCodingToolDefinition(value: unknown): value is CodingToolDefinition {
  if (value === null || typeof value !== "object") return false;
  return (value as { readonly tool?: unknown }).tool !== undefined;
}

/**
 * A resolver that resolves nothing, for a module-level Tool *definition* constant.
 *
 * The four legacy `*Definition` exports describe schemas; nothing in the repository executes them.
 * The target factories derive their schemas from the Tool's own constants and not from the Operations
 * argument, so a definition built over this resolver carries the real, target-owned schema.
 *
 * It deliberately resolves to `undefined` rather than to a stub Runtime: if such a definition were
 * ever executed, `resolveRuntimeWorkspace` would raise the Runtime's own `RuntimeUnsupportedError`,
 * which is exactly what the previous module-level definition produced when it was called with no
 * Runtime behind it. No behaviour is invented and no filesystem is touched.
 */
export const DEFINITION_ONLY_RUNTIME_RESOLVER: RuntimeResolver = Object.freeze({
  resolve: (): undefined => undefined,
});

export type { CodingToolDefinition };
