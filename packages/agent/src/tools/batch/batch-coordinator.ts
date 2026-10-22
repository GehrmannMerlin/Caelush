import {
  JsonObjectSchema,
  RunIdSchema,
  SessionIdSchema,
  StepIdSchema,
  ToolNameSchema,
} from "@caelush/protocol";

import type { AgentBudgetBlock } from "../../loop/ports/model-request-admission.js";
import { isToolExecutionEnvironment } from "../types/execution-environment.js";
import { mayRunAfterEarlierFailure } from "../types/scheduling.js";
import type { ToolSchedulingFacts } from "../types/scheduling.js";
import { assertToolSecurityContext } from "../admission/security-context.js";
import type { ToolBudgetAdmissionPort } from "../admission/budget-port.js";
import type {
  PreparedToolCall,
  ToolCallPreparationOutcome,
  ToolCallPreparer,
  ToolCallRequest,
} from "../call/tool-call-preparer.js";
import { DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES } from "../call/tool-call-preparer-impl.js";
import type { AgentToolRegistry } from "../registry/registry.js";
import type {
  DurableToolExecutionCoordinator,
  DurableToolExecutionOutcome,
} from "../durable/durable-execution-coordinator.js";
import { ToolExecutionAbortedError } from "../durable/durable-execution-coordinator.js";
import type { AIRejectedToolArgumentsIssue } from "@caelush/ai";
import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import { planSequentialToolBatch, type ToolBatchExecutionPlan } from "./batch-planner.js";
import { runBoundedByIndex } from "./parallel-scheduler.js";
import { ToolBatchInfrastructureError, ToolBatchInputError } from "./batch-errors.js";
import { isModelRejectedCall } from "./batch-types.js";
import type {
  ToolBatchCall,
  ToolBatchCoordinator,
  ToolBatchItemOutcome,
  ToolBatchOutcome,
  ToolBatchRequest,
} from "./batch-types.js";

/**
 * The canonical Tool Batch scheduling authority.
 *
 * ```text
 * validate batch
 *        ↓
 * check cancellation
 *        ↓
 * budget preflight
 *        ↓
 * for calls in original order:
 *     if skipRemaining:      append SKIPPED
 *     if signal aborted:     return CANCELLED
 *     prepare(call)
 *        REJECTED  -> append REJECTED, continue
 *        READY     -> DurableToolExecutionCoordinator.execute(...)
 *                       SETTLED           -> append OBSERVATION
 *                                            if TOOL_OUTCOME_UNKNOWN: skipRemaining = true
 *                       WAITING_APPROVAL  -> return WAITING_APPROVAL
 *                       BUDGET_EXCEEDED   -> return BUDGET_EXCEEDED
 *                       CANCELLED         -> return CANCELLED
 * return COMPLETED
 * ```
 *
 * ## Sequential by default, with one opt-in window
 *
 * The default loop is an ordinary `for` over the calls: `call_1` is fully decided before `call_2` is
 * prepared, and a Tool that declares `PARALLEL_SAFE` changes nothing by itself.
 *
 * A host may opt in with `parallelism.maxConcurrency`. Even then the only calls that can run together
 * are a **maximal run of consecutive `PARALLEL_SAFE` calls**, preparation stays sequential, the durable
 * invocation lifecycle is untouched, and results are assembled in original call order. Under
 * `ALWAYS_ASK` no window is formed at all, because every call could park on an approval and a parked
 * call must never have a later sibling already running. See `parallel-scheduler.ts`.
 *
 * ## What this object is allowed to depend on
 *
 * ```text
 * ToolCallPreparer                    the 4A preparation authority
 * ToolBudgetAdmissionPort             the frozen budget preflight boundary
 * DurableToolExecutionCoordinator     the 4C durable invocation lifecycle
 * ```
 *
 * Nothing else. There is no registry, no store, no Runtime, no workspace, no `Run` and no
 * `RunController` here: each of those belongs to one of the three collaborators above, and a Batch that
 * held a second reference to them would be a second owner of somebody else's authority.
 *
 * ## Why an ordinary failure is not a barrier but an unknown outcome is
 *
 * A `REJECTED` call executed nothing, so the next call is unaffected and the loop continues: the model
 * asked for two things, one of them was malformed, and the other is still worth doing.
 *
 * A `TOOL_OUTCOME_UNKNOWN` settlement means a Tool may have partially or fully changed the world. The
 * remaining calls were chosen by a model that believed the earlier ones had not run, so running them
 * would apply a plan to a state nobody observed. They become `TOOL_NOT_STARTED` — safe feedback, no
 * durable row, no execution. Ordinary safe Tool failures do not stop the batch.
 */
export interface ToolBatchCoordinatorOptions {
  /** Resolves the model's Tool call against the active catalog. */
  readonly preparer: ToolCallPreparer;
  /** The whole-batch budget preflight. Absent means this host admits every batch. */
  readonly budget: Pick<ToolBudgetAdmissionPort, "preflight">;
  /** The durable invocation lifecycle. Every executed call goes through it. */
  readonly durable: Pick<DurableToolExecutionCoordinator, "execute">;
  /** The active catalog, used only to report declared execution modes for diagnostics. */
  readonly registry?: Pick<AgentToolRegistry, "resolve"> | undefined;
  /** The bound applied to a model Tool call id, matching the durable invocation limit. */
  readonly maxExternalCallIdBytes?: number | undefined;
  /**
   * Opt-in parallel windows over consecutive `PARALLEL_SAFE` calls.
   *
   * Omitted means the historical strictly sequential behaviour. The host must also state whether
   * admission can request approval; an unknown or approval-capable admission path stays sequential
   * so a later sibling cannot run before a guard decision.
   */
  readonly parallelism?:
    | {
        readonly maxConcurrency: number;
        readonly admissionMayRequireApproval?: boolean | undefined;
      }
    | undefined;
}

/** Stable model-facing code for a call that the batch did not start. */
export const TOOL_NOT_STARTED = "TOOL_NOT_STARTED";

/** Safe, bounded feedback for a call withheld after an earlier result became unknown. */
export const TOOL_NOT_STARTED_CONTENT =
  "This tool call was not started because an earlier tool outcome is unknown. " +
  "Do not continue or retry this dependent chain automatically; inspect current state first.";

/** Safe, bounded feedback for a call withheld because the batch was cancelled. */
const TOOL_NOT_STARTED_CANCELLED_CONTENT =
  "This tool call was not started because the tool batch was cancelled.";

/**
 * Stable model-facing code for a call withheld after an earlier call in the same batch failed.
 *
 * The call was never prepared for dispatch and never executed. The model is told to re-submit it
 * once the failed call is corrected, or to explain why it does not depend on it — the batch
 * coordinator cannot prove independence from an argument object, and guessing would be worse than
 * asking.
 */
export const TOOL_DEPENDENCY_UNPROVEN = "TOOL_DEPENDENCY_UNPROVEN";

/** Safe, bounded feedback for a mutation withheld after an earlier failure in the same batch. */
export const TOOL_DEPENDENCY_UNPROVEN_CONTENT =
  "This tool call was not started because an earlier call in this batch did not complete, and this " +
  "operation may change state that depends on it. Nothing was executed for this call. Correct the " +
  "failed call first, then re-submit this operation once you can state why it is independent.";

/** Why the rest of a batch cannot be assumed to apply to the state the model observed. */
interface BatchBarrier {
  /** The source position of the call that established the barrier. */
  readonly ordinal: number;
  readonly code: string;
}

/** @deprecated Use TOOL_NOT_STARTED. Kept as a source-compatible alias for existing Agent hosts. */
export const SKIPPED_AFTER_UNCERTAIN_EXECUTION = TOOL_NOT_STARTED;

/** @deprecated Use TOOL_NOT_STARTED_CONTENT. */
export const SKIPPED_AFTER_UNCERTAIN_CONTENT = TOOL_NOT_STARTED_CONTENT;

/**
 * Build the canonical Tool batch coordinator.
 *
 * Every dependency is injected, so this factory has no import of a concrete store, registry, Runtime or
 * dispatcher — which is what makes the batch authoritative over *scheduling* while remaining ignorant of
 * *how* a Tool runs.
 */
export function createToolBatchCoordinator(
  options: ToolBatchCoordinatorOptions,
): ToolBatchCoordinator {
  const maxExternalCallIdBytes =
    options.maxExternalCallIdBytes ?? DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES;

  return {
    async execute(value: ToolBatchRequest): Promise<ToolBatchOutcome> {
      const request = assertToolBatchRequest(value, maxExternalCallIdBytes);

      // Cancellation is checked before any real work. A pre-aborted batch has no Tool side effect, no
      // durable row and no budget reservation; the only correct statement is that it was cancelled.
      if (request.signal.aborted) return cancelledOutcome([], request.calls);

      const block = await preflightBudget(options, request);
      if (block !== null) {
        // The whole requested segment cannot fit, so nothing runs. No item is fabricated: the frozen
        // durable outcome does not define this budget boundary as model feedback, and the Run Layer
        // still owns the Run-level BUDGET_EXCEEDED settlement.
        return Object.freeze({ kind: "BUDGET_EXCEEDED", items: [], block });
      }

      return await executeCalls(options, request);
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * The scheduler
 * ---------------------------------------------------------------------------------------------- */

async function executeCalls(
  options: ToolBatchCoordinatorOptions,
  request: ToolBatchRequest,
): Promise<ToolBatchOutcome> {
  if (options.parallelism !== undefined) {
    return executeCallsWithWindows(options, request, options.parallelism.maxConcurrency);
  }
  return executeCallsSequentially(options, request);
}

async function executeCallsSequentially(
  options: ToolBatchCoordinatorOptions,
  request: ToolBatchRequest,
): Promise<ToolBatchOutcome> {
  // The scheduling decision is made once, before the first call, from the whole batch. It is always
  // the sequential plan: a Tool that declares `PARALLEL_SAFE` is still run in order.
  const plan = planBatch(options, request);
  if (plan.kind !== "SEQUENTIAL") {
    throw new ToolBatchInfrastructureError("The Tool batch produced a non-sequential plan.");
  }

  const items: ToolBatchItemOutcome[] = [];
  let skipRemaining = false;
  let barrier: BatchBarrier | undefined;
  let callIndex = 0;

  for (const call of request.calls) {
    const notStartedCalls = request.calls.slice(callIndex);
    const ordinal = callIndex;
    callIndex += 1;

    // A rejected request never reached a handler and never will: the model has to correct it. It is
    // reported in place rather than dropped, so the result batch still answers every request the
    // model made, in the order it made them. It also establishes the batch barrier: a later call was
    // chosen on the assumption this one's arguments described the world.
    if (isModelRejectedCall(call)) {
      items.push(modelRejectedItem(call));
      barrier ??= { ordinal, code: TOOL_ARGUMENTS_REJECTED };
      continue;
    }

    if (skipRemaining) {
      // The call is not prepared, not admitted, not durably recorded and not executed. It is a
      // batch-level safe statement, not a fabricated Tool execution.
      items.push(skippedItem(call));
      continue;
    }

    if (request.signal.aborted) return cancelledOutcome(items, notStartedCalls);

    const prepared = prepareCall(options, call);
    if (prepared.kind === "REJECTED") {
      // A safe, model-correctable rejection. It never blocks the rest of the batch, and it never
      // created a ToolInvocation, an observation, an approval, a budget reservation or an event.
      items.push(Object.freeze({ kind: "REJECTED", call, feedback: prepared.feedback }));
      barrier ??= { ordinal, code: prepared.feedback.code };
      continue;
    }

    // The failure above happened before this call, and the model believed something about the world
    // when it wrote this one. Only a class that cannot depend on unobserved state may still run.
    if (barrier !== undefined && !mayRunAfterEarlierFailure(schedulingOf(prepared.call))) {
      items.push(dependencyUnprovenItem(call, barrier, ordinal));
      continue;
    }

    const settled = await executeOne(options, request, prepared.call);
    if (settled.kind === "ABORTED") return cancelledOutcome(items, notStartedCalls);
    const outcome = settled.outcome;
    switch (outcome.kind) {
      case "SETTLED": {
        const invocation = outcome.invocation;
        items.push(
          Object.freeze({
            kind: "OBSERVATION",
            call,
            invocationId: invocation.id,
            finalStatus: finalStatusOf(invocation.status),
            observation: outcome.observation,
          }),
        );
        // A known, safe Tool failure is not a barrier: the loop continues. Only an unproven side
        // effect stops the batch.
        if (isUncertainSettlement(invocation.error)) skipRemaining = true;
        else if (invocation.status === "FAILED") barrier ??= { ordinal, code: "TOOL_EXECUTION_FAILED" };
        break;
      }
      case "WAITING_APPROVAL": {
        // The batch stops at the waiting call. `items` holds only the calls that reached a final item
        // outcome *before* this one; the pending call is expressed by `pendingCall` and `approval`,
        // never as a fabricated item.
        return Object.freeze({
          kind: "WAITING_APPROVAL",
          items: Object.freeze([...items]),
          pendingCall: call,
          approval: outcome.approval,
        });
      }
      case "BUDGET_EXCEEDED": {
        // A single-call budget block. The invocation is already durably FAILED, so no REQUESTED row is
        // left behind. No fake observation is constructed: this boundary is not model feedback.
        return Object.freeze({
          kind: "BUDGET_EXCEEDED",
          items: Object.freeze([...items]),
          block: outcome.block,
        });
      }
      case "CANCELLED": {
        // A durably cancelled invocation was recovered. If it carries a legitimate observation, the
        // frozen item contract can express it exactly; if it does not, none is manufactured.
        if (outcome.observation !== undefined) {
          items.push(
            Object.freeze({
              kind: "OBSERVATION",
              call,
              invocationId: outcome.invocation.id,
              finalStatus: "CANCELLED",
              observation: outcome.observation,
            }),
          );
        }
        return cancelledOutcome(items, request.calls.slice(callIndex));
      }
    }
  }

  return Object.freeze({ kind: "COMPLETED", items: Object.freeze([...items]) });
}

/**
 * The opt-in scheduler.
 *
 * ```text
 * prepare the next call                     sequential, unchanged
 * if it declares PARALLEL_SAFE              extend the window over consecutive siblings
 * execute the window                        bounded concurrency, one durable invocation per call
 * assemble the window in original order     first non-settled outcome ends the batch
 * ```
 *
 * The window is bounded by `maxConcurrency` and by the first sibling that is not `PARALLEL_SAFE`, so a
 * mutating call never shares a window. A `REJECTED` sibling ends the window without being executed: it
 * is handled on the next iteration, in order, exactly as before.
 *
 * ## One deliberate difference from the sequential path
 *
 * A window runs to completion before it is interpreted. If one call parks (approval, budget,
 * cancellation) its siblings have already settled, and those settlements are **durable facts**. They
 * are reported in order rather than hidden, so the batch outcome never contradicts the ledger. In the
 * sequential path the same situation cannot arise, which is why its `items` are always a strict prefix.
 */
async function executeCallsWithWindows(
  options: ToolBatchCoordinatorOptions,
  request: ToolBatchRequest,
  maxConcurrency: number,
): Promise<ToolBatchOutcome> {
  const items: ToolBatchItemOutcome[] = [];
  let skipRemaining = false;
  let barrier: BatchBarrier | undefined;
  let index = 0;

  while (index < request.calls.length) {
    const current = request.calls[index]!;
    if (isModelRejectedCall(current)) {
      // Reported even while the batch is skipping dependants: the request was never going to run,
      // and its feedback is what lets the model correct it.
      items.push(modelRejectedItem(current));
      barrier ??= { ordinal: index, code: TOOL_ARGUMENTS_REJECTED };
      index += 1;
      continue;
    }
    if (skipRemaining) {
      items.push(skippedItem(current));
      index += 1;
      continue;
    }
    if (request.signal.aborted) return cancelledOutcome(items, request.calls.slice(index));

    const first = prepareCall(options, current);
    if (first.kind === "REJECTED") {
      items.push(Object.freeze({ kind: "REJECTED", call: current, feedback: first.feedback }));
      barrier ??= { ordinal: index, code: first.feedback.code };
      index += 1;
      continue;
    }

    // The window below must never straddle a barrier. A read may still run; anything else is
    // withheld in place so the model sees exactly which call it has to re-submit.
    if (barrier !== undefined && !mayRunAfterEarlierFailure(schedulingOf(first.call))) {
      items.push(dependencyUnprovenItem(current, barrier, index));
      index += 1;
      continue;
    }

    const window: PreparedToolCall[] = [first.call];
    const windowCalls: ToolCallRequest[] = [current];
    // ALWAYS_ASK or a Guard-capable admission path can park a call on approval. A later sibling must
    // never run before that decision, so both cases remain sequential regardless of Tool declaration.
    const windowingAllowed =
      request.securityContext.approvalPolicy !== "ALWAYS_ASK" &&
      options.parallelism?.admissionMayRequireApproval === false;
    if (windowingAllowed && first.call.resolved.tool.executionMode === "PARALLEL_SAFE") {
      let probe = index + 1;
      while (probe < request.calls.length && window.length < maxConcurrency) {
        const candidate = request.calls[probe]!;
        if (isModelRejectedCall(candidate)) break;
        const prepared = prepareCall(options, candidate);
        if (prepared.kind !== "READY") break;
        if (prepared.call.resolved.tool.executionMode !== "PARALLEL_SAFE") break;
        if (barrier !== undefined && !mayRunAfterEarlierFailure(schedulingOf(prepared.call))) break;
        window.push(prepared.call);
        windowCalls.push(candidate);
        probe += 1;
      }
    }

    const results = await runBoundedByIndex(window.length, maxConcurrency, (offset) =>
      executeOne(options, request, window[offset]!),
    );

    let waitingApproval:
      | {
          readonly call: ToolCallRequest;
          readonly approval: Extract<DurableToolExecutionOutcome, { kind: "WAITING_APPROVAL" }>["approval"];
        }
      | undefined;
    let budgetBlock: Extract<DurableToolExecutionOutcome, { kind: "BUDGET_EXCEEDED" }>["block"] | undefined;
    let cancelled = false;

    for (let offset = 0; offset < results.length; offset += 1) {
      const call = windowCalls[offset]!;
      const result = results[offset]!;
      if (result.kind === "ABORTED") {
        items.push(skippedItem(call, TOOL_NOT_STARTED_CANCELLED_CONTENT));
        cancelled = true;
        continue;
      }
      const outcome = result.outcome;
      switch (outcome.kind) {
        case "SETTLED": {
          const invocation = outcome.invocation;
          items.push(
            Object.freeze({
              kind: "OBSERVATION",
              call,
              invocationId: invocation.id,
              finalStatus: finalStatusOf(invocation.status),
              observation: outcome.observation,
            }),
          );
          if (isUncertainSettlement(invocation.error)) skipRemaining = true;
          else if (invocation.status === "FAILED")
            barrier ??= { ordinal: index + offset, code: "TOOL_EXECUTION_FAILED" };
          break;
        }
        case "WAITING_APPROVAL":
          waitingApproval ??= { call, approval: outcome.approval };
          break;
        case "BUDGET_EXCEEDED":
          budgetBlock ??= outcome.block;
          break;
        case "CANCELLED": {
          if (outcome.observation !== undefined) {
            items.push(
              Object.freeze({
                kind: "OBSERVATION",
                call,
                invocationId: outcome.invocation.id,
                finalStatus: "CANCELLED",
                observation: outcome.observation,
              }),
            );
          }
          cancelled = true;
          break;
        }
      }
    }

    // A parallel window has already run every sibling before its outcomes can be interpreted. Keep
    // every durable result from that window, even when an earlier sibling is waiting or cancelled.
    // Calls after the window never started and remain explicit safe skips on cancellation.
    if (cancelled) {
      return cancelledOutcome(items, request.calls.slice(index + window.length));
    }
    if (waitingApproval !== undefined) {
      return Object.freeze({
        kind: "WAITING_APPROVAL",
        items: Object.freeze([...items]),
        pendingCall: waitingApproval.call,
        approval: waitingApproval.approval,
      });
    }
    if (budgetBlock !== undefined) {
      return Object.freeze({
        kind: "BUDGET_EXCEEDED",
        items: Object.freeze([...items]),
        block: budgetBlock,
      });
    }
    index += window.length;
  }

  return Object.freeze({ kind: "COMPLETED", items: Object.freeze([...items]) });
}

/** Prepare one call, converting a preparation invariant failure into a batch infrastructure failure. */
function prepareCall(
  options: ToolBatchCoordinatorOptions,
  call: ToolCallRequest,
): ToolCallPreparationOutcome {
  try {
    return options.preparer.prepare(call);
  } catch (error) {
    // Registry corruption, a schema-runtime invariant or an unexpected `prepareArguments` throw is an
    // infrastructure failure. It must not be reported as a `REJECTED` item, because the model would
    // then be told to fix a call that may have been perfectly well formed.
    throw new ToolBatchInfrastructureError("Tool call preparation failed.", { cause: error });
  }
}

/**
 * What executing one prepared call produced.
 *
 * `ABORTED` is not a `DurableToolExecutionOutcome` arm: the durable coordinator *throws* when the
 * signal was already aborted, because at that moment no invocation existed and there is nothing durable
 * to report. The batch turns it into its own `CANCELLED` batch outcome, which is the honest statement
 * about the batch as a whole.
 */
type ExecutedCall =
  | { readonly kind: "OUTCOME"; readonly outcome: DurableToolExecutionOutcome }
  | { readonly kind: "ABORTED" };

/**
 * Execute one READY call through the durable lifecycle.
 *
 * A `ToolExecutionAbortedError` is the coordinator's way of saying "cancelled before the durable
 * boundary". Everything else is infrastructure: it is never modelled as model feedback, because "the
 * settlement transaction did not commit" is not a fact about this Tool call.
 */
async function executeOne(
  options: ToolBatchCoordinatorOptions,
  request: ToolBatchRequest,
  call: PreparedToolCall,
): Promise<ExecutedCall> {
  try {
    return {
      kind: "OUTCOME",
      outcome: await options.durable.execute({
        runId: request.runId,
        sessionId: request.sessionId,
        sourceStepId: request.sourceStepId,
        call,
        environment: request.environment,
        securityContext: request.securityContext,
        signal: request.signal,
      }),
    };
  } catch (error) {
    // A parent cancellation owns the outcome even when an admission/Guard boundary reports a
    // wrapped infrastructure error while the abort races with its async evaluation.
    if (request.signal.aborted || error instanceof ToolExecutionAbortedError) {
      return { kind: "ABORTED" };
    }
    throw new ToolBatchInfrastructureError("Tool execution failed.", { cause: error });
  }
}

/* ------------------------------------------------------------------------------------------------
 * Planning
 * ---------------------------------------------------------------------------------------------- */

/**
 * Plan the batch.
 *
 * Resolution happens here **only** to report the declared execution mode of each call for diagnostics;
 * it never decides whether anything runs concurrently. A call whose Tool is not in the catalog is not
 * resolved at all — that call is the Preparer's business, and it will come back as a `REJECTED` item
 * rather than as a planning failure.
 */
function planBatch(
  options: ToolBatchCoordinatorOptions,
  request: ToolBatchRequest,
): ToolBatchExecutionPlan {
  const registry = options.registry;
  if (registry === undefined) return planSequentialToolBatch([]);
  const plannable = request.calls.flatMap((call) => {
    if (isModelRejectedCall(call)) return [];
    const resolved = registry.resolve(call.toolName);
    return resolved === undefined ? [] : [{ toolName: call.toolName, args: call.args, resolved }];
  });
  return planSequentialToolBatch(plannable);
}

/* ------------------------------------------------------------------------------------------------
 * Budget
 * ---------------------------------------------------------------------------------------------- */

/**
 * Ask whether the whole requested segment fits.
 *
 * The frozen boundary takes the **raw** `ToolCallRequest[]` and is asked *before* the per-call
 * preparation loop, so it sizes the batch the model actually requested rather than a segment that
 * preparation might later shrink. This is deliberate: the Budget Port must not import the registry and
 * must not call the Preparer, and the Batch must not prepare twice.
 */
async function preflightBudget(
  options: ToolBatchCoordinatorOptions,
  request: ToolBatchRequest,
): Promise<AgentBudgetBlock | null> {
  try {
    // Only a dispatchable call can be budgeted. A rejected request spends no Tool operation, and
    // counting it would let a malformed turn exhaust a budget nothing was spent from.
    return await options.budget.preflight(request.runId, executableCallsOf(request.calls));
  } catch (error) {
    throw new ToolBatchInfrastructureError("Tool budget preflight failed.", { cause: error });
  }
}

/* ------------------------------------------------------------------------------------------------
 * Items
 * ---------------------------------------------------------------------------------------------- */

function skippedItem(
  call: ToolCallRequest,
  content: string = TOOL_NOT_STARTED_CONTENT,
): ToolBatchItemOutcome {
  const feedback: ToolFailureFeedback = Object.freeze({
    code: TOOL_NOT_STARTED,
    content,
    details: Object.freeze({}),
    disposition: "SAFE_FAILURE",
  });
  return Object.freeze({ kind: "SKIPPED", call, feedback });
}

/**
 * A call withheld because an earlier call in the same batch did not complete.
 *
 * It is a `SKIPPED` item, not a `REJECTED` one: nothing was prepared for dispatch, so calling it a
 * schema rejection would tell the model to fix arguments that may be perfectly valid. The details
 * carry only the source ordinal and the earlier failure's stable code — never its text, arguments or
 * output.
 */
function dependencyUnprovenItem(
  call: ToolCallRequest,
  barrier: BatchBarrier,
  ordinal: number,
): ToolBatchItemOutcome {
  const feedback: ToolFailureFeedback = Object.freeze({
    code: TOOL_DEPENDENCY_UNPROVEN,
    content: TOOL_DEPENDENCY_UNPROVEN_CONTENT,
    details: Object.freeze({
      dependencyBarrierOrdinal: barrier.ordinal,
      dependencyBarrierCode: barrier.code,
      notExecutedOrdinal: ordinal,
    }),
    disposition: "SAFE_FAILURE",
  });
  return Object.freeze({ kind: "SKIPPED", call, feedback });
}

/**
 * The scheduling facts of a prepared call.
 *
 * A Tool that declared nothing is `UNKNOWN`, which is not a read-only default: the declaration is
 * the only proof this layer accepts, and an absent declaration proves nothing.
 */
function schedulingOf(call: PreparedToolCall): ToolSchedulingFacts {
  return call.resolved.tool.scheduling ?? { class: "UNKNOWN" };
}

function cancelledOutcome(
  items: readonly ToolBatchItemOutcome[],
  notStartedCalls: readonly ToolBatchCall[] = [],
): ToolBatchOutcome {
  const cancelledItems = notStartedCalls.map((call) =>
    isModelRejectedCall(call)
      ? // A rejected request was never going to start, so cancellation adds no new information for
        // it; its own feedback is the accurate statement.
        modelRejectedItem(call)
      : skippedItem(call, TOOL_NOT_STARTED_CANCELLED_CONTENT),
  );
  return Object.freeze({
    kind: "CANCELLED",
    items: Object.freeze([...items, ...cancelledItems]),
  });
}

/** Stable model-facing code for a request whose arguments never formed an object. */
export const TOOL_ARGUMENTS_REJECTED = "TOOL_ARGUMENTS_REJECTED";

/**
 * The feedback for a request the model sent with unexecutable arguments.
 *
 * It names the Tool, the reason and the fact that nothing ran, and it never repeats the received
 * bytes: the model wrote them, so quoting them back spends context on text it already has, and the
 * exact bytes belong to the provider replay artifact rather than to model history.
 */
export function modelRejectedArgumentsFeedback(
  call: import("./batch-types.js").ModelRejectedToolCall,
): ToolFailureFeedback {
  const detail =
    call.issue.code === "EXPECTED_OBJECT"
      ? "the arguments were not a JSON object"
      : call.issue.code === "INCOMPLETE_ARGUMENTS"
        ? "the arguments were cut off before they formed a JSON object"
        : "the arguments were not valid JSON";
  return Object.freeze({
    code: TOOL_ARGUMENTS_REJECTED,
    content:
      `This call to ${call.toolName} was rejected before execution because ${detail} ` +
      `(${String(call.issue.argumentBytes)} bytes received). Nothing was executed. ` +
      `Resend ${call.toolName} with complete arguments that match its declared schema, ` +
      `or choose a different approach.`,
    details: Object.freeze({}),
    disposition: "SAFE_FAILURE",
  });
}

function modelRejectedItem(
  call: import("./batch-types.js").ModelRejectedToolCall,
): ToolBatchItemOutcome {
  return Object.freeze({
    kind: "MODEL_REJECTED",
    call,
    feedback: modelRejectedArgumentsFeedback(call),
  });
}

function executableCallsOf(calls: readonly ToolBatchCall[]): readonly ToolCallRequest[] {
  return calls.flatMap((call) => (isModelRejectedCall(call) ? [] : [call]));
}

/**
 * The frozen item status of a durable invocation status.
 *
 * Only a terminal invocation can reach here, so the three-arm mapping is total over the values that
 * can actually occur. A non-terminal status reaching this function would mean the durable coordinator
 * returned an unsettled call as settled, which is an internal invariant violation.
 */
function finalStatusOf(status: string): "COMPLETED" | "FAILED" | "CANCELLED" {
  if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") return status;
  throw new ToolBatchInfrastructureError(
    `A durable Tool settlement reported a non-terminal status ${status}.`,
  );
}

/**
 * Whether a durable invocation records an unproven side effect.
 *
 * The current durable error code is authoritative. The details check remains as read compatibility for
 * historical or host-authored records; uncertainty is never inferred from a Tool name or error text.
 */
function isUncertainSettlement(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { readonly code?: unknown; readonly details?: unknown };
  if (record.code === "TOOL_OUTCOME_UNKNOWN") return true;
  const details = record.details;
  if (typeof details !== "object" || details === null) return false;
  return (
    (details as { readonly executionDisposition?: unknown }).executionDisposition ===
    "UNCERTAIN_SIDE_EFFECT"
  );
}

/* ------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate one batch request, with no side effect of any kind.
 *
 * ```text
 * request is object                runId valid                sessionId valid
 * sourceStepId valid               calls is a non-empty array environment valid
 * securityContext valid            signal is an AbortSignal
 * per call: externalCallId non-empty and bounded, toolName valid, args a JSON object
 * batch-wide: every externalCallId is unique
 * ```
 *
 * The duplicate check runs **here**, before the budget preflight, before any preparation and before any
 * durable write. Discovering a duplicate after executing the first copy would be the one failure mode
 * this ordering exists to make impossible.
 *
 * The key list is exact: the frozen request has seven fields, and an extra field is a caller mistake
 * rather than something to ignore.
 */
export function assertToolBatchRequest(
  value: unknown,
  maxExternalCallIdBytes: number = DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
): ToolBatchRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolBatchInputError();
  }
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (
    keys.length !== BATCH_REQUEST_KEYS.length ||
    !BATCH_REQUEST_KEYS.every((key) => Object.hasOwn(request, key)) ||
    !RunIdSchema.safeParse(request.runId).success ||
    !SessionIdSchema.safeParse(request.sessionId).success ||
    !StepIdSchema.safeParse(request.sourceStepId).success ||
    !Array.isArray(request.calls) ||
    request.calls.length === 0 ||
    !(request.signal instanceof AbortSignal)
  ) {
    throw new ToolBatchInputError();
  }
  try {
    if (!isToolExecutionEnvironment(request.environment)) throw new ToolBatchInputError();
    assertToolSecurityContext(request.securityContext);
  } catch {
    // A malformed execution environment or security context is a caller error, not an infrastructure
    // failure: it is knowable from the request alone, before anything durable exists.
    throw new ToolBatchInputError();
  }
  const seen = new Set<string>();
  const calls: ToolBatchCall[] = [];
  for (const entry of request.calls) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolBatchInputError();
    }
    const call = entry as Record<string, unknown>;
    const externalCallId =
      typeof call.externalCallId === "string" ? call.externalCallId : undefined;
    if (
      externalCallId === undefined ||
      externalCallId.length === 0 ||
      Buffer.byteLength(externalCallId, "utf8") > maxExternalCallIdBytes ||
      seen.has(externalCallId)
    ) {
      throw new ToolBatchInputError();
    }

    // A rejected request shares the identity fields and carries a typed reason instead of arguments.
    // It is validated on its own key set so neither shape can smuggle a field of the other.
    if (Object.hasOwn(call, "issue")) {
      const parsedToolName = ToolNameSchema.safeParse(call.toolName);
      const issue = assertRejectedIssueShape(call.issue);
      const keys = Object.keys(call);
      if (
        keys.length !== REJECTED_CALL_KEYS.length ||
        !REJECTED_CALL_KEYS.every((key) => Object.hasOwn(call, key)) ||
        !parsedToolName.success
      ) {
        throw new ToolBatchInputError();
      }
      seen.add(externalCallId);
      calls.push({
        externalCallId,
        toolName: parsedToolName.data,
        issue,
      });
      continue;
    }

    const parsedToolName = ToolNameSchema.safeParse(call.toolName);
    const parsedArgs = JsonObjectSchema.safeParse(call.args);
    if (
      Object.keys(call).length !== TOOL_CALL_REQUEST_KEYS.length ||
      !TOOL_CALL_REQUEST_KEYS.every((key) => Object.hasOwn(call, key)) ||
      !parsedToolName.success ||
      !parsedArgs.success
    ) {
      throw new ToolBatchInputError();
    }
    seen.add(externalCallId);
    calls.push({
      externalCallId,
      toolName: parsedToolName.data,
      args: parsedArgs.data as ToolCallRequest["args"],
    });
  }

  return Object.freeze({
    runId: RunIdSchema.parse(request.runId),
    sessionId: SessionIdSchema.parse(request.sessionId),
    sourceStepId: StepIdSchema.parse(request.sourceStepId),
    calls: Object.freeze(calls),
    environment: request.environment as ToolBatchRequest["environment"],
    securityContext: request.securityContext as ToolBatchRequest["securityContext"],
    signal: request.signal,
  });
}

const BATCH_REQUEST_KEYS = [
  "runId",
  "sessionId",
  "sourceStepId",
  "calls",
  "environment",
  "securityContext",
  "signal",
] as const;

const TOOL_CALL_REQUEST_KEYS = ["externalCallId", "toolName", "args"] as const;

const REJECTED_CALL_KEYS = ["externalCallId", "toolName", "issue"] as const;

/**
 * Validate a rejected-argument issue.
 *
 * The reason code is a closed set and the byte count is the *only* numeric fact carried, so a caller
 * can never attach the received text, a parser message or an exception to this contract.
 */
function assertRejectedIssueShape(value: unknown): AIRejectedToolArgumentsIssue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolBatchInputError();
  }
  const issue = value as Record<string, unknown>;
  const keys = Object.keys(issue);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(issue, "code") ||
    !Object.hasOwn(issue, "argumentBytes") ||
    (issue.code !== "MALFORMED_JSON" &&
      issue.code !== "EXPECTED_OBJECT" &&
      issue.code !== "INCOMPLETE_ARGUMENTS") ||
    !Number.isSafeInteger(issue.argumentBytes) ||
    (issue.argumentBytes as number) < 0
  ) {
    throw new ToolBatchInputError();
  }
  return { code: issue.code, argumentBytes: issue.argumentBytes as number };
}
