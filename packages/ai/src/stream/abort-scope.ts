/**
 * Why an AI invocation stopped.
 *
 * The three causes are deliberately distinct even though they all end in one
 * aborted `AbortSignal`. A caller needs to tell "the user cancelled", "we ran out
 * of time" and "the consumer stopped reading" apart: only the first is a user
 * intent, and only the second is a timeout.
 */
export type AIAbortKind = "external" | "timeout" | "consumer";

const timeoutAbortReason = Symbol("caelush-ai-timeout");
const externalAbortReason = Symbol("caelush-ai-external-abort");
const consumerCancelledReason = Symbol("caelush-ai-consumer-cancelled");

/**
 * One invocation's abort coordination.
 *
 * The scope owns its own `AbortSignal`. The external signal is *observed*, never
 * forwarded, so a caller cannot abort anything beyond this invocation and the
 * adapter always receives the scope's signal.
 */
export interface AbortScope {
  readonly signal: AbortSignal;
  /** Resolves with the first cause that fired. */
  readonly aborted: Promise<AIAbortKind>;
  /** The first cause that fired, or `undefined` while the invocation is live. */
  kind(): AIAbortKind | undefined;
  /** Cancel because the consumer stopped reading the stream. */
  abortConsumer(): void;
  /** Detach the timer and the external listener. Always call this. */
  cleanup(): void;
}

/**
 * Create an abort scope.
 *
 * The first cause to fire wins and is never replaced, so a late timeout cannot
 * relabel an invocation the user already cancelled.
 *
 * @param externalSignal the caller's signal, if any
 * @param timeoutMs the invocation timeout, or `undefined` for no timeout
 */
export function createAbortScope(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortScope {
  const controller = new AbortController();
  let abortKind: AIAbortKind | undefined;
  let resolveAborted: ((kind: AIAbortKind) => void) | undefined;
  const aborted = new Promise<AIAbortKind>((resolve) => {
    resolveAborted = resolve;
  });

  const abort = (kind: AIAbortKind, reason: unknown): void => {
    if (abortKind !== undefined) return;
    abortKind = kind;
    controller.abort(reason);
    resolveAborted?.(kind);
  };

  const onExternalAbort = (): void => {
    abort("external", externalAbortReason);
  };

  if (externalSignal?.aborted === true) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          abort("timeout", timeoutAbortReason);
        }, timeoutMs);

  return {
    signal: controller.signal,
    aborted,
    kind: () => abortKind,
    abortConsumer: () => {
      abort("consumer", consumerCancelledReason);
    },
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}
