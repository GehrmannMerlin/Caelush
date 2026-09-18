import type { RunId, SessionId, StepId, ToolInvocationId } from "@caelush/protocol";

/**
 * Who a Tool execution is, for the whole of its life.
 *
 * ```text
 * runId           the Run Lifecycle Authority's identity for the work
 * sessionId       the durable Session the Run belongs to
 * sourceStepId    the Agent Step whose model turn requested this call
 * invocationId    the durable ToolInvocation identity
 * externalCallId  the provider-neutral model tool-call id
 * ```
 *
 * This replaces the flat identity the legacy `ToolExecutionRequest` carried
 * (`runId` / `stepId` / `invocationId` / `externalCallId`) with one value so identity can be passed
 * as a value rather than re-listed by every component. `sourceStepId` maps to the durable
 * `ToolInvocation.stepId` in the first migration wave, which is why the field is not named `stepId`:
 * the identity is *where the call came from*, not *where an invocation happens to be now*.
 *
 * `(runId, sourceStepId, externalCallId)` remains the idempotency identity. A Tool must never
 * generate or rewrite `externalCallId`: it identifies a model request, and the Tool Layer preserves
 * it unchanged from the model turn that produced it.
 */
export interface ToolExecutionIdentity {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sourceStepId: StepId;
  readonly invocationId: ToolInvocationId;
  readonly externalCallId: string;
}
