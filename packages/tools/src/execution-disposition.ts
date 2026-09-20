import type { ToolInvocation } from "@caelush/protocol";

/**
 * The canonical uncertainty vocabulary, under the legacy entry point.
 *
 * ```text
 * @caelush/agent   declares UNCERTAIN_SIDE_EFFECT and ToolExecutionUncertainError
 * @caelush/tools   re-exports both, so an existing builtin keeps importing them from here
 * ```
 *
 * The re-export is a *binding*, not a subclass: a builtin that throws the error it imported from
 * `@caelush/tools` throws the canonical class, so `instanceof` agrees in both packages and the
 * canonical executor recognizes an uncertain execution without inspecting an error message.
 */
export { UNCERTAIN_SIDE_EFFECT, ToolExecutionUncertainError } from "@caelush/agent";

/** True when a durable invocation was settled with an unproven side effect. */
export function isUncertainToolExecution(invocation: ToolInvocation): boolean {
  return invocation.error?.details?.executionDisposition === "UNCERTAIN_SIDE_EFFECT";
}
