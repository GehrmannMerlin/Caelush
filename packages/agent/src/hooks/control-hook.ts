import type { RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";

/** A non-empty, validated identifier for one registered Control Hook. */
export type ControlHookId = string & { readonly __controlHookId: unique symbol };

export function createControlHookId(value: string): ControlHookId {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlHookConfigurationError("Control Hook id must be non-empty.");
  }
  return value as ControlHookId;
}

export type ControlHookCriticality = "REQUIRED" | "OPTIONAL";
export type HookFailurePolicy = "FAIL_CLOSED" | "FAIL_OPERATION" | "SKIP_WITH_DIAGNOSTIC";

export interface ControlHookRegistration<THook> {
  readonly id: ControlHookId;
  readonly priority: number;
  readonly criticality: ControlHookCriticality;
  readonly timeoutMs: number;
  readonly hook: THook;
}

export interface ControlHookRegistry<THook> {
  list(): readonly ControlHookRegistration<THook>[];
}

export interface ControlHookRegistryBuilder<THook> {
  register(registration: ControlHookRegistration<THook>): this;
  build(): ControlHookRegistry<THook>;
}

export interface ControlHookContext {
  readonly identity: {
    readonly runId: RunId;
    readonly sessionId: SessionId;
  };
  readonly stepId?: StepId;
  readonly mode: "EXECUTE" | "RECOVER";
  readonly signal: AbortSignal;
}

export interface ControlHook<TInput, TResult> {
  invoke(input: TInput, context: ControlHookContext): Promise<TResult>;
}

export interface ControlHookReceipt {
  readonly pipeline: string;
  readonly hookId: ControlHookId;
  readonly outcome: "APPLIED" | "SKIPPED" | "FAILED";
  readonly startedAt: TimestampMs;
  readonly finishedAt: TimestampMs;
  readonly inputFingerprint?: string;
  readonly outputFingerprint?: string;
}

export interface ControlHookInvocation<TResult> {
  readonly hookId: ControlHookId;
  readonly outcome: "APPLIED" | "SKIPPED" | "FAILED";
  readonly result?: TResult;
}

export interface ControlHookPipelineResult<TResult> {
  readonly result: TResult;
  readonly receipts: readonly ControlHookReceipt[];
  readonly invocations: readonly ControlHookInvocation<TResult>[];
}

export interface ControlHookPipelinePolicy<TResult> {
  /** The host-owned identity element for an empty registry. */
  readonly initial: TResult;
  onResult(
    current: TResult,
    next: TResult,
    registration?: ControlHookRegistration<ControlHook<unknown, TResult>>,
  ): TResult;
  onFailure(input: {
    readonly registration: ControlHookRegistration<ControlHook<unknown, TResult>>;
    readonly error: unknown;
    readonly current: TResult;
  }):
    | { readonly kind: "THROW"; readonly error: Error }
    | { readonly kind: "CONTINUE"; readonly result: TResult };
}

export function createControlHookRegistryBuilder<THook>(): ControlHookRegistryBuilder<THook> {
  const registrations: ControlHookRegistration<THook>[] = [];
  return {
    register(registration) {
      registrations.push(registration);
      return this;
    },
    build() {
      const seen = new Set<string>();
      const sorted = registrations.map((registration) => {
        validateRegistration(registration);
        if (seen.has(registration.id)) {
          throw new ControlHookConfigurationError(`Duplicate Control Hook id: ${registration.id}.`);
        }
        seen.add(registration.id);
        return Object.freeze({ ...registration });
      });
      sorted.sort(
        (left, right) => left.priority - right.priority || compareHookIds(left.id, right.id),
      );
      const frozen = Object.freeze(sorted);
      return Object.freeze({
        list: () => frozen,
      }) satisfies ControlHookRegistry<THook>;
    },
  };
}

function compareHookIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRegistration<THook>(registration: ControlHookRegistration<THook>): void {
  if (typeof registration.id !== "string" || registration.id.trim().length === 0) {
    throw new ControlHookConfigurationError("Control Hook id must be non-empty.");
  }
  if (
    !Number.isSafeInteger(registration.priority) ||
    registration.priority < 0 ||
    registration.priority > 100_000
  ) {
    throw new ControlHookConfigurationError(
      "Control Hook priority must be a safe integer from 0 through 100000.",
    );
  }
  if (registration.criticality !== "REQUIRED" && registration.criticality !== "OPTIONAL") {
    throw new ControlHookConfigurationError("Control Hook criticality is invalid.");
  }
  if (!Number.isSafeInteger(registration.timeoutMs) || registration.timeoutMs <= 0) {
    throw new ControlHookConfigurationError(
      "Control Hook timeoutMs must be a positive safe integer.",
    );
  }
  if (typeof registration.hook !== "object" || registration.hook === null) {
    throw new ControlHookConfigurationError(
      "Control Hook registration must provide a callable hook.",
    );
  }
  const callable = registration.hook as { invoke?: unknown; contribute?: unknown };
  if (typeof callable.invoke !== "function" && typeof callable.contribute !== "function") {
    throw new ControlHookConfigurationError(
      "Control Hook registration must provide a callable hook.",
    );
  }
}

export class ControlHookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlHookConfigurationError";
  }
}
