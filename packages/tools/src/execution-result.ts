import type { JsonObject } from "@caelush/protocol";

export interface ToolExecutionResult {
  readonly content: string;
  readonly details: JsonObject;
  readonly isError: boolean;
}
