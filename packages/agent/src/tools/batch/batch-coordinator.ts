import {
  JsonObjectSchema,
  RunIdSchema,
  SessionIdSchema,
  StepIdSchema,
  ToolNameSchema,
} from "@caelush/protocol";

import type { AgentBudgetBlock } from "../../loop/ports/model-request-admission.js";
import { isToolExecutionEnvironment } from "../types/execution-environment.js";
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
import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import { planSequentialToolBatch, type ToolBatchExecutionPlan } from "./batch-planner.js";
import { ToolBatchInfrastructureError, ToolBatchInputError } from "./batch-errors.js";
import type {
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
 *                                            if UNCERTAIN_SIDE_EFFECT: skipRemaining = true
 *                       WAITING_APPROVAL  -> return WAITING_APPROVAL
 *                       BUDGET_EXCEEDED   -> return BUDGET_EXCEEDED
 *                       CANCELLED         -> return CANCELLED
 * return COMPLETED
 * ```
 *
 * ## Strictly sequential, and structurally so
 *
 * The loop is an ordinary `for` over the calls. There is no `Promise.all`, no worker pool and no
 * completion-order contract, and a Tool that declares `PARALLEL_SAFE` changes nothing: the first
 * implementation of the frozen scheduler is sequential for every batch. `call_1` is fully decided
 * before `call_2` is prepared.
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
 * ## Why a rejection is not a barrier but an uncertain execution is
 *
 * A `REJECTED` call executed nothing, so the next call is unaffected and the loop continues: the model
 * asked for two things, one of them was malformed, and the other is still worth doing.
 *
 * An `UNCERTAIN_SIDE_EFFECT` settlement means a Tool may have partially or fully changed the world. The
 * remaining calls were chosen by a model that believed the earlier ones had not run, so running them
 * would apply a plan to a state nobody observed. They become `SKIPPED` — safe feedback, no durable row,
 * no execution.
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
}

/**
 * The model-facing code a skipped call carries.
 *
 * Stable and never localized, exactly like the rejection codes. It is deliberately the code the legacy
 * batch used, so a model that had learned to recognize it does not have to relearn it.
 */
export const SKIPPED_AFTER_UNCERTAIN_EXECUTION = "SKIPPED_AFTER_UNCERTAIN_EXECUTION";

/**
 * The content a skipped call shows the model.
 *
 * It states three things and nothing more: an earlier Tool may have run, this dependent chain must not
 * continue automatically, and the state should be re-inspected before retrying. It carries no raw
 * exception, no absolute path, no command output, no secret and no stack — a skip is a *batch* fact, not
 * a report about somebody's failed operation.
 */
export const SKIPPED_AFTER_UNCERTAIN_CONTENT =
  "This tool call was skipped because an earlier tool execution may have partially or fully completed. " +
  "Do not continue this dependent tool chain automatically; re-inspect the current state before retrying.";

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
      if (request.signal.aborted) return cancelledOutcome([]);

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
  // The scheduling decision is made once, before the first call, from the whole batch. It is always
  // the sequential plan: a Tool that declares `PARALLEL_SAFE` is still run in order.
  const plan = planBatch(options, request);
  if (plan.kind !== "SEQUENTIAL") {
    throw new ToolBatchInfrastructureError("The Tool batch produced a non-sequential plan.");
  }

  const items: ToolBatchItemOutcome[] = [];
  let skipRemaining = false;

  for (const call of request.calls) {
    if (skipRemaining) {
      // The call is not prepared, not admitted, not durably recorded and not executed. It is a
      // batch-level safe statement, not a fabricated Tool execution.
      items.push(skippedItem(call));
      continue;
    }

    if (request.signal.aborted) return cancelledOutcome(items);

    const prepared = prepareCall(options, call);
    if (prepared.kind === "REJECTED") {
      // A safe, model-correctable rejection. It never blocks the rest of the batch, and it never
      // created a ToolInvocation, an observation, an approval, a budget reservation or an event.
      items.push(Object.freeze({ kind: "REJECTED", call, feedback: prepared.feedback }));
      continue;
    }

    const settled = await executeOne(options, request, prepared.call);
    if (settled.kind === "ABORTED") return cancelledOutcome(items);
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
        if (isUncertainSettlement(invocation.error?.details)) skipRemaining = true;
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
        return cancelledOutcome(items);
      }
    }
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
    if (error instanceof ToolExecutionAbortedError) return { kind: "ABORTED" };
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
    return await options.budget.preflight(request.runId, request.calls);
  } catch (error) {
    throw new ToolBatchInfrastructureError("Tool budget preflight failed.", { cause: error });
  }
}

/* ------------------------------------------------------------------------------------------------
 * Items
 * ---------------------------------------------------------------------------------------------- */

function skippedItem(call: ToolCallRequest): ToolBatchItemOutcome {
  const feedback: ToolFailureFeedback = Object.freeze({
    code: SKIPPED_AFTER_UNCERTAIN_EXECUTION,
    content: SKIPPED_AFTER_UNCERTAIN_CONTENT,
    details: Object.freeze({}),
    disposition: "UNCERTAIN_SIDE_EFFECT",
  });
  return Object.freeze({ kind: "SKIPPED", call, feedback });
}

function cancelledOutcome(items: readonly ToolBatchItemOutcome[]): ToolBatchOutcome {
  return Object.freeze({ kind: "CANCELLED", items: Object.freeze([...items]) });
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
 * Read from the durable error's `details`, which is where the settlement wrote it. The batch does not
 * infer uncertainty from a Tool name, an error message or a status: only the durable record decides.
 */
function isUncertainSettlement(details: unknown): boolean {
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
  const calls: ToolCallRequest[] = [];
  for (const entry of request.calls) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolBatchInputError();
    }
    const call = entry as Record<string, unknown>;
    const externalCallId = typeof call.externalCallId === "string" ? call.externalCallId : undefined;
    const parsedToolName = ToolNameSchema.safeParse(call.toolName);
    const parsedArgs = JsonObjectSchema.safeParse(call.args);
    if (
      Object.keys(call).length !== TOOL_CALL_REQUEST_KEYS.length ||
      !TOOL_CALL_REQUEST_KEYS.every((key) => Object.hasOwn(call, key)) ||
      externalCallId === undefined ||
      externalCallId.length === 0 ||
      Buffer.byteLength(externalCallId, "utf8") > maxExternalCallIdBytes ||
      seen.has(externalCallId) ||
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
