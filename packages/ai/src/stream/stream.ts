import type { AIStreamEvent } from "./events.js";
import type { LLMCallId } from "../ids/llm-call-id.js";

/**
 * A gateway-owned model invocation stream.
 *
 * `callId` is available immediately, before the first event, because the gateway
 * mints it during preflight. The event sequence itself always begins with
 * `stream.start`.
 */
export interface AIStream {
  readonly callId: LLMCallId;
  readonly events: AsyncIterable<AIStreamEvent>;
}

/** Options for one invocation. */
export interface AIStreamOptions {
  /** The caller's cancellation signal. */
  readonly signal?: AbortSignal;
  /** Invocation timeout in milliseconds; overrides the subsystem default. */
  readonly timeoutMs?: number;
}
