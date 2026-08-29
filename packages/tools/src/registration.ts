import type { ToolDefinition } from "@caelush/protocol";
import type { ToolHandler } from "./handler.js";

export interface ToolRegistration {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
}
