import type {
  AgentError,
  EventId,
  TimestampMs,
  VerificationCheckId,
  VerificationPlan,
  VerifiedRunFinalResult,
} from "@caelush/protocol";
import type { RunExecutionDirective, RunExecutionEffectResult } from "@caelush/agent";
import { isTerminalRunStatus } from "@caelush/agent";
import type { EventIdFactory } from "./run-controller-ports.js";
import { createRunControllerEventFactory } from "./run-controller-events.js";
import type { RunControllerEventFactory } from "./run-controller-events.js";
import { deriveRunDeadline } from "./run-deadline.js";
import type {
  DurableEventDraft,
  RunExecutionCommitView,
  RunExecutionSnapshotView,
} from "./run-execution-store.js";

/**
 * The durable Run commit event materializer.
 *
 * ```text
 * RunTransitionPlanner          snapshot + directive + effect -> a commit with no events
 * RunCommitEventMaterializer    that commit -> the same commit with its durable events
 * ```
 *
 * This is a **transitional host adapter**, not a kernel contract. The planner is pure and owns no
 * `EventId` factory, and this is the boundary that turns its description into publishable events —
 * which is why it lives in Core, next to the event vocabulary it reuses rather than duplicates.
 *
 * It decides nothing. It reads the transition the planner already made and names the events that
 * describe it:
 *
 * ```text
 * it may change   events, and only events
 * it never       re-derives a status, settles a Step, picks a continuation, or makes a retry,
 *                completion, Tool or budget decision
 * ```
 *
 * Events whose payload would require a fact this layer does not hold are deliberately **not**
 * produced. A verified `run.completed` needs a `VerifiedRunFinalResult`; the general completion
 * result is not one, and inventing the difference would durably claim a seal nobody produced. Those
 * branches are materialized as `status.changed` alone, and the gap is reported rather than hidden.
 */

/** Who owns the Run a commit belongs to. */
export interface RunOwnershipContext {
  /**
   * The only `EventId` authority in this boundary.
   *
   * The materializer asks for an id; it never mints one. A raw `randomUUID` here would be a second
   * identity authority, and durable event identity is what recovery orders by.
   */
  readonly eventIds: EventIdFactory;
}

export interface RunCommitEventMaterializerInput {
  /** The durable state the effect was executed against — the "before" of every event. */
  readonly snapshot: RunExecutionSnapshotView;
  readonly directive: RunExecutionDirective;
  readonly effect: RunExecutionEffectResult;
  /** The planner's answer. Its `events` are expected to be empty and are replaced wholesale. */
  readonly plannedCommit: RunExecutionCommitView;
  readonly now: TimestampMs;
  /**
   * Whether the provider turn behind this effect actually ran.
   *
   * ```text
   * CORE-PRIVATE — not part of the frozen RunExecutionEffectResult
   * ```
   *
   * The frozen effect result describes the *decision*. Whether a provider call happened at all is
   * something only the facade that made it observed, and the two do not coincide: a classifier that
   * refuses a model's output completes a provider turn and fails the Reason, so the ledger records
   * `llm.completed` and `run.failed` for the same attempt.
   *
   * Absent means no provider turn was reported, which is the conservative reading: the attempt is
   * described by its outcome alone.
   */
  readonly providerTurnState?: "NOT_STARTED" | "COMPLETED" | "FAILED" | "CANCELLED";
  /**
   * What the completion evaluation established, when this effect was one.
   *
   * ```text
   * CORE-PRIVATE — not part of the frozen RunExecutionEffectResult
   * ```
   *
   * `run.completed` may only ever be produced for a candidate that carries a `VerifiedRunFinalResult`
   * **and** a valid completion seal. The frozen `CompletionGateDecision.ACCEPT` carries the result but
   * not the seal, so this boundary cannot decide on its own whether a completion is a *verified* one.
   * A generic host's accept-directly result is a perfectly good `AgentCompletionResult` and is
   * deliberately not a `VerifiedRunFinalResult` — and emitting `run.completed` for it would durably
   * publish a verification that never happened.
   *
   * So the materializer reads the sealed facts from here and emits the completion events only when they
   * are present and consistent. Absent means a generic completion: `status.changed` alone, and the gap
   * is reported rather than hidden.
   */
  readonly completion?: CompletionEventEvidence | undefined;
  readonly ownership: RunOwnershipContext;
}

/**
 * The verified facts a completion event needs.
 *
 * Every field is a value the completion gate actually produced. Nothing here is inferred from a
 * decision: a `run.completed` payload is the accepted result, and a seal hash belongs to the seal that
 * was created.
 */
export interface CompletionEventEvidence {
  /** The plan this completion verified against. */
  readonly plan: VerificationPlan;
  /** The exact result the gate accepted, which must be the decision's own result. */
  readonly verifiedFinalResult: VerifiedRunFinalResult;
  /** The seal hash the verified result carries. */
  readonly sealHash: string;
  readonly failedCheckIds?: readonly VerificationCheckId[] | undefined;
  readonly errorCheckIds?: readonly VerificationCheckId[] | undefined;
}

export interface RunCommitEventMaterializer {
  materialize(input: RunCommitEventMaterializerInput): RunExecutionCommitView;
}

export interface RunCommitEventMaterializerDependencies {
  /** Reused verbatim, so there is no second event vocabulary. */
  readonly eventFactory?: RunControllerEventFactory;
}

/** Create the materializer over the existing Run Controller event factory. */
export function createRunCommitEventMaterializer(
  dependencies: RunCommitEventMaterializerDependencies = {},
): RunCommitEventMaterializer {
  const events = dependencies.eventFactory ?? createRunControllerEventFactory();

  return {
    materialize(input: RunCommitEventMaterializerInput): RunExecutionCommitView {
      const { snapshot, directive, effect, plannedCommit, now, ownership } = input;
      const providerTurnState = input.providerTurnState ?? "NOT_STARTED";
      const before = snapshot.run;
      const after = plannedCommit.run;
      const drafts: DurableEventDraft[] = [];
      const nextEventId = (): EventId => ownership.eventIds.create();

      const completed = stepSettledAs(plannedCommit, "COMPLETED");
      const failed = stepSettledAs(plannedCommit, "FAILED");
      const failure = terminalFailure(directive, effect);

      /*
       * 1. What the executed attempt produced.
       *
       * A settled model turn is described by the Step the planner already settled and the state it
       * already computed. Nothing here re-decides whether the turn succeeded.
       */
      if (effect.kind === "AGENT") {
        const state = plannedCommit.state ?? snapshot.state;
        const settled = completed ?? failed;
        if (providerTurnState === "COMPLETED" && state !== undefined && settled !== undefined) {
          /*
           * The provider answered. The ledger records that whichever way the classifier read the
           * answer, and it records the reasoning summary only for a turn that settled successfully:
           * a refused answer has no summary to report.
           */
          drafts.push(events.llmCompleted(before, state, settled, nextEventId(), now));
          if (completed?.reasoningSummary !== undefined) {
            drafts.push(
              events.reasoning(
                before,
                state,
                completed,
                completed.reasoningSummary,
                nextEventId(),
                now,
              ),
            );
          }
        } else if (failed !== undefined && failure !== undefined) {
          drafts.push(events.llmFailed(before, failed, failure, nextEventId(), now));
        }
      }

      /*
       * 2. What verification concluded, before the status it caused.
       *
       * Phase 11D froze the order as `verification.finalized`, then `status.changed`, then the terminal
       * event; on the failure path the sanitized `error` sits between the verdict and the status. The
       * completion path therefore inserts its verdict here — after everything the executed attempt
       * produced and before the status it decided — which is exactly where the ordering rule places it.
       *
       * Only a completion effect can carry a verification verdict, and only when the gate really
       * reached one: an evaluation that suspended without a decision has no outcome to publish.
       */
      if (effect.kind === "COMPLETION" && input.completion !== undefined) {
        const outcome = completionOutcome(effect.result);
        if (outcome !== undefined) {
          drafts.push(
            events.verificationFinalized(
              before,
              input.completion.plan,
              outcome,
              input.completion.failedCheckIds ?? [],
              input.completion.errorCheckIds ?? [],
              outcome === "PASSED" ? input.completion.sealHash : undefined,
              nextEventId(),
              now,
            ),
          );
        }
      }

      /*
       * 3. The sanitized error, before the status it caused.
       *
       * Phase 11D froze the failure order as `error`, `status.changed`, terminal event, and this
       * boundary is where that order is produced.
       */
      if (failure !== undefined) {
        drafts.push(events.error(before, failure, failed?.id, nextEventId(), now));
      }

      /* 4. The status the planner decided. Read, never re-derived. */
      const statusChanged = after.status !== before.status;
      if (statusChanged) {
        drafts.push(events.statusChanged(before, before.status, after.status, nextEventId(), now));
      }

      /*
       * 5. The terminal lifecycle event, when its payload is already fully determined.
       *
       * `run.completed` is emitted here and nowhere else, and only for a completion that carries a
       * verified result *and* a seal whose identity matches the plan and the result. Every other
       * terminal payload is produced from the transition alone.
       */
      if (statusChanged && isTerminalRunStatus(after.status)) {
        if (after.status === "FAILED" && failure !== undefined) {
          drafts.push(events.failed(after, failure, nextEventId(), now));
        } else if (after.status === "CANCELLED") {
          drafts.push(events.cancelled(after, nextEventId(), now));
        } else if (after.status === "TIMEOUT") {
          const deadline = deriveRunDeadline(before);
          if (deadline !== undefined) {
            drafts.push(events.timedOut(after, deadline.deadlineAt, nextEventId(), now));
          }
        } else if (after.status === "COMPLETED" && input.completion !== undefined) {
          drafts.push(
            events.completed(after, input.completion.verifiedFinalResult, nextEventId(), now),
          );
        }
      }

      // Only `events` differs. Every other field is the planner's, untouched.
      return { ...plannedCommit, events: drafts };
    },
  };
}

/**
 * The verification verdict a completion decision reached, when it reached one.
 *
 * A `REPAIR` is a failed verification that the policy allowed another attempt for, and an `ERROR` is a
 * verification that could not be completed. Those are different outcomes and stay different in the
 * ledger: reporting an error as a failure would claim a check failed when it never ran.
 */
function completionOutcome(
  decision: Extract<RunExecutionEffectResult, { kind: "COMPLETION" }>["result"],
): "PASSED" | "FAILED" | "ERROR" | undefined {
  switch (decision.kind) {
    case "ACCEPT":
      return "PASSED";
    case "REPAIR":
      return "FAILED";
    case "REJECT":
      return "FAILED";
    case "ERROR":
      return "ERROR";
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ helpers */

function stepSettledAs(
  plannedCommit: RunExecutionCommitView,
  status: "COMPLETED" | "FAILED",
): RunExecutionCommitView["stepWrites"][number]["step"] | undefined {
  return plannedCommit.stepWrites.find((write) => write.step.status === status)?.step;
}

/** The failure a terminal AGENT effect reported, when it reported one. */
function agentFailure(
  effect: Extract<RunExecutionEffectResult, { kind: "AGENT" }>,
): AgentError | undefined {
  return effect.result.kind === "FAILED" ? effect.result.error : undefined;
}

/**
 * The failure a transition carries.
 *
 * Only two sources exist, and both are read rather than inferred: a failed model turn, and a
 * completion decision that refused the candidate.
 */
function terminalFailure(
  directive: RunExecutionDirective,
  effect: RunExecutionEffectResult,
): AgentError | undefined {
  if (directive.kind === "ADVANCE_AGENT" && effect.kind === "AGENT") {
    return agentFailure(effect);
  }
  if (directive.kind === "EVALUATE_COMPLETION" && effect.kind === "COMPLETION") {
    const decision = effect.result;
    if (decision.kind === "REJECT") return decision.error;
    if (decision.kind === "ERROR") return decision.error;
  }
  return undefined;
}
