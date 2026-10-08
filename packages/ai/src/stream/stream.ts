import type { AIStreamEvent } from "./events.js";
import type { LLMCallId } from "../ids/llm-call-id.js";
import type { AIPrivateCompletion, AIPrivateReplayResolver } from "./private-completion.js";
import type { ApiId } from "../ids/api-id.js";
import type { ProviderId } from "../ids/provider-id.js";
import type { ModelRef } from "../models/model-ref.js";
import type { ModelUsage } from "../models/model-usage.js";

export const DEFAULT_PROVIDER_NUDGE_AFTER_MS = 30_000;
export const DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_PROVIDER_TEARDOWN_GRACE_MS = 5_000;

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
  /**
   * Consume the Gateway-private native completion after `events` settles. It is never part of the
   * public event stream or AIModelTurnResult and is available at most once.
   */
  takePrivateCompletion(): AIPrivateCompletion | undefined;
}

/** Options for one invocation. */
export interface AIStreamOptions {
  /** The caller's cancellation signal. */
  readonly signal?: AbortSignal;
  /** Invocation timeout in milliseconds; overrides the subsystem default. */
  readonly timeoutMs?: number;
  /** A preconfigured equivalent Provider transport selected by the Run Layer. */
  readonly transportId?: string;
  /** Publish a recent-activity status after this many silent milliseconds. */
  readonly nudgeAfterMs?: number;
  /** Cancel the real Provider transport after this many silent milliseconds. */
  readonly idleTimeoutMs?: number;
  /** Maximum time to await adapter iterator teardown after cancellation. */
  readonly teardownGraceMs?: number;
  /** Host-only resolver for private state attached to the messages in this exact request. */
  readonly privateReplayResolver?: AIPrivateReplayResolver;
  /** Host-only durable accounting sideband; it never enters the public stream or provider request. */
  readonly invocationObserver?: AIInvocationAccountingObserver;
}

export interface AIInvocationAccountingIdentity {
  readonly callId: LLMCallId;
  readonly providerId: ProviderId;
  readonly model: ModelRef;
  readonly api: ApiId;
  readonly continuityGroup: string;
  readonly requestFingerprint: string;
}

export interface AIInvocationAccountingObserver {
  /** Runs after Gateway preflight and before the adapter can issue provider I/O. */
  onStarted(identity: AIInvocationAccountingIdentity): void | Promise<void>;
  /** Runs once after normal finish, provider failure, timeout, or consumer cancellation. */
  onSettled(input: {
    readonly callId: LLMCallId;
    readonly status: "COMPLETE" | "FAILED" | "CANCELLED";
    readonly usage?: ModelUsage;
  }): void | Promise<void>;
}
