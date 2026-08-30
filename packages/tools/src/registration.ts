import type { ToolDefinition } from "@caelush/protocol";
import type { ToolHandler } from "./handler.js";
import type { ToolEffectProjector } from "./tool-effects.js";

export interface ToolRegistration {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
  readonly effectProjector?: ToolEffectProjector;
}
