import type { JsonObject } from "@caelush/ai";
import type { AgentTool, ToolPresentationPort } from "@caelush/agent";

import type {
  CodingToolEffectProjector,
  CodingToolSecurityFactsProjector,
  CodingToolSecurityMetadata,
} from "./security-metadata.js";

/**
 * A Coding Tool: a general `AgentTool` plus what the Coding product adds around it.
 *
 * ```ts
 * export interface CodingToolDefinition {
 *   readonly tool: AgentTool;
 *   readonly security: CodingToolSecurityMetadata;
 *   readonly securityFactsProjector?: CodingToolSecurityFactsProjector;
 *   readonly effectProjector?: CodingToolEffectProjector;
 *   readonly presentation?: ToolPresentationPort;
 *   readonly promptSnippet?: string;
 * }
 * ```
 *
 * ## Composition, not inheritance
 *
 * The field that holds the executable Tool is named **`tool`**. A Coding Tool is not an `AgentTool`
 * with extra fields bolted on: it *has* an Agent Tool, and the registry that resolves executables
 * never sees the coding half. That is what keeps the Agent Tool Layer from learning about Git,
 * workspaces, approval policy or UI, and what keeps `AgentToolRegistry.modelSpecs()` free of them.
 *
 * ## Operations are not a field here
 *
 * A Tool reaches its environment through narrow Operations interfaces, and those are injected by the
 * Tool's own factory through a closure when the `AgentTool` is created. Listing an operations object
 * on the definition would turn metadata into a capability handle, so there is deliberately no such
 * field — not even an optional one.
 *
 * ## What this definition may not do
 *
 * It is data. It executes no Security policy, performs no Runtime operation, projects no effect by
 * itself and renders nothing: those happen in the components that consume the projectors, at the
 * stages that own them.
 */
export interface CodingToolDefinition {
  readonly tool: AgentTool;
  readonly security: CodingToolSecurityMetadata;
  readonly securityFactsProjector?: CodingToolSecurityFactsProjector | undefined;
  readonly effectProjector?: CodingToolEffectProjector | undefined;
  readonly presentation?: ToolPresentationPort | undefined;
  readonly promptSnippet?: string | undefined;
}

/** A registration form for a Coding Tool, used while a catalog is being built. */
export type CodingToolRegistration = CodingToolDefinition;

/** The JSON-safe shape a Coding Tool's runtime requirements take. */
export type CodingToolRuntimeRequirements = JsonObject;
