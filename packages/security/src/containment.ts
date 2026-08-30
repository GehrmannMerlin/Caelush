import type { Capability } from "@caelush/protocol";

export type ExecutionContainment = "STRUCTURED_WORKSPACE" | "UNCONFINED_PROCESS";

const UNCONFINED_PROCESS_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "SHELL_EXEC",
  "PROCESS_START",
  "PROCESS_KILL",
]);

export function requiresUnconfinedProcess(required: readonly Capability[]): boolean {
  return required.some((capability) => UNCONFINED_PROCESS_CAPABILITIES.has(capability));
}

export function classifyExecutionContainment(
  required: readonly Capability[],
): ExecutionContainment {
  return requiresUnconfinedProcess(required) ? "UNCONFINED_PROCESS" : "STRUCTURED_WORKSPACE";
}
