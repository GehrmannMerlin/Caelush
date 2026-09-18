import type { AgentTool } from "@caelush/agent";
import type { Capability, JsonObject, RiskLevel, ToolDefinition } from "@caelush/protocol";
import type { ToolHandler } from "./handler.js";
import type { ToolEffectProjector } from "./tool-effects.js";
import type { ToolSecurityFactsProjector } from "./security-facts.js";
import type { ToolModelGuidance } from "./model-guidance.js";
import type { ToolPresentationPort } from "./presentation.js";

/**
 * The Coding metadata a legacy registration carries beside its executable Tool.
 *
 * This is the data half of the legacy registration. It is kept separate from the canonical
 * `AgentTool` because it is exactly what the Agent Tool Layer must not receive: risk level,
 * capabilities, runtime requirements, security facts, effects, presentation and prompt guidance.
 *
 * It becomes a `CodingToolDefinition` in the `CodingToolCatalog` at registry build time, which is
 * where Phase 4A puts the Coding overlay.
 */
export interface LegacyCodingToolMetadata {
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly Capability[];
  readonly runtimeRequirements: JsonObject;
  readonly effectProjector?: ToolEffectProjector | undefined;
  readonly securityFactsProjector?: ToolSecurityFactsProjector | undefined;
  readonly presentation?: ToolPresentationPort | undefined;
  readonly modelGuidance?: ToolModelGuidance | undefined;
}

/**
 * What a legacy registration may carry in addition to its definition and handler.
 *
 * ```text
 * coding   the Coding overlay metadata for this Tool
 * agent    a prebuilt canonical AgentTool, for a registration that needs one
 * ```
 *
 * Both are optional, so every existing `ToolRegistration` value keeps compiling and behaving.
 */
export interface ToolRegistrationAdapters {
  readonly coding?: LegacyCodingToolMetadata | undefined;
  readonly agent?: AgentTool | undefined;
}

export interface ToolRegistration {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
  readonly effectProjector?: ToolEffectProjector;
  readonly securityFactsProjector?: ToolSecurityFactsProjector;
  readonly modelGuidance?: ToolModelGuidance;
  readonly adapters?: ToolRegistrationAdapters;
}
