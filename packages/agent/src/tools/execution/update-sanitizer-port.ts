import type { ToolInvocation, ToolName } from "@caelush/protocol";

import type { ToolExecutionUpdate } from "../types/tool-update.js";

/**
 * The transient update sanitization boundary.
 *
 * ```ts
 * sanitize(input: {
 *   readonly toolName: ToolName;
 *   readonly invocation: ToolInvocation;
 *   readonly update: ToolExecutionUpdate;
 * }): ToolExecutionUpdate | null;
 * ```
 *
 * ```text
 * a sanitized update   may reach the transient consumer
 * null                 the update is dropped
 * ```
 *
 * ## Why this port is not the result sanitizer
 *
 * A transient update has no durable consequence: nothing downstream depends on it, so a sanitizer
 * problem costs one update and must not cost the Tool run. A final result is the opposite — a
 * sanitizer failure there is settlement-blocking, because no durable observation can be produced
 * safely. The two ports therefore have deliberately different failure semantics even though the same
 * redaction primitives back both.
 *
 * ## Hard rules
 *
 * ```text
 * no unsanitized fallback    a sanitizer failure drops the update, it never forwards the raw one
 * no durable write           an update never reaches an observation, an event or a conversation
 * no execution influence     a sanitized update never changes arguments, a decision or a result
 * ```
 *
 * The implementation is supplied by an outer adapter — the Security package for the production
 * composition — because `@caelush/agent` must not depend on a redaction implementation.
 */
export interface ToolExecutionUpdateSanitizerPort {
  sanitize(input: {
    readonly toolName: ToolName;
    readonly invocation: ToolInvocation;
    readonly update: ToolExecutionUpdate;
  }): ToolExecutionUpdate | null;
}

/**
 * Where a sanitized transient update is delivered.
 *
 * `publish` is called from the executor's ordered drain, never from the Tool's stack. A consumer may
 * return a promise; the executor serializes deliveries so two updates from one invocation can never
 * be observed out of order. A consumer failure is observational only: it is reported to diagnostics
 * and it cannot change the durable result.
 */
export interface TransientToolUpdateConsumer {
  publish(input: {
    readonly toolName: ToolName;
    readonly invocation: ToolInvocation;
    readonly update: ToolExecutionUpdate;
  }): void | Promise<void>;
}

/** Best-effort diagnostics for the update path. It must never throw through to execution. */
export interface TransientToolUpdateDiagnostics {
  onUpdateDropped(input: {
    readonly toolName: ToolName;
    readonly invocationId: ToolInvocation["id"];
    readonly reason: "ORPHAN" | "SANITIZER_REJECTED" | "SANITIZER_FAILED";
    readonly cause?: unknown;
  }): void;
  onDeliveryFailed(input: {
    readonly toolName: ToolName;
    readonly invocationId: ToolInvocation["id"];
    readonly cause: unknown;
  }): void;
}

/**
 * A transient consumer that discards everything.
 *
 * This is the correct production choice until a host has a real ephemeral transport for Tool
 * progress: the update semantics are established and exercised, and nothing is delivered anywhere it
 * could leak. Phase 4E wires actual Coding builtin progress; product transport belongs to the UI
 * layer.
 */
export const DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER: TransientToolUpdateConsumer = Object.freeze(
  {
    publish(): void {
      // A transient update has no durable meaning, so discarding it is always safe.
    },
  },
);
