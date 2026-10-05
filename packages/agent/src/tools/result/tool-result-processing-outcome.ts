import type { JsonObject } from "@caelush/ai";

import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import type { PreparedToolSettlement } from "./result-pipeline.js";

/** A result processing failure that the durable coordinator can settle safely. */
export interface MaterializedToolFailure {
  readonly error: {
    readonly code: "TOOL_OUTPUT_ERROR" | "TOOL_OUTCOME_UNKNOWN";
    readonly phase: "TOOL" | "RUNTIME";
    readonly message: string;
  };
  readonly feedback: ToolFailureFeedback;
  readonly errorDetails?: JsonObject | undefined;
}

/** A Tool result is either safe to commit or a bounded failure for the existing durable path. */
export type ToolResultProcessingOutcome =
  | { readonly kind: "ACCEPTED"; readonly settlement: PreparedToolSettlement }
  | { readonly kind: "FAILED"; readonly failure: MaterializedToolFailure };
