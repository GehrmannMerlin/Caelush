/**
 * The transient agent stream contract.
 *
 * A model turn produces two very different kinds of output:
 *
 * ```text
 * durable    the assembled turn result, through the frozen ModelTurnExecutor union
 * transient  live deltas a host may display while the turn is still running
 * ```
 *
 * Only the transient half travels through this contract, and only the three delta
 * kinds. `stream.start`, `stream.finish`, `stream.error`, `usage`, `tool_call.start`
 * and `tool_call.completed` are deliberately absent: the first three are AI gateway
 * envelope lifecycle, `usage` is durable accounting, and the two tool-call lifecycle
 * events belong to the assembler and the durable tool domain. A host that received
 * them here would have a second, unversioned copy of the turn lifecycle next to the
 * frozen result.
 *
 * Transient means exactly that: nothing in this union is durable assistant content.
 * A reasoning summary in particular must never become assistant text or history.
 */

/** Assistant text produced while the turn is still running. */
export interface AgentTransientTextDelta {
  readonly type: "text.delta";
  readonly text: string;
}

/**
 * A display-only reasoning summary delta.
 *
 * Raw model chain-of-thought must never enter a Caelush contract. Only a summary a
 * provider explicitly produced for display may travel here, and it is never durable.
 */
export interface AgentTransientThinkingDelta {
  readonly type: "thinking.delta";
  readonly text: string;
}

/**
 * Argument text for an already-announced tool call.
 *
 * This is partial provider output: it must never be executed, parsed into arguments or
 * persisted. Only the completed call inside the frozen turn result is executable.
 */
export interface AgentTransientToolCallDelta {
  readonly type: "tool_call.delta";
  readonly toolCallId: string;
  readonly delta: string;
}

/** Any transient agent stream event. */
export type AgentTransientStreamEvent =
  AgentTransientTextDelta | AgentTransientThinkingDelta | AgentTransientToolCallDelta;

/** Every transient event type, in canonical order. */
export const AGENT_TRANSIENT_STREAM_EVENT_TYPES = [
  "text.delta",
  "thinking.delta",
  "tool_call.delta",
] as const satisfies readonly AgentTransientStreamEvent["type"][];

/**
 * The transient stream sink.
 *
 * `publish` may be synchronous or asynchronous, and it is presentation-only: a sink
 * that throws can never corrupt the model turn, which is why the executor isolates it
 * from the frozen result. The sink owns its own delivery guarantees.
 */
export interface ModelTurnStreamSink {
  publish(event: AgentTransientStreamEvent): void | Promise<void>;
}
