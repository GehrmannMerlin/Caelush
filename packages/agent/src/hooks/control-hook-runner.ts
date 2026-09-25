import type { TimestampMs } from "@caelush/protocol";
import {
  ControlHookAbortedError,
  ControlHookReentrancyError,
  ControlHookTimeoutError,
} from "./control-hook-errors.js";
import type {
  ControlHook,
  ControlHookContext,
  ControlHookInvocation,
  ControlHookPipelinePolicy,
  ControlHookPipelineResult,
  ControlHookReceipt,
  ControlHookRegistration,
  ControlHookRegistry,
} from "./control-hook.js";

export interface ControlHookRunnerDependencies {
  readonly pipelineId: string;
  readonly clock: { now(): TimestampMs };
  readonly fingerprint?: (value: unknown) => string;
}

export interface ControlHookRunner {
  run<TInput, TResult>(
    registry: ControlHookRegistry<ControlHook<TInput, TResult>>,
    input: TInput,
    context: ControlHookContext,
    policy: ControlHookPipelinePolicy<TResult>,
  ): Promise<ControlHookPipelineResult<TResult>>;
}

export function createControlHookRunner(
  dependencies: ControlHookRunnerDependencies,
): ControlHookRunner {
  const activePipelines = new WeakMap<AbortSignal, Set<string>>();
  const run: ControlHookRunner["run"] = async <TInput, TResult>(
    registry: ControlHookRegistry<ControlHook<TInput, TResult>>,
    input: TInput,
    context: ControlHookContext,
    policy: ControlHookPipelinePolicy<TResult>,
  ): Promise<ControlHookPipelineResult<TResult>> => {
    if (context.signal.aborted) throw new ControlHookAbortedError();
    const active = activePipelines.get(context.signal) ?? new Set<string>();
    if (active.has(dependencies.pipelineId)) {
      throw new ControlHookReentrancyError(dependencies.pipelineId);
    }
    active.add(dependencies.pipelineId);
    activePipelines.set(context.signal, active);

    const receipts: ControlHookReceipt[] = [];
    const invocations: ControlHookInvocation<TResult>[] = [];
    let current = policy.initial;
    try {
      for (const registration of registry.list()) {
        if (context.signal.aborted) throw new ControlHookAbortedError();
        const startedAt = dependencies.clock.now();
        try {
          const next = await invokeWithTimeout(
            registration,
            input,
            context,
            activePipelines,
            dependencies.pipelineId,
          );
          if (context.signal.aborted) throw new ControlHookAbortedError();
          current = policy.onResult(
            current,
            next,
            registration as ControlHookRegistration<ControlHook<unknown, TResult>>,
          );
          const finishedAt = dependencies.clock.now();
          receipts.push(
            receipt(dependencies, registration, "APPLIED", startedAt, finishedAt, input, next),
          );
          invocations.push({ hookId: registration.id, outcome: "APPLIED", result: next });
        } catch (error) {
          if (error instanceof ControlHookAbortedError || context.signal.aborted) {
            throw new ControlHookAbortedError();
          }
          const decision = policy.onFailure({
            registration: registration as ControlHookRegistration<ControlHook<unknown, TResult>>,
            error,
            current,
          });
          const finishedAt = dependencies.clock.now();
          receipts.push(
            receipt(dependencies, registration, "FAILED", startedAt, finishedAt, input),
          );
          invocations.push({ hookId: registration.id, outcome: "FAILED" });
          if (decision.kind === "THROW") throw decision.error;
          current = decision.result;
        }
      }
      return { result: current, receipts, invocations };
    } finally {
      active.delete(dependencies.pipelineId);
      if (active.size === 0) activePipelines.delete(context.signal);
    }
  };

  return { run };
}

async function invokeWithTimeout<TInput, TResult>(
  registration: ControlHookRegistration<ControlHook<TInput, TResult>>,
  input: TInput,
  context: ControlHookContext,
  activePipelines: WeakMap<AbortSignal, Set<string>>,
  pipelineId: string,
): Promise<TResult> {
  const child = new AbortController();
  const childScope = new Set(activePipelines.get(context.signal) ?? []);
  childScope.add(pipelineId);
  activePipelines.set(child.signal, childScope);
  let timeout = false;
  let rejectAbort!: (error: Error) => void;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onParentAbort = () => {
    child.abort();
    rejectAbort(new ControlHookAbortedError());
  };
  if (context.signal.aborted) onParentAbort();
  else context.signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    child.abort();
    rejectAbort(new ControlHookTimeoutError());
  }, registration.timeoutMs);
  const invocation = Promise.resolve().then(() =>
    registration.hook.invoke(input, { ...context, signal: child.signal }),
  );
  // A non-cooperative Hook can settle after timeout. Attach a rejection handler immediately so its
  // late failure is observed and isolated even though the race has already returned.
  void invocation.catch(() => undefined);
  try {
    return await Promise.race([invocation, abort]);
  } catch (error) {
    if (context.signal.aborted || error instanceof ControlHookAbortedError) {
      throw new ControlHookAbortedError();
    }
    if (timeout || error instanceof ControlHookTimeoutError) throw new ControlHookTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onParentAbort);
    activePipelines.delete(child.signal);
  }
}

function receipt<TInput, TResult>(
  dependencies: ControlHookRunnerDependencies,
  registration: ControlHookRegistration<ControlHook<TInput, TResult>>,
  outcome: ControlHookReceipt["outcome"],
  startedAt: TimestampMs,
  finishedAt: TimestampMs,
  input: TInput,
  output?: TResult,
): ControlHookReceipt {
  return {
    pipeline: dependencies.pipelineId,
    hookId: registration.id,
    outcome,
    startedAt,
    finishedAt,
    ...(dependencies.fingerprint === undefined
      ? {}
      : {
          inputFingerprint: dependencies.fingerprint(input),
          ...(output === undefined ? {} : { outputFingerprint: dependencies.fingerprint(output) }),
        }),
  };
}
