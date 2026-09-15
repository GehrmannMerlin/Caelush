import type { AIMessage, AIToolResultMessage } from "@caelush/ai";
import {
  AgentRunSchema,
  type AgentRun,
  type AgentState,
  type StepId,
  type TimestampMs,
} from "@caelush/protocol";

import type { AgentLoopAdvanceResult } from "../loop/types.js";
import type { RunExecutionDirective } from "./directive.js";
import type { RunExecutionEffectResult } from "./effect-result.js";
import type { AgentToolResult, ToolTurnResult } from "./ports/tool-turn.js";
import { RunExecutionInvariantError } from "./ports/run-execution-store.js";
import type {
  RunExecutionCommit,
  RunExecutionMessageAppend,
  RunExecutionSnapshot,
  RunExecutionStepWrite,
} from "./ports/run-execution-store.js";
import type { RunTransitionPlanInput, RunTransitionPlanner } from "./run-transition-planner.js";
import {
  cancelAgentRun,
  completeAgentRunWithFinalResult,
  completeAgentState,
  failAgentRun,
  markAgentRunBudgetExceeded,
  markAgentRunMaxStepsReached,
  markAgentRunWaitingApproval,
  markAgentStateBudgetExceeded,
  markAgentStateCancelled,
  markAgentStateFailed,
  markAgentStateMaxStepsReached,
  markAgentStateTimedOut,
  markAgentStateWaitingApproval,
  timeOutAgentRun,
} from "./state/run-transition-state.js";
import { cancelAgentStep, completeAgentStep, failAgentStep } from "./turn/step-lifecycle.js";
import { cancelAgentStepState, settleAgentStepState } from "./turn/step-state.js";

/**
 * The default pure Run transition planner.
 *
 * ```text
 * snapshot + directive + effect -> one RunExecutionCommit, and nothing else
 * ```
 *
 * It derives what durable state *should become* and writes nothing. There is no database, no
 * repository, no SQL, no clock read, no identifier generation, no network, no Tool execution and no
 * completion evaluation anywhere in this file: every fact it needs is an argument, and every
 * decision it makes is a total function of those arguments.
 *
 * The transitions it can express, and the ones it refuses:
 *
 * ```text
 * RETURN_TERMINAL          no write: the Run is already settled
 * SUSPEND                  no write: only an external resolution moves the Run
 * FINALIZE                 the terminal settlement for CANCELLED / TIMEOUT / MAX_STEPS_REACHED
 * AGENT TOOL_REQUESTS      settle the Step, append, open WAITING_TOOL_RESULTS
 * AGENT FINAL_CANDIDATE    NOT REPRESENTABLE HERE — see below
 * AGENT FAILED (final)     fail the Step, the Run and the AgentState
 * AGENT FAILED (retryable) NOT REPRESENTABLE HERE — no retry policy in the input
 * AGENT CANCELLED          settle the Step only; the termination authority settles the Run
 * TOOLS COMPLETED          accept the ordered results on the open Tool continuation
 * TOOLS REPLAN             accept synthetic results on the open Tool continuation
 * TOOLS BUDGET_EXCEEDED    the budget terminal settlement
 * TOOLS WAITING_APPROVAL   the durable approval boundary
 * TOOLS RESOURCE_WAIT      NOT REPRESENTABLE HERE — no replan count in the input
 * COMPLETION ACCEPT        complete the Run with the accepted result
 * COMPLETION REJECT        fail the Run with the gate's error
 * COMPLETION ERROR (final)  fail the Run with the gate's error
 * COMPLETION ERROR (retry.) NOT REPRESENTABLE HERE — no retry policy in the input
 * COMPLETION REPAIR        NOT REPRESENTABLE HERE — no plan/check/evidence identity in the input
 * ```
 *
 * **Fail closed, never fabricate.** A branch marked "not representable" throws rather than
 * inventing the identity it is missing. The frozen input genuinely does not carry a verification
 * plan identifier, a retry schedule, a resource operation reference or verification evidence, and
 * a planner that synthesised any of them would be a second authority over durable state. Those
 * bridges belong to the host layers that own the missing facts — Checkpoints 5, Phase 3D and
 * Phase 3E — and the errors below name the owner.
 *
 * `events` is always empty. A pure planner has no `EventId` factory and must not acquire one: event
 * materialization is a separate host boundary, applied to the commit this returns.
 */
export class DefaultRunTransitionPlanner implements RunTransitionPlanner {
  plan(input: RunTransitionPlanInput): RunExecutionCommit {
    return planRunTransition(input);
  }
}

/** The repo-consistent factory, so a host injects a planner the way it injects every other port. */
export function createRunTransitionPlanner(): RunTransitionPlanner {
  return new DefaultRunTransitionPlanner();
}

/** The planning decision, as a pure function so it can be tested directly. */
export function planRunTransition(input: RunTransitionPlanInput): RunExecutionCommit {
  const { snapshot, directive, effect, now } = input;
  assertDirectiveMatchesEffect(directive, effect);

  switch (directive.kind) {
    case "RETURN_TERMINAL":
    case "SUSPEND":
      // The Run is parked. Restating it is the whole transition; inventing a write here would be a
      // lifecycle decision nobody made.
      return noWrite(snapshot);
    case "FINALIZE":
      return planFinalize(snapshot, directive.reason, now);
    case "ADVANCE_AGENT":
      return planAgent(snapshot, effectOf(effect, "AGENT").result, now);
    case "EXECUTE_TOOL_BATCH":
      return planToolTurn(snapshot, effectOf(effect, "TOOLS").result, now);
    case "EVALUATE_COMPLETION":
      return planCompletion(snapshot, effectOf(effect, "COMPLETION").result, now);
    default:
      return assertNeverDirective(directive);
  }
}

/* ------------------------------------------------- directive / effect pairing */

/**
 * Refuse a directive and an effect that do not describe the same action.
 *
 * The pair is the planner's whole input, so a mismatched pair means the caller lost track of what
 * it executed. Planning a transition from it would durably record an action nobody performed.
 */
function assertDirectiveMatchesEffect(
  directive: RunExecutionDirective,
  effect: RunExecutionEffectResult,
): void {
  const expected = EXPECTED_EFFECT[directive.kind];
  if (effect.kind === expected) return;
  throw new RunExecutionInvariantError(
    `Directive ${directive.kind} produced a ${effect.kind} effect; the planner only plans ${expected}.`,
  );
}

const EXPECTED_EFFECT: Record<RunExecutionDirective["kind"], RunExecutionEffectResult["kind"]> = {
  ADVANCE_AGENT: "AGENT",
  EXECUTE_TOOL_BATCH: "TOOLS",
  EVALUATE_COMPLETION: "COMPLETION",
  SUSPEND: "NONE",
  FINALIZE: "NONE",
  RETURN_TERMINAL: "NONE",
};

function effectOf<K extends RunExecutionEffectResult["kind"]>(
  effect: RunExecutionEffectResult,
  kind: K,
): Extract<RunExecutionEffectResult, { kind: K }> {
  if (effect.kind !== kind) {
    throw new RunExecutionInvariantError(`Expected a ${kind} effect, received ${effect.kind}.`);
  }
  return effect as Extract<RunExecutionEffectResult, { kind: K }>;
}

/* --------------------------------------------------------------- no write */

/** A commit that restates the Run and changes nothing durable. */
function noWrite(snapshot: RunExecutionSnapshot): RunExecutionCommit {
  return {
    run: snapshot.run,
    ...(snapshot.state === undefined ? {} : { state: snapshot.state }),
    expectedStateRevision: snapshot.stateRevision ?? null,
    expectedContinuationRevision: snapshot.continuationRevision ?? null,
    stepWrites: [],
    messagesToAppend: [],
    events: [],
  };
}

/* ---------------------------------------------------------------- FINALIZE */

function planFinalize(
  snapshot: RunExecutionSnapshot,
  reason: "CANCELLED" | "TIMEOUT" | "MAX_STEPS_REACHED",
  now: TimestampMs,
): RunExecutionCommit {
  const state = requireState(snapshot, `FINALIZE ${reason}`);
  const run = requireSettledStep(snapshot, `FINALIZE ${reason}`);

  switch (reason) {
    case "CANCELLED":
      return {
        ...base(snapshot),
        run: cancelAgentRun(run, now),
        state: markAgentStateCancelled(state, now),
        ...clearContinuation(snapshot),
      };
    case "TIMEOUT":
      return {
        ...base(snapshot),
        run: timeOutAgentRun(run, now),
        state: markAgentStateTimedOut(state, now),
        ...clearContinuation(snapshot),
      };
    case "MAX_STEPS_REACHED":
      return {
        ...base(snapshot),
        run: markAgentRunMaxStepsReached(run, now),
        state: markAgentStateMaxStepsReached(state, now),
        ...clearContinuation(snapshot),
      };
    default:
      return assertNeverReason(reason);
  }
}

/* ------------------------------------------------------------ ADVANCE_AGENT */

function planAgent(
  snapshot: RunExecutionSnapshot,
  result: AgentLoopAdvanceResult,
  now: TimestampMs,
): RunExecutionCommit {
  // The settle timestamp never moves the durable state backwards.
  //
  // `AgentState.updatedAt` is monotonic by contract, and another subsystem may have advanced it
  // after this effect started — a Tool effect projection stamps its own settlement from its own
  // clock. Clamping here is the same rule `beginAgentStepState` already applies when a turn opens,
  // so a Run Layer whose clock is behind the ledger settles the attempt instead of failing on a
  // timestamp that only ever moved forwards.
  const settledAt = Math.max(snapshot.state?.updatedAt ?? now, now) as TimestampMs;

  switch (result.kind) {
    case "TOOL_REQUESTS":
      return planToolRequests(snapshot, result, settledAt);
    case "FAILED":
      return planAgentFailed(snapshot, result, settledAt);
    case "CANCELLED":
      return planAgentCancelled(snapshot, result, settledAt);
    case "FINAL_CANDIDATE":
      throw compatibilityRequired(
        "AGENT FINAL_CANDIDATE",
        "the legacy completion compatibility projection (a verification plan identity) is required before a pure planner can move a Run to VERIFYING",
        "Checkpoint 5 keeps the legacy FinalCandidate -> Verification bridge; Phase 3E replaces it with the CompletionGate",
      );
    default:
      return assertNeverAgentResult(result);
  }
}

/** Open the durable Tool boundary the model asked for. */
function planToolRequests(
  snapshot: RunExecutionSnapshot,
  result: Extract<AgentLoopAdvanceResult, { kind: "TOOL_REQUESTS" }>,
  now: TimestampMs,
): RunExecutionCommit {
  const state = requireState(snapshot, "AGENT TOOL_REQUESTS");
  const step = requireActiveStep(snapshot, result.turn.stepId, "AGENT TOOL_REQUESTS");

  return {
    ...base(snapshot),
    run: clearActiveStep(snapshot.run),
    state: settleAgentStepState(state, {
      stepId: step.id,
      ...(result.modelTurn.usage === undefined ? {} : { usage: result.modelTurn.usage }),
      now,
    }),
    stepWrites: [{ operation: "UPDATE", step: completeAgentStep(step, { finishedAt: now }) }],
    messagesToAppend: messageAppends(snapshot, result.messagesToAppend, step.id, now),
    continuation: {
      operation: "SET",
      checkpoint: {
        type: "WAITING_TOOL_RESULTS",
        runId: snapshot.run.id,
        sourceStepId: step.id,
        pendingDecision: result.decision,
        // Snapshotted so a later Tool projection uses the policy the turn was prepared under,
        // rather than whatever a restarted process happens to default to.
        observationPolicy: result.context.observationPolicy,
      },
      updatedAt: now,
    },
    events: [],
  };
}

/** A provider attempt that really was made and really failed. */
function planAgentFailed(
  snapshot: RunExecutionSnapshot,
  result: Extract<AgentLoopAdvanceResult, { kind: "FAILED" }>,
  now: TimestampMs,
): RunExecutionCommit {
  if (result.retry?.retryable === true) {
    throw compatibilityRequired(
      "AGENT FAILED (retryable)",
      "a Run Retry compatibility decision (attempt number and next attempt time) is required; the frozen planner input carries no retry policy",
      "Checkpoint 5 keeps the existing Run Retry Policy bridge",
    );
  }
  const state = requireState(snapshot, "AGENT FAILED");
  const stepWrites: RunExecutionStepWrite[] = [];
  let settledState = state;

  // A failure that happened before any context was prepared never durably attempted anything, so
  // there is no Step to settle. Whether there was one is a fact of the snapshot, not a guess.
  const active = snapshot.activeStep;
  if (active !== undefined && active.id === result.turn.stepId && active.status === "RUNNING") {
    stepWrites.push({ operation: "UPDATE", step: failStep(active, now) });
    settledState = settleAgentStepState(state, {
      stepId: active.id,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      now,
    });
  }

  return {
    ...base(snapshot),
    run: failAgentRun(clearActiveStep(snapshot.run), now),
    state: markAgentStateFailed(settledState, result.error, now),
    stepWrites,
    messagesToAppend: messageAppends(snapshot, result.messagesToAppend, undefined, now),
    ...clearContinuation(snapshot),
  };
}

/**
 * A cancelled Reason settles its own Step and stops.
 *
 * It does **not** cancel the Run. The Run Termination Authority owns that, and a planner that
 * settled `CANCELLED` here would be a second cancellation authority — one that could not see a
 * durable cancellation intent, a deadline or a cleanup result.
 */
function planAgentCancelled(
  snapshot: RunExecutionSnapshot,
  result: Extract<AgentLoopAdvanceResult, { kind: "CANCELLED" }>,
  now: TimestampMs,
): RunExecutionCommit {
  const state = requireState(snapshot, "AGENT CANCELLED");
  const active = snapshot.activeStep;
  if (active === undefined || active.id !== result.turn.stepId || active.status !== "RUNNING") {
    // Nothing durable was attempted: there is no Step to settle and no state to unwind.
    return noWrite(snapshot);
  }

  return {
    ...base(snapshot),
    run: clearActiveStep(snapshot.run),
    state: cancelAgentStepState(state, {
      stepId: active.id,
      now,
      // A cancellation that happened after the provider was contacted did spend an attempt.
      // Absent context means no context was prepared, which is exactly that distinction.
      countAttempt: result.context !== undefined,
    }),
    stepWrites: [{ operation: "UPDATE", step: cancelAgentStep(active, now) }],
    messagesToAppend: messageAppends(snapshot, result.messagesToAppend, undefined, now),
    events: [],
  };
}

/* -------------------------------------------------------- EXECUTE_TOOL_BATCH */

function planToolTurn(
  snapshot: RunExecutionSnapshot,
  result: ToolTurnResult,
  now: TimestampMs,
): RunExecutionCommit {
  const continuation = requireToolContinuation(snapshot, `TOOLS ${result.kind}`);

  switch (result.kind) {
    case "COMPLETED":
      return acceptToolResults(snapshot, continuation, result.results, now);
    case "REPLAN":
      return acceptToolResults(snapshot, continuation, result.syntheticResults, now);
    case "BUDGET_EXCEEDED":
      return planBudgetExceeded(snapshot, now);
    case "WAITING_APPROVAL":
      return planWaitingApproval(snapshot, continuation, result.waiting, now);
    case "RESOURCE_WAIT":
      throw compatibilityRequired(
        "TOOLS RESOURCE_WAIT",
        "the durable resource boundary needs a replan count and an operation reference that the frozen RESOURCE_WAIT result does not carry",
        "the Phase 3D Tool compatibility adapter",
      );
    default:
      return assertNeverToolResult(result);
  }
}

/** Write accepted results back onto the open Tool continuation. The Run stays RUNNING. */
function acceptToolResults(
  snapshot: RunExecutionSnapshot,
  continuation: Extract<
    NonNullable<RunExecutionSnapshot["continuation"]>,
    { type: "WAITING_TOOL_RESULTS" }
  >,
  results: readonly AgentToolResult[],
  now: TimestampMs,
): RunExecutionCommit {
  return {
    ...base(snapshot),
    run: snapshot.run,
    continuation: {
      operation: "SET",
      checkpoint: {
        ...continuation,
        // The batch is the authority on what the model sees: results are converted in the order
        // they were reported, and no identity, detail or observation is carried across.
        receivedResults: results.map(toToolResultMessage),
      },
      updatedAt: now,
    },
    events: [],
  };
}

/**
 * The durable approval boundary.
 *
 * Fully representable: the frozen `WaitingApprovalBoundary` carries exactly the four fields the
 * durable continuation persists, so nothing has to be invented. The partial results the batch
 * completed before stopping are *not* written here — the Run is no longer accepting results, and the
 * general invariant refuses a waiting-approval continuation that holds any.
 */
function planWaitingApproval(
  snapshot: RunExecutionSnapshot,
  continuation: Extract<
    NonNullable<RunExecutionSnapshot["continuation"]>,
    { type: "WAITING_TOOL_RESULTS" }
  >,
  waiting: Extract<ToolTurnResult, { kind: "WAITING_APPROVAL" }>["waiting"],
  now: TimestampMs,
): RunExecutionCommit {
  const state = requireState(snapshot, "TOOLS WAITING_APPROVAL");

  return {
    ...base(snapshot),
    run: markAgentRunWaitingApproval(snapshot.run),
    state: markAgentStateWaitingApproval(state, now),
    continuation: {
      operation: "SET",
      // Written out member by member rather than spread: `receivedResults` is *excluded* here
      // because the Run has stopped accepting results, and naming every member that is included
      // makes that exclusion a reviewed decision instead of a side effect of a rest pattern.
      checkpoint: {
        type: "WAITING_TOOL_RESULTS",
        runId: continuation.runId,
        sourceStepId: continuation.sourceStepId,
        pendingDecision: continuation.pendingDecision,
        ...(continuation.observationPolicy === undefined
          ? {}
          : { observationPolicy: continuation.observationPolicy }),
        waitingApproval: waiting,
      },
      updatedAt: now,
    },
    events: [],
  };
}

/** The durable budget terminal settlement. */
function planBudgetExceeded(snapshot: RunExecutionSnapshot, now: TimestampMs): RunExecutionCommit {
  const state = requireState(snapshot, "TOOLS BUDGET_EXCEEDED");
  return {
    ...base(snapshot),
    run: markAgentRunBudgetExceeded(requireSettledStep(snapshot, "TOOLS BUDGET_EXCEEDED"), now),
    state: markAgentStateBudgetExceeded(state, now),
    ...clearContinuation(snapshot),
    events: [],
  };
}

/* -------------------------------------------------------- EVALUATE_COMPLETION */

function planCompletion(
  snapshot: RunExecutionSnapshot,
  decision: Extract<RunExecutionEffectResult, { kind: "COMPLETION" }>["result"],
  now: TimestampMs,
): RunExecutionCommit {
  const state = requireState(snapshot, `COMPLETION ${decision.kind}`);

  switch (decision.kind) {
    case "ACCEPT":
      return {
        ...base(snapshot),
        run: completeAgentRunWithFinalResult(
          requireSettledStep(snapshot, "COMPLETION ACCEPT"),
          decision.finalResult,
          now,
        ),
        state: completeAgentState(state, now),
        ...clearContinuation(snapshot),
        events: [],
      };
    case "REJECT":
    case "ERROR": {
      if (decision.kind === "ERROR" && decision.retryable) {
        throw compatibilityRequired(
          "COMPLETION ERROR (retryable)",
          "a Run Retry compatibility decision is required; the frozen planner input carries no retry policy",
          "Checkpoint 5 keeps the existing Run Retry Policy bridge",
        );
      }
      const run = requireSettledStep(snapshot, `COMPLETION ${decision.kind}`);
      return {
        ...base(snapshot),
        run: failAgentRun(run, now),
        state: markAgentStateFailed(state, decision.error, now),
        ...clearContinuation(snapshot),
        events: [],
      };
    }
    case "REPAIR":
      throw compatibilityRequired(
        "COMPLETION REPAIR",
        "the durable repair boundary carries a failed plan identity, failed check identities and evidence identities, and the frozen repair request carries only a reference, a cycle and a reason",
        "Phase 3E owns the completion-repair compatibility migration",
      );
    default:
      return assertNeverCompletion(decision);
  }
}

/* ------------------------------------------------------------------ helpers */

/** Everything a commit carries unchanged: the revisions, the empty event list, no append. */
function base(
  snapshot: RunExecutionSnapshot,
): Pick<
  RunExecutionCommit,
  | "expectedStateRevision"
  | "expectedContinuationRevision"
  | "stepWrites"
  | "messagesToAppend"
  | "events"
> {
  return {
    // The revision the planner read is the revision the store must still see, or the commit loses.
    expectedStateRevision: snapshot.stateRevision ?? null,
    expectedContinuationRevision: snapshot.continuationRevision ?? null,
    stepWrites: [],
    messagesToAppend: [],
    events: [],
  };
}

function requireState(snapshot: RunExecutionSnapshot, what: string): AgentState {
  if (snapshot.state === undefined) {
    throw new RunExecutionInvariantError(`${what} requires an AgentState, and the Run has none.`);
  }
  return snapshot.state;
}

/** Clear the Run's active Step pointer, which the Step settlement is what actually meant. */
function clearActiveStep(run: AgentRun): AgentRun {
  if (run.currentStepId === undefined) return run;
  return AgentRunSchema.parse({ ...run, currentStepId: undefined });
}

/** A transition that settles a terminal status cannot be planned while a Step is still open. */
function requireSettledStep(snapshot: RunExecutionSnapshot, what: string): AgentRun {
  if (snapshot.run.currentStepId !== undefined || snapshot.activeStep !== undefined) {
    throw new RunExecutionInvariantError(`${what} cannot be planned while a Step is still open.`);
  }
  return snapshot.run;
}

function requireActiveStep(
  snapshot: RunExecutionSnapshot,
  stepId: string,
  what: string,
): NonNullable<RunExecutionSnapshot["activeStep"]> {
  const active = snapshot.activeStep;
  if (active === undefined) {
    throw new RunExecutionInvariantError(`${what} requires an active Step, and the Run has none.`);
  }
  if (active.id !== stepId) {
    throw new RunExecutionInvariantError(
      `${what} was executed as Step ${stepId} but the Run's active Step is ${active.id}.`,
    );
  }
  if (active.status !== "RUNNING") {
    throw new RunExecutionInvariantError(
      `${what} requires a RUNNING Step, found ${active.status}.`,
    );
  }
  return active;
}

function requireToolContinuation(
  snapshot: RunExecutionSnapshot,
  what: string,
): Extract<NonNullable<RunExecutionSnapshot["continuation"]>, { type: "WAITING_TOOL_RESULTS" }> {
  const continuation = snapshot.continuation;
  if (continuation?.type !== "WAITING_TOOL_RESULTS") {
    throw new RunExecutionInvariantError(
      `${what} requires an open WAITING_TOOL_RESULTS continuation, and the Run holds none.`,
    );
  }
  return continuation;
}

function clearContinuation(
  snapshot: RunExecutionSnapshot,
): Pick<RunExecutionCommit, "continuation"> {
  return snapshot.continuation === undefined ? {} : { continuation: { operation: "CLEAR" } };
}

/**
 * The one conversion from a reported Tool turn to a canonical Tool result.
 *
 * Exactly four fields cross. An invocation identity, an observation record and the durable artifact
 * pointer stay in the Tool Layer: the Run Layer persists what the model saw.
 */
function toToolResultMessage(result: AgentToolResult): AIToolResultMessage {
  return {
    role: "tool",
    toolCallId: result.externalCallId,
    toolName: result.toolName,
    content: result.content,
    isError: result.isError,
  };
}

/**
 * The canonical append projection.
 *
 * The provenance rule is the durable one and is preserved verbatim: an assistant message belongs to
 * the Step that produced it, and a Tool result belongs to the Step that requested the batch.
 */
function messageAppends(
  snapshot: RunExecutionSnapshot,
  messages: readonly AIMessage[],
  stepId: StepId | undefined,
  now: TimestampMs,
): readonly RunExecutionMessageAppend[] {
  const toolStepId =
    snapshot.continuation?.type === "WAITING_TOOL_RESULTS"
      ? snapshot.continuation.sourceStepId
      : undefined;

  return messages.map((message): RunExecutionMessageAppend => {
    const sourceStepId =
      message.role === "assistant" ? stepId : message.role === "tool" ? toolStepId : undefined;
    return {
      createdAt: now,
      ...(sourceStepId === undefined ? {} : { sourceStepId }),
      message,
    };
  });
}

/* ------------------------------------------------------- fail-closed helpers */

/**
 * Refuse a branch the frozen input cannot represent.
 *
 * The message names what is missing and which layer owns it, because the useful outcome of a
 * fail-closed planner is a precise gap, not a generic error. It is deliberately a
 * `RunExecutionInvariantError`: a transition the Run Layer cannot express is an invariant of this
 * layer, and inventing a new public result variant for it would widen the frozen contract.
 */
function compatibilityRequired(transition: string, missing: string, owner: string): Error {
  return new RunExecutionInvariantError(
    `${transition} cannot be planned by the pure planner: ${missing}. Owner: ${owner}.`,
  );
}

function assertNeverDirective(directive: never): never {
  throw new RunExecutionInvariantError(
    `Unhandled Run execution directive: ${JSON.stringify(directive)}`,
  );
}

function assertNeverReason(reason: never): never {
  throw new RunExecutionInvariantError(`Unhandled finalize reason: ${JSON.stringify(reason)}`);
}

function assertNeverAgentResult(result: never): never {
  throw new RunExecutionInvariantError(`Unhandled Agent advance result: ${JSON.stringify(result)}`);
}

function assertNeverToolResult(result: never): never {
  throw new RunExecutionInvariantError(`Unhandled Tool turn result: ${JSON.stringify(result)}`);
}

function assertNeverCompletion(decision: never): never {
  throw new RunExecutionInvariantError(
    `Unhandled completion decision: ${JSON.stringify(decision)}`,
  );
}

/** Settle a Step as failed; a provider attempt really was made. */
function failStep(
  step: NonNullable<RunExecutionSnapshot["activeStep"]>,
  now: TimestampMs,
): RunExecutionCommit["stepWrites"][number]["step"] {
  return failAgentStep(step, now);
}
