import type { ModelTurnExecutor } from "@caelush/agent";
import { RunExecutionInvariantError } from "@caelush/agent";
import type { ModelTurnBoundaryInput, ModelTurnBoundaryPort } from "@caelush/agent";
import type { ModelRef, StepId } from "@caelush/protocol";

import type { AgentBudgetBlock } from "./agent-errors.js";
import type { AgentProviderTurnState } from "./run-agent-types.js";

/**
 * The durable model turn boundary.
 *
 * ```text
 * Durable Step commit MUST succeed
 *        ↓
 * only then may Provider I/O begin
 * ```
 *
 * This is the Core implementation of the frozen `ModelTurnBoundaryPort`. The kernel calls it
 * between admission and the provider, so a Run that restarts either finds a committed Step that
 * really was attempted, or finds no Step at all and can safely decide what to do next. The failure
 * mode it exists to prevent is the opposite one: a provider call whose Step never became durable,
 * which no recovery can reason about.
 *
 * ```text
 * it performs no provider I/O
 * it holds no store, no client and no handle of its own
 * it commits only through the Run Layer callback it was created with
 * ```
 *
 * ## The observation
 *
 * The frozen kernel projects a thrown `beforeExecute` onto `AgentLoopAdvanceResult.kind = "FAILED"`,
 * because from its side a port rejected. A durable commit conflict is **not** a model failure, and
 * letting it become one would durably record "the model produced a bad answer" for a turn that
 * never reached the model. The boundary therefore also records what happened, in a Core-private
 * observation the Run Layer reads before it decides anything. The frozen result is not modified.
 */

/**
 * The Run-Layer facts one Agent turn is opened with.
 *
 * ```text
 * the Step                  allocated in memory by the Run Layer; not durable yet
 * the model                 the descriptor this turn was resolved against
 * the advance reason        why durable execution is entering this turn
 * expected revisions        the effect-start CAS the first open must compare against
 * ```
 *
 * The Revision fields are the durable revisions the coordinator's own decision was made from. They
 * are what stops a boundary from opening a turn against a snapshot that moved after the decision
 * was taken: the first open compares against *those*, and only an exact durable replay of the same
 * turn may resolve without committing.
 *
 * Stale mutable copies of the Run and the AgentState are deliberately absent. The boundary commits
 * the *current* durable snapshot projected through `beginAgentStepState(...)`, so a pre-provider
 * copy of either can never become the committed state.
 */
export interface PendingAgentTurn {
  readonly identity: ModelTurnBoundaryInput["identity"];
  readonly model: ModelRef;
  /**
   * The Step this turn will be durably opened as.
   *
   * Allocated by the Run Layer, never by the boundary: the layer that persists a Step is the layer
   * that names it, and a boundary that minted one would be a second Step identity authority.
   */
  readonly step: import("@caelush/protocol").AgentStep;
  /** Why this turn is being advanced. The continuation rules are keyed on it. */
  readonly advanceReason: import("@caelush/agent").RunExecutionAdvanceReason;
  /** The `AgentState` revision the coordinator's decision was made from. */
  readonly expectedStateRevision: number | null;
  /** The continuation revision the coordinator's decision was made from. */
  readonly expectedContinuationRevision: number | null;
  /** The durable Step that requested the Tools a `TOOL_RESULTS` turn answers, when there is one. */
  readonly sourceStepId?: StepId | undefined;
}

/** What actually happened around one durable boundary and one provider turn. */
export interface AgentTurnObservation {
  /** The frozen port was entered. */
  boundaryAttempted: boolean;
  /** The durable open-Step commit resolved. Only then may provider I/O begin. */
  boundaryCommitted: boolean;
  /** The value the durable commit rejected with, when it did. */
  boundaryError: unknown;
  /** Whether the provider turn ran at all, and how it ended. */
  providerTurnState: AgentProviderTurnState;
  providerError: unknown;
  /** The durable budget block an admission refusal produced, accounting included. */
  admissionBlock: AgentBudgetBlock | undefined;
  admissionError: unknown;
  contextError: unknown;
}

/** A fresh, empty observation for one Agent turn. */
export function createAgentTurnObservation(): AgentTurnObservation {
  return {
    boundaryAttempted: false,
    boundaryCommitted: false,
    boundaryError: undefined,
    providerTurnState: "NOT_STARTED",
    providerError: undefined,
    admissionBlock: undefined,
    admissionError: undefined,
    contextError: undefined,
  };
}

export interface AgentModelTurnBoundaryOptions {
  readonly observation: AgentTurnObservation;
  /**
   * The Step this turn will open, resolved at the moment the boundary is entered.
   *
   * The Run Layer already allocated it; this only delivers it to the boundary, so the boundary can
   * validate the frozen input against it without ever creating one.
   */
  readonly pendingTurn: () => PendingAgentTurn;
  /**
   * The Run Layer's durable open-Step commit.
   *
   * It is a callback rather than a store so the boundary holds no commit authority of its own: the
   * RunController remains the only object that commits a lifecycle transition.
   */
  readonly openTurn: (turn: PendingAgentTurn) => Promise<void>;
}

/**
 * Create the durable boundary for one Agent turn.
 *
 * Per-turn, deliberately. A shared instance would have to key its state by Run and Step, and a
 * registry that outlives one effect is a place for a previous turn's Step to be found by the next
 * one. This object is created before the effect, used once, and dropped with it.
 */
export function createAgentModelTurnBoundary(
  options: AgentModelTurnBoundaryOptions,
): ModelTurnBoundaryPort {
  return {
    async beforeExecute(input: ModelTurnBoundaryInput): Promise<void> {
      const { observation } = options;
      observation.boundaryAttempted = true;
      try {
        // Idempotent for the same turn: a second call for a turn this boundary already committed
        // is a replay, and replaying it would open a second Step and emit a second `llm.started`.
        if (observation.boundaryCommitted) return;
        assertBoundaryMatchesPendingTurn(input, options.pendingTurn());
        await options.openTurn(options.pendingTurn());
        observation.boundaryCommitted = true;
      } catch (error) {
        observation.boundaryError = error;
        // Reject rather than resolve: the kernel must not reach the provider on a boundary that
        // did not commit.
        throw error;
      }
    },
  };
}

/**
 * Refuse a boundary call that does not describe the turn the Run Layer opened.
 *
 * A mismatch means the kernel is opening one turn while the Run Layer prepared another, and
 * committing it would durably settle a Step the Run never allocated.
 */
function assertBoundaryMatchesPendingTurn(
  input: ModelTurnBoundaryInput,
  pending: PendingAgentTurn,
): void {
  if (
    input.identity.runId !== pending.identity.runId ||
    input.identity.sessionId !== pending.identity.sessionId
  ) {
    throw new RunExecutionInvariantError(
      "Model turn boundary identity does not match the Run it was opened for.",
    );
  }
  if (input.turn.stepId !== pending.step.id || input.turn.sequence !== pending.step.sequence) {
    throw new RunExecutionInvariantError(
      "Model turn boundary turn does not match the Step the Run Layer allocated.",
    );
  }
  if (
    input.model.provider !== pending.model.provider ||
    input.model.model !== pending.model.model
  ) {
    throw new RunExecutionInvariantError(
      "Model turn boundary model does not match the model the Run is bound to.",
    );
  }
}

/**
 * Observe one provider turn without changing it.
 *
 * ```text
 * NOT_STARTED  the executor was never entered
 * COMPLETED    the provider answered, whatever the classifier then decided about the answer
 * FAILED       the provider attempt itself failed
 * CANCELLED    the caller's signal was aborted
 * ```
 *
 * It is a decorator rather than a replacement: the executor it wraps is the one the Run Layer
 * composed, with its transient sink and its error mapping intact. The observation is read from the
 * frozen union the executor returned, never inferred from an error message, a retryability flag or
 * the presence of a model turn.
 */
export function createObservingModelTurnExecutor(
  executor: ModelTurnExecutor,
  observation: AgentTurnObservation,
): ModelTurnExecutor {
  return {
    async execute(input) {
      try {
        const result = await executor.execute(input);
        observation.providerTurnState =
          result.kind === "COMPLETED"
            ? "COMPLETED"
            : result.kind === "FAILED"
              ? "FAILED"
              : "CANCELLED";
        if (result.kind === "FAILED") observation.providerError = result.error;
        return result;
      } catch (error) {
        // The frozen executor reports failures as values. A throw here is an infrastructure
        // failure in whatever was injected, not a provider answer, and it must never be recorded
        // as one.
        observation.providerTurnState = "FAILED";
        observation.providerError = error;
        throw error;
      }
    },
  };
}

/**
 * Whether the turn must be surfaced as an infrastructure failure rather than settled.
 *
 * A boundary that never committed means no Step exists and no provider call was allowed, so there
 * is no Agent effect to plan: the Run stays recoverable and the caller repairs or retries.
 */
export function requiresBoundaryRepair(observation: AgentTurnObservation): boolean {
  return observation.boundaryAttempted && !observation.boundaryCommitted;
}
