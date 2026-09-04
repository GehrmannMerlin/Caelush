import type { ToolDefinition } from "@caelush/protocol";
import type { ToolHandler } from "./handler.js";
import type { ToolEffectProjector } from "./tool-effects.js";
import type { ToolSecurityFactsProjector } from "./security-facts.js";
import type { ToolModelGuidance } from "./model-guidance.js";

export interface ToolRegistration {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
  readonly effectProjector?: ToolEffectProjector;
  readonly securityFactsProjector?: ToolSecurityFactsProjector;
  readonly modelGuidance?: ToolModelGuidance;
}
