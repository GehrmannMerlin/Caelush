type AbortKind = "external" | "timeout" | "consumer";

const timeoutAbortReason = Symbol("caelush-llm-timeout");
const externalAbortReason = Symbol("caelush-llm-external-abort");
const consumerCancelledReason = Symbol("caelush-llm-consumer-cancelled");

interface AbortScope {
  readonly signal: AbortSignal;
  readonly aborted: Promise<AbortKind>;
  readonly kind: () => AbortKind | undefined;
  readonly abortConsumer: () => void;
  readonly cleanup: () => void;
}

export function createAbortScope(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortScope {
  const controller = new AbortController();
  let abortKind: AbortKind | undefined;
  let resolveAborted: ((kind: AbortKind) => void) | undefined;
  const aborted = new Promise<AbortKind>((resolve) => {
    resolveAborted = resolve;
  });
  const abort = (kind: AbortKind, reason: unknown): void => {
    if (abortKind !== undefined) return;
    abortKind = kind;
    controller.abort(reason);
    resolveAborted?.(kind);
  };

  const onExternalAbort = (): void => abort("external", externalAbortReason);
  if (externalSignal?.aborted === true) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => abort("timeout", timeoutAbortReason), timeoutMs);

  return {
    signal: controller.signal,
    aborted,
    kind: () => abortKind,
    abortConsumer: () => abort("consumer", consumerCancelledReason),
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}
