import type { ToolInvocation } from "@caelush/protocol";

export const UNCERTAIN_SIDE_EFFECT = "UNCERTAIN_SIDE_EFFECT" as const;

export function isUncertainToolExecution(invocation: ToolInvocation): boolean {
  return invocation.error?.details?.executionDisposition === UNCERTAIN_SIDE_EFFECT;
}
