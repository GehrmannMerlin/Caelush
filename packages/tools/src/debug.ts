import type { ToolName } from "@caelush/protocol";

export type ToolCallingDebugEvent = Readonly<{
  readonly phase: "PREFLIGHT" | "GATE" | "EXECUTION";
  readonly toolName: ToolName;
  readonly argumentKeys: readonly string[];
  readonly argumentBytes: number;
  readonly validation: "PASS" | "FAIL";
  readonly normalization: "UNCHANGED" | "SAFE_NUMERIC_CONVERSION" | "NOT_APPLIED";
  readonly preflight: "READY" | "INVALID_ARGUMENTS" | "UNAVAILABLE_TOOL" | "FAILURE_MEMORY_BLOCKED";
  readonly gate?: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  readonly execution?: "STARTED" | "COMPLETED" | "MODEL_ERROR" | "BLOCKED";
}>;

/** Presentation-only diagnostics. Implementations must never execute or alter a Tool call. */
export interface ToolCallingDebugPort {
  emit(event: ToolCallingDebugEvent): void;
}
