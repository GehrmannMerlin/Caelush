import { isTerminalRunStatus } from "@caelush/core";
import type { AgentRun, RunId, RunStatus } from "@caelush/protocol";
import type { RunRepository } from "@caelush/storage";

import type {
  RunExecutionSupervisor,
  RunExecutionSupervisorLogger,
} from "./run-execution-supervisor.js";

/**
 * Periodic liveness sweep for Runs that no driver owns any more.
 *
 * ```text
 * startup reconciliation   runs once, on boot
 * liveness sweep           runs forever, while this daemon is alive
 * ```
 *
 * Startup reconciliation already knows how to hand a stale Run to the *existing* recovery
 * authority. What it cannot cover is a Run that goes silent **while the daemon is running**:
 *
 * ```text
 * VERIFYING              a check finished with ERROR and nothing re-entered the loop
 * WAITING_APPROVAL       the approval expired and nothing resolved it
 * RUNNING                a retry timer was lost, or a driver vanished with its promise
 * ```
 *
 * Measured against real Runs, those three states produced 11.6 h and 78.9 h of silence before a
 * restart settled them. This sweeper is the missing periodic half: it enumerates non-terminal Runs,
 * and hands the ones without an active driver back to `RunExecutionSupervisor.recover()`.
 *
 * ## What it deliberately is not
 *
 * ```text
 * not a state machine     it never writes Storage and never invents a transition
 * not a supervisor        `recover()` keeps every disposition it already had
 * not a watchdog timer    it does not cancel, time out, or fail a Run
 * not a queue             it never starts a PENDING Run; starting is a user action
 * ```
 *
 * Recovery is idempotent by contract: an already-settled Run returns `NOOP_TERMINAL`, an
 * already-driven Run returns `ALREADY_ACTIVE`, and a waiting Run restores the same wait. That is
 * why running it repeatedly is safe, and why the cooldown below is about cost, not correctness.
 *
 * ## Why "idle" is measured from observation, not from a timestamp
 *
 * `AgentRun` has no `updatedAt`, and reading each Run's durable tail just to ask "when did anything
 * last happen" would cost one replay per Run per tick. Instead the sweeper records when it *first*
 * saw a Run without a driver. That is a lower bound on idleness: a Run that was active one second
 * ago and is idle now still gets its full grace period before the first recovery attempt, and a
 * Run that was already idle for an hour is not swept in the same tick it is discovered.
 */

export interface RunLivenessPolicy {
  /** How often the sweep runs. */
  readonly intervalMs: number;
  /** Silence required before a `RUNNING` Run without a driver is recovered. */
  readonly runningIdleMs: number;
  /** Silence required before a `VERIFYING` Run is recovered. */
  readonly verifyingIdleMs: number;
  /**
   * Silence required before a `WAITING_APPROVAL` Run is recovered.
   *
   * It must outlast the approval TTL, because a legitimately pending approval is a normal wait and
   * recovery can only restore it. Once the approval expires, the same recovery resumes the Run.
   */
  readonly approvalIdleMs: number;
  /** Minimum spacing between two recovery attempts for one Run. */
  readonly cooldownMs: number;
  /** Recovery attempts per Run per status episode; `0` disables recovery entirely. */
  readonly maxAttemptsPerRun: number;
  /** Bounded enumeration size per sweep. */
  readonly limit: number;
}

export const DEFAULT_RUN_LIVENESS_POLICY: RunLivenessPolicy = Object.freeze({
  intervalMs: 30_000,
  runningIdleMs: 120_000,
  verifyingIdleMs: 120_000,
  approvalIdleMs: 20 * 60_000,
  cooldownMs: 5 * 60_000,
  maxAttemptsPerRun: 3,
  limit: 50,
});

export interface RunLivenessSweepSummary {
  /** Non-terminal Runs the bounded enumeration returned. */
  readonly examined: number;
  /** Runs skipped because this daemon already drives them. */
  readonly active: number;
  /** Runs skipped because their status is not swept. */
  readonly ineligible: number;
  /** Runs still inside their silence window. */
  readonly waiting: number;
  /** Runs whose recovery was handed to the supervisor in this sweep. */
  readonly recovered: readonly RunId[];
  /** Runs that exhausted `maxAttemptsPerRun` for the current status episode. */
  readonly exhausted: readonly RunId[];
  /** Runs whose recovery could not be scheduled. */
  readonly failed: readonly RunId[];
}

export interface RunLivenessSweeperOptions {
  readonly runs: Pick<RunRepository, "listRecoverable">;
  readonly supervisor: Pick<RunExecutionSupervisor, "recover" | "activeRunIds">;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly policy?: Partial<RunLivenessPolicy>;
  readonly logger?: RunExecutionSupervisorLogger;
  /** Observation hook for diagnostics; it must not affect the sweep. */
  readonly onRecovery?: (event: {
    readonly runId: RunId;
    readonly status: RunStatus;
    readonly idleMs: number;
    readonly attempt: number;
  }) => void;
}

interface Observation {
  readonly status: RunStatus;
  readonly firstSeenAt: number;
  lastAttemptAt?: number;
  attempts: number;
}

/**
 * Statuses this sweeper may hand to recovery.
 *
 * `WAITING_RESOURCE` is deliberately absent: that is a decision the Run is waiting for **from the
 * user**, and re-driving it would poll a human. `PENDING` is absent because starting is an explicit
 * action, and terminal statuses are settled forever.
 */
const SWEPT_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "RUNNING",
  "VERIFYING",
  "WAITING_APPROVAL",
]);

export class RunLivenessSweeper {
  private readonly policy: RunLivenessPolicy;
  private readonly observations = new Map<RunId, Observation>();
  private timer: unknown;
  private sweeping = false;
  private stopped = false;

  constructor(private readonly options: RunLivenessSweeperOptions) {
    this.policy = { ...DEFAULT_RUN_LIVENESS_POLICY, ...options.policy };
    assertPolicy(this.policy);
  }

  /** Begin the periodic sweep. Repeated calls are a no-op. */
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const schedule = this.options.setInterval ?? defaultSetInterval;
    this.timer = schedule(() => {
      void this.sweepOnce().catch(() => undefined);
    }, this.policy.intervalMs);
  }

  /** Stop sweeping. A sweep already in flight is allowed to finish. */
  stop(): void {
    this.stopped = true;
    if (this.timer === undefined) return;
    const clear = this.options.clearInterval ?? defaultClearInterval;
    clear(this.timer);
    this.timer = undefined;
  }

  /**
   * Run one sweep.
   *
   * Every per-Run failure is isolated: one Run that cannot be scheduled must never stop the others,
   * and must never stop the daemon. Re-entrancy is refused rather than queued, because a slow sweep
   * already covers the Runs a queued one would have examined.
   */
  async sweepOnce(): Promise<RunLivenessSweepSummary> {
    if (this.sweeping || this.stopped) {
      return {
        examined: 0,
        active: 0,
        ineligible: 0,
        waiting: 0,
        recovered: [],
        exhausted: [],
        failed: [],
      };
    }
    this.sweeping = true;
    try {
      return await this.sweep();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweep(): Promise<RunLivenessSweepSummary> {
    const now = this.options.now?.() ?? Date.now();
    const runs = await this.options.runs.listRecoverable({ limit: this.policy.limit });
    const activeRunIds = new Set(this.options.supervisor.activeRunIds());
    const recovered: RunId[] = [];
    const exhausted: RunId[] = [];
    const failed: RunId[] = [];
    let active = 0;
    let ineligible = 0;
    let waiting = 0;

    for (const run of runs) {
      if (!this.isEligible(run.status)) {
        this.observations.delete(run.id);
        ineligible += 1;
        continue;
      }
      if (activeRunIds.has(run.id)) {
        this.observations.delete(run.id);
        active += 1;
        continue;
      }

      const observation = this.observe(run, now);
      if (observation.attempts >= this.policy.maxAttemptsPerRun) {
        exhausted.push(run.id);
        continue;
      }
      const idleMs = now - observation.firstSeenAt;
      if (idleMs < this.silenceFor(run.status)) {
        waiting += 1;
        continue;
      }
      if (
        observation.lastAttemptAt !== undefined &&
        now - observation.lastAttemptAt < this.policy.cooldownMs
      ) {
        waiting += 1;
        continue;
      }

      observation.attempts += 1;
      observation.lastAttemptAt = now;
      try {
        await this.options.supervisor.recover(run.id);
        recovered.push(run.id);
        this.reportRecovery(run, idleMs, observation.attempts);
      } catch (error) {
        failed.push(run.id);
        this.reportFailure(error, run.id);
      }
    }

    return {
      examined: runs.length,
      active,
      ineligible,
      waiting,
      recovered,
      exhausted,
      failed,
    };
  }

  private observe(run: AgentRun, now: number): Observation {
    const current = this.observations.get(run.id);
    if (current !== undefined && current.status === run.status) return current;
    // A status change is a new episode: the silence clock and the attempt budget both restart.
    const next: Observation = { status: run.status, firstSeenAt: now, attempts: 0 };
    this.observations.set(run.id, next);
    return next;
  }

  private isEligible(status: RunStatus): boolean {
    if (isTerminalRunStatus(status)) return false;
    return SWEPT_STATUSES.has(status);
  }

  private silenceFor(status: RunStatus): number {
    switch (status) {
      case "VERIFYING":
        return this.policy.verifyingIdleMs;
      case "WAITING_APPROVAL":
        return this.policy.approvalIdleMs;
      default:
        return this.policy.runningIdleMs;
    }
  }

  private reportRecovery(run: AgentRun, idleMs: number, attempt: number): void {
    try {
      this.options.onRecovery?.({ runId: run.id, status: run.status, idleMs, attempt });
    } catch {
      // Diagnostics must never turn a successful recovery into a failed sweep.
    }
  }

  private reportFailure(error: unknown, runId: RunId): void {
    try {
      this.options.logger?.error?.(error, { operation: "LIVENESS_RECOVER", runId });
    } catch {
      // Logging must not turn a handled recovery failure into an unhandled rejection.
    }
  }
}

function assertPolicy(policy: RunLivenessPolicy): void {
  for (const [name, value] of Object.entries({
    intervalMs: policy.intervalMs,
    runningIdleMs: policy.runningIdleMs,
    verifyingIdleMs: policy.verifyingIdleMs,
    approvalIdleMs: policy.approvalIdleMs,
    cooldownMs: policy.cooldownMs,
    limit: policy.limit,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Run liveness ${name} must be a safe positive integer.`);
    }
  }
  if (
    !Number.isSafeInteger(policy.maxAttemptsPerRun) ||
    policy.maxAttemptsPerRun < 0 ||
    policy.maxAttemptsPerRun > 100
  ) {
    throw new RangeError("Run liveness maxAttemptsPerRun must be an integer between 0 and 100.");
  }
}

function defaultSetInterval(callback: () => void, intervalMs: number): unknown {
  const handle = setInterval(callback, intervalMs);
  // Never hold the process open for a liveness sweep.
  handle.unref?.();
  return handle;
}

function defaultClearInterval(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}
