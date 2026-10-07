import type { AIAbortKind } from "./abort-scope.js";

export type SettledIteratorNext<T> =
  | { readonly kind: "NEXT"; readonly result: IteratorResult<T> }
  | { readonly kind: "ERROR"; readonly error: unknown };

export type IdleWatchdogOutcome<T> =
  | SettledIteratorNext<T>
  | { readonly kind: "NUDGE" }
  | { readonly kind: "IDLE_TIMEOUT" }
  | { readonly kind: "ABORT"; readonly abortKind: AIAbortKind };

export interface IdleWatchdogInput<T> {
  readonly pending: Promise<SettledIteratorNext<T>>;
  readonly aborted: Promise<AIAbortKind>;
  readonly providerLastActivityAt: number;
  readonly nudgeAfterMs: number;
  readonly idleTimeoutMs: number;
  readonly nudgeEmitted: boolean;
  readonly now: () => number;
}

/** Observe a single iterator read and convert synchronous or asynchronous throws into a value. */
export function observeIteratorNext<T>(
  iterator: AsyncIterator<T>,
): Promise<SettledIteratorNext<T>> {
  return Promise.resolve()
    .then(() => iterator.next())
    .then<SettledIteratorNext<T>, SettledIteratorNext<T>>(
      (result) => ({ kind: "NEXT", result }),
      (error: unknown) => ({ kind: "ERROR", error }),
    );
}

/**
 * Race one pending iterator read against the remaining nudge/idle deadlines and invocation abort.
 * The pending read itself is supplied again after a nudge, so one `next()` call is never duplicated.
 */
export async function waitForIteratorNext<T>(
  input: IdleWatchdogInput<T>,
): Promise<IdleWatchdogOutcome<T>> {
  const elapsedMs = Math.max(0, input.now() - input.providerLastActivityAt);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const outcomes: Promise<IdleWatchdogOutcome<T>>[] = [
    input.pending,
    input.aborted.then((abortKind) => ({ kind: "ABORT", abortKind }) as const),
  ];

  if (!input.nudgeEmitted) {
    outcomes.push(timerOutcome("NUDGE", Math.max(0, input.nudgeAfterMs - elapsedMs), timers));
  }
  outcomes.push(timerOutcome("IDLE_TIMEOUT", Math.max(0, input.idleTimeoutMs - elapsedMs), timers));

  try {
    return await Promise.race(outcomes);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

function timerOutcome<T>(
  kind: "NUDGE" | "IDLE_TIMEOUT",
  delayMs: number,
  timers: ReturnType<typeof setTimeout>[],
): Promise<IdleWatchdogOutcome<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind }), delayMs);
    timers.push(timer);
  });
}
