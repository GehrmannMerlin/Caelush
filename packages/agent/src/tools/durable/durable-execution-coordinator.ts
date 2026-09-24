import type {
  ApprovalRequest,
  JsonObject,
  ObservationId,
  RunId,
  SessionId,
  StepId,
  ToolInvocation,
  ToolInvocationId,
  ToolObservation,
  TimestampMs,
} from "@caelush/protocol";

import type { AgentBudgetBlock } from "../../loop/ports/model-request-admission.js";
import type { PreparedToolCall } from "../call/tool-call-preparer.js";
import type { AgentToolResult } from "../types/tool-result.js";
import { ToolExecutionInfrastructureError } from "../types/errors.js";
import type { ToolExecutionEnvironment } from "../types/execution-environment.js";
import type { ToolExecutionIdentity } from "../types/execution-identity.js";
import type { ToolPresentationPort } from "../types/tool-presentation.js";
import {
  isToolExecutionUncertainError,
  uncertainExecutionDetails,
} from "../execution/execution-disposition.js";
import type { ToolInvocationExecutor } from "../execution/invocation-executor.js";
import type { ToolExecutionUpdateSanitizerPort } from "../execution/update-sanitizer-port.js";
import type { ToolResultPipeline } from "../result/result-pipeline.js";
import { ToolResultValidationError } from "../result/result-sanitizer-port.js";
import { canonicalJsonString } from "../schema/json-canonical.js";
import type { ToolAdmissionCoordinator } from "../admission/admission-coordinator.js";
import type { ToolApprovalRequestFactory } from "../admission/approval-port.js";
import type { ToolSecurityContext } from "../admission/security-context.js";
import type { ToolDurableMetadataPort } from "../admission/durable-metadata-port.js";
import {
  createToolSettlementCoordinator,
  type ToolSettlementCoordinator,
} from "./settlement-coordinator.js";
import {
  feedbackToDurableFailure,
  type DurableToolFailureSettlement,
} from "./failure-settlement.js";
import {
  createRequestedToolInvocation,
  isTerminalToolInvocation,
  markToolInvocationWaitingApproval,
  startToolInvocation,
} from "./invocation-lifecycle.js";
import {
  createApprovalRequestedEvent,
  createToolRequestedEvent,
  createToolStartedEvent,
} from "./durable-events.js";
import { ToolExecutionConflictError, ToolExecutionInvariantError } from "./durable-errors.js";
import type {
  ToolExecutionCommitResult,
  ToolExecutionSnapshot,
  ToolExecutionStorePort,
} from "./execution-store-port.js";
import type { RunEventNotifierPort } from "../../events/notifier-port.js";

/* ------------------------------------------------------------------------------------------------
 * The frozen contracts
 * ---------------------------------------------------------------------------------------------- */

/**
 * One READY Tool call to execute durably.
 *
 * ```ts
 * export interface DurableToolExecutionRequest {
 *   readonly runId: RunId;
 *   readonly sessionId: SessionId;
 *   readonly sourceStepId: StepId;
 *   readonly call: PreparedToolCall;
 *   readonly environment: ToolExecutionEnvironment;
 *   readonly securityContext: ToolSecurityContext;
 *   readonly signal: AbortSignal;
 * }
 * ```
 *
 * Seven fields, and the list is closed. There is deliberately no `Run`, no workspace, no registry, no
 * storage handle, no approval store, no budget store, no Runtime object and no `ToolEffect[]`: every
 * one of those is an implementation dependency of the coordinator, supplied at construction, and
 * naming one here would make every caller of a general Agent host describe it.
 *
 * `call` is a **`PreparedToolCall`**, which is the load-bearing decision of this contract. By the time
 * a request exists, resolution, argument normalization and input-schema validation have already
 * happened — so this boundary never has to answer "was the Tool unknown?", "were the arguments
 * malformed?" or "did the Preparer refuse?". Those pre-invocation rejections keep their historical
 * production behaviour in the legacy facade until they are switched over; this contract simply has no
 * arm for them, which is what stops a second rejection algorithm from appearing here.
 */
export interface DurableToolExecutionRequest {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sourceStepId: StepId;
  readonly call: PreparedToolCall;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
  readonly signal: AbortSignal;
}

/**
 * What one durable Tool call produced.
 *
 * ```ts
 * export type DurableToolExecutionOutcome =
 *   | { readonly kind: "SETTLED"; readonly invocation; readonly observation }
 *   | { readonly kind: "WAITING_APPROVAL"; readonly invocation; readonly approval }
 *   | { readonly kind: "BUDGET_EXCEEDED"; readonly invocation; readonly block }
 *   | { readonly kind: "CANCELLED"; readonly invocation; readonly observation? };
 * ```
 *
 * Four arms, and the list is closed:
 *
 * ```text
 * SETTLED           the call has a final durable fact, success or failure, plus its observation
 * WAITING_APPROVAL  parked on a durably created approval; the Run layer owns what happens next
 * BUDGET_EXCEEDED   a budget block; the invocation is already durably FAILED, so no REQUESTED row is
 *                   left behind for a reader to misinterpret
 * CANCELLED         a durably cancelled invocation was recovered; nothing was executed
 * ```
 *
 * There is deliberately no `DENIED`, no `FAILED`, no `RUNNING`, no `RETRY` and no
 * `INFRASTRUCTURE_ERROR` arm. A denial, a rejection, an uncertain side effect and a result-contract
 * violation all end as `SETTLED` with a failed invocation and a safe observation, because that is
 * exactly what they are: a Tool call with a final durable answer. An infrastructure failure is
 * **thrown** — a caller that received it as a value could file it beside a real outcome, and the only
 * safe reading of "the settlement transaction did not commit" is that the Tool boundary failed.
 */
export type DurableToolExecutionOutcome =
  | {
      readonly kind: "SETTLED";
      readonly invocation: ToolInvocation;
      readonly observation: ToolObservation;
    }
  | {
      readonly kind: "WAITING_APPROVAL";
      readonly invocation: ToolInvocation;
      readonly approval: ApprovalRequest;
    }
  | {
      readonly kind: "BUDGET_EXCEEDED";
      readonly invocation: ToolInvocation;
      readonly block: AgentBudgetBlock;
    }
  | {
      readonly kind: "CANCELLED";
      readonly invocation: ToolInvocation;
      readonly observation?: ToolObservation | undefined;
    };

/**
 * The Tool Invocation Lifecycle Authority.
 *
 * ```ts
 * export interface DurableToolExecutionCoordinator {
 *   execute(request: DurableToolExecutionRequest): Promise<DurableToolExecutionOutcome>;
 *   recover(
 *     snapshot: ToolExecutionSnapshot,
 *     input: {
 *       readonly environment: ToolExecutionEnvironment;
 *       readonly securityContext: ToolSecurityContext;
 *       readonly signal: AbortSignal;
 *     },
 *   ): Promise<DurableToolExecutionOutcome>;
 * }
 * ```
 *
 * ## The chain it drives
 *
 * ```text
 * ① idempotency lookup by (runId, sourceStepId, externalCallId)
 * ② create REQUESTED, commit it durably, notify
 * ③ ToolAdmissionCoordinator     policy → approval → budget
 * ④ create RUNNING, commit it durably with the budget start, notify
 * ⑤ ToolInvocationExecutor       the canonical execution authority   (Phase 4B)
 * ⑥ raw artifact archive         the complete, pre-projection output
 * ⑦ ToolResultPipeline           validate → sanitize → revalidate → bound → project   (Phase 4B)
 * ⑧ ToolSettlementCoordinator    terminal invocation + observation + events + extension, atomically
 * ```
 *
 * Steps ⑤ and ⑦ are called, never reimplemented. Step ⑧ is this round's.
 *
 * ## Ordering that is not negotiable
 *
 * ```text
 * REQUESTED is durable before admission has any side effect
 * RUNNING is durable before the Tool handler is invoked
 * the terminal commit happens before the budget's second statement
 * durable commit happens before any committed-event notification
 * ```
 *
 * The second line is the whole reason a restart is safe: a `RUNNING` row means "the side effect
 * boundary was crossed", so recovery must treat it as uncertain rather than re-run it. A coordinator
 * that committed `RUNNING` after executing would make a crash mid-handler indistinguishable from a
 * crash before it.
 */
export interface DurableToolExecutionCoordinator {
  execute(request: DurableToolExecutionRequest): Promise<DurableToolExecutionOutcome>;

  recover(
    snapshot: ToolExecutionSnapshot,
    input: {
      readonly environment: ToolExecutionEnvironment;
      readonly securityContext: ToolSecurityContext;
      readonly signal: AbortSignal;
    },
  ): Promise<DurableToolExecutionOutcome>;
}

/* ------------------------------------------------------------------------------------------------
 * Construction
 * ---------------------------------------------------------------------------------------------- */

/** Builds the executor for one durably started invocation. */
export type DurableInvocationExecutorFactory = (input: {
  readonly invocation: ToolInvocation;
  readonly sessionId: SessionId;
  readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
}) => ToolInvocationExecutor;

/** Builds the result pipeline for one invocation. */
export type DurableResultPipelineFactory = (input: {
  readonly invocation: ToolInvocation;
  readonly environment: ToolExecutionEnvironment;
  readonly sessionId?: SessionId | undefined;
}) => ToolResultPipeline;

/** Projects durable invocation state back onto the canonical prepared call. */
export type DurablePreparedCallFactory = (input: {
  readonly invocation: ToolInvocation;
  readonly externalCallId: string;
}) => PreparedToolCall;

/** The Tool budget half the coordinator drives. `admit` already ran inside admission. */
export interface DurableToolBudgetPort {
  start(input: {
    readonly runId: RunId;
    readonly invocationId: ToolInvocationId;
    readonly startedAt: TimestampMs;
  }): Promise<void>;
  settle(input: {
    readonly runId: RunId;
    readonly invocationId: ToolInvocationId;
    readonly status: import("@caelush/protocol").ToolInvocationStatus;
    readonly finishedAt: TimestampMs;
  }): Promise<void>;
}

/** The host archive the complete pre-projection Tool output is written to. */
export interface DurableRawOutputStore {
  createOrGet(input: {
    readonly artifactId?: string;
    readonly runId: string;
    readonly kind: string;
    readonly sourceRef: string;
    readonly content: string;
    readonly mimeType: string;
    readonly sensitivity: "PUBLIC" | "INTERNAL" | "SENSITIVE";
    readonly createdSequence: number;
    readonly createdAt: number;
  }): Promise<{ readonly artifactId: string }>;
}

export interface DurableToolExecutionCoordinatorOptions {
  readonly store: ToolExecutionStorePort;
  /** Policy, approval and budget admission. Absent means this host admits every call. */
  readonly admission: ToolAdmissionCoordinator;
  /** The durable metadata the invocation row requires. Never `AgentTool`'s business. */
  readonly metadata: ToolDurableMetadataPort;
  /** How a durable `ApprovalRequest` is built from a requirement. */
  readonly approvalRequests: ToolApprovalRequestFactory;
  readonly invocationIdFactory: { create(): ToolInvocationId };
  readonly observationIdFactory: { create(): ObservationId };
  readonly eventIdFactory: { create(): import("@caelush/protocol").EventId };
  readonly clock: { now(): TimestampMs };
  readonly invocationExecutorFactory: DurableInvocationExecutorFactory;
  readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
  readonly resultPipelineFactory: DurableResultPipelineFactory;
  readonly preparedCallFactory: DurablePreparedCallFactory;
  readonly failureSettlement: DurableToolFailureSettlement;
  /**
   * The durable approval lookup, used only so recovery can compare the identity a stored approval was
   * created under against the one admission recomputes today.
   */
  readonly approvalLookup?:
    import("../admission/approval-port.js").ToolApprovalLookupPort | undefined;
  readonly budget?: DurableToolBudgetPort | undefined;
  readonly presentation?: ToolPresentationPort | undefined;
  readonly rawOutputStore?: DurableRawOutputStore | undefined;
  readonly notifier?: RunEventNotifierPort | undefined;
  /** Bounds the model-facing content a *failure* settlement writes. */
  readonly boundFailureContent?: ((content: string) => string) | undefined;
  readonly settlementCoordinator?: ToolSettlementCoordinator | undefined;
  /** A same-process, in-flight guard. Not a correctness mechanism; durable identity is. */
  readonly activeCalls?: Set<string> | undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Safe failure content
 * ---------------------------------------------------------------------------------------------- */

const INTERRUPTED_CONTENT =
  "Tool execution was interrupted before its result was durably recorded. The operation may have partially or fully executed. Do not automatically repeat the operation.";
const RUNTIME_CONTENT =
  "Tool execution failed because the tool runtime encountered an internal error.";
const OUTPUT_CONTENT = "Tool execution failed because its output violated the registered contract.";
const UNCERTAIN_CONTENT =
  "Tool execution side effects could not be verified safely. Do not automatically repeat the operation.";

const BUDGET_CONTENT = "Tool execution budget is exhausted.";
const DENIED_CONTENT = "Tool execution was denied by the active execution policy.";
const APPROVAL_REJECTED_CONTENT = "Tool execution was not approved by the user.";

/** The request shape this module drives internally, carrying the session the snapshot owns. */
interface ExecutionInput {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly call: PreparedToolCall;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
  readonly signal: AbortSignal;
}

/* ------------------------------------------------------------------------------------------------
 * The coordinator
 * ---------------------------------------------------------------------------------------------- */

export function createDurableToolExecutionCoordinator(
  input: DurableToolExecutionCoordinatorOptions,
): DurableToolExecutionCoordinator {
  const activeCalls = input.activeCalls ?? new Set<string>();
  const boundFailureContent = input.boundFailureContent ?? ((content: string): string => content);
  /**
   * The raw artifact reference for the invocation currently being settled.
   *
   * ```text
   * archive writes the complete pre-projection output → binding.set(reference)
   * ToolSettlementCoordinator.settle(...)            → binding.resolve() → the durable observation
   * ```
   *
   * The frozen `settle` input has no field for it, and the general settlement layer must not learn that
   * a host archive exists — so the reference is bound here, on the coordinator that produced it, and
   * read back through an invocation-bound resolver. This is an implementation seam, not a contract
   * expansion.
   */
  const rawArtifact: RawArtifactBinding = createRawArtifactBinding();
  const settlementCoordinator: ToolSettlementCoordinator =
    input.settlementCoordinator ??
    createToolSettlementCoordinator({
      store: input.store,
      clock: input.clock,
      observationIdFactory: input.observationIdFactory,
      eventIdFactory: input.eventIdFactory,
      ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.notifier === undefined ? {} : { notifier: input.notifier }),
      rawArtifactRef: () => rawArtifact.resolve(),
    });

  async function commitAndNotify(
    command: Parameters<ToolExecutionStorePort["commit"]>[0],
  ): Promise<ToolExecutionCommitResult> {
    let result: ToolExecutionCommitResult;
    try {
      result = await input.store.commit(command);
    } catch (error) {
      if (error instanceof ToolExecutionConflictError) throw error;
      if (error instanceof ToolExecutionInvariantError) throw error;
      throw new ToolExecutionInfrastructureError(
        "SETTLEMENT",
        "Tool execution persistence failed.",
        { cause: error },
      );
    }
    // Durable truth first, notification second. A live subscriber is told about a commit that already
    // happened; it is never told about one that might still roll back.
    if (result.events.length > 0) input.notifier?.notifyCommitted(result.events);
    return result;
  }

  async function settleDurableFailure(failure: {
    readonly snapshot: ToolExecutionSnapshot;
    readonly code: import("@caelush/protocol").AgentError["code"];
    readonly phase: import("@caelush/protocol").AgentError["phase"];
    readonly message: string;
    readonly content: string;
    readonly details?: JsonObject | undefined;
    readonly errorDetails?: JsonObject | undefined;
  }): Promise<DurableToolExecutionOutcome> {
    const committed = await input.failureSettlement.settleFailure({
      snapshot: failure.snapshot,
      code: failure.code,
      phase: failure.phase,
      message: failure.message,
      content: boundFailureContent(failure.content),
      ...(failure.details === undefined ? {} : { details: failure.details }),
      ...(failure.errorDetails === undefined ? {} : { errorDetails: failure.errorDetails }),
      now: input.clock.now(),
    });
    const observation = committed.snapshot.observation;
    if (observation === undefined) {
      throw new ToolExecutionInvariantError("Tool settlement committed without an observation.");
    }
    return Object.freeze({
      kind: "SETTLED",
      invocation: committed.snapshot.invocation,
      observation,
    });
  }

  async function startAndExecute(
    execution: ExecutionInput,
    snapshot: ToolExecutionSnapshot,
  ): Promise<DurableToolExecutionOutcome> {
    const startedAt = input.clock.now();
    const running = startToolInvocation(snapshot.invocation, startedAt);
    const committed = await commitAndNotify({
      sessionId: snapshot.sessionId,
      invocation: running,
      expectedRevision: snapshot.revision,
      events: [
        createToolStartedEvent({
          eventId: input.eventIdFactory.create(),
          sessionId: snapshot.sessionId,
          timestamp: startedAt,
          invocation: running,
          ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
        }),
      ],
      // The reservation moves to IN_FLIGHT inside the same transaction that commits RUNNING, so no
      // crash can leave a RUNNING invocation whose budget was never started.
      ...(input.budget === undefined ? {} : { budgetStart: { ownerId: running.id, startedAt } }),
    });
    // `start` is a frozen part of the budget port and stays callable. After an atomic start it is a
    // no-op, which is the idempotent second statement the port requires.
    await startBudget(input, running.runId, running.id, startedAt);
    return await executeAndSettle(execution, committed.snapshot);
  }

  async function admitAndProceed(
    execution: ExecutionInput,
    snapshot: ToolExecutionSnapshot,
  ): Promise<DurableToolExecutionOutcome> {
    const invocation = snapshot.invocation;
    if (invocation.status !== "REQUESTED") {
      throw new ToolExecutionInfrastructureError(
        "ADMISSION",
        `Tool admission requires a REQUESTED invocation, not ${invocation.status}.`,
      );
    }
    const admitted = await input.admission.admit({
      sessionId: snapshot.sessionId,
      invocation,
      call: execution.call,
      environment: execution.environment,
      securityContext: execution.securityContext,
    });

    if (admitted.kind === "WAITING_APPROVAL") {
      const waiting = markToolInvocationWaitingApproval(invocation);
      const approval = admitted.approval;
      const committed = await commitAndNotify({
        sessionId: snapshot.sessionId,
        invocation: waiting,
        expectedRevision: snapshot.revision,
        approval,
        approvalKey: admitted.approvalKey,
        events: [
          createApprovalRequestedEvent({
            eventId: input.eventIdFactory.create(),
            sessionId: snapshot.sessionId,
            stepId: waiting.stepId,
            timestamp: approval.createdAt,
            approval,
          }),
        ],
      });
      if (committed.snapshot.approval === undefined) {
        throw new ToolExecutionInvariantError("Approval request was not durably committed.");
      }
      return Object.freeze({
        kind: "WAITING_APPROVAL",
        invocation: committed.snapshot.invocation,
        approval: committed.snapshot.approval,
      });
    }

    if (admitted.kind === "DENY") {
      const failure = feedbackToDurableFailure(admitted.feedback);
      return await settleDurableFailure({
        snapshot,
        code: failure.code,
        phase: failure.phase,
        message: failure.message,
        content: admitted.feedback.content,
        // `ToolFailureFeedback` speaks the AI package's JSON model; the durable observation and the
        // Protocol `AgentError.details` speak the Protocol one. They describe the same JSON value and
        // differ only in declaration, so this is the boundary where the two vocabularies meet.
        details: admitted.feedback.details as unknown as JsonObject,
      });
    }

    if (admitted.kind === "BUDGET_EXCEEDED") {
      const committed = await input.failureSettlement.settleFailure({
        snapshot,
        code: "BUDGET_EXCEEDED",
        phase: "INTERNAL",
        message: "Tool execution returned an error result.",
        content: boundFailureContent(BUDGET_CONTENT),
        now: input.clock.now(),
      });
      return Object.freeze({
        kind: "BUDGET_EXCEEDED",
        invocation: committed.snapshot.invocation,
        block: admitted.block,
      });
    }

    return await startAndExecute(execution, snapshot);
  }

  async function executeAndSettle(
    execution: ExecutionInput,
    snapshot: ToolExecutionSnapshot,
  ): Promise<DurableToolExecutionOutcome> {
    const invocation = snapshot.invocation;
    const identity: ToolExecutionIdentity = Object.freeze({
      runId: invocation.runId,
      sessionId: snapshot.sessionId,
      sourceStepId: invocation.stepId,
      invocationId: invocation.id,
      externalCallId: execution.call.request.externalCallId,
    });
    const executor = input.invocationExecutorFactory({
      invocation,
      sessionId: snapshot.sessionId,
      updateSanitizer: input.updateSanitizer,
    });

    let rawResult: AgentToolResult;
    try {
      rawResult = await executor.execute({
        call: execution.call,
        identity,
        environment: execution.environment,
        signal: execution.signal,
      });
    } catch (error) {
      if (isToolExecutionUncertainError(error)) {
        return await settleDurableFailure({
          snapshot,
          code: "TOOL_EXECUTION_ERROR",
          phase: "RUNTIME",
          message: "Tool execution returned an error result.",
          content: UNCERTAIN_CONTENT,
          // The disposition lives on the durable error's `details`, where recovery reads it to decide
          // that this call must not be repeated automatically.
          errorDetails: { ...uncertainExecutionDetails() },
        });
      }
      // An unclassified handler throw keeps its existing durable semantics: the invocation settles
      // FAILED as a runtime error, and only then does the boundary fail as infrastructure. The durable
      // evidence is written first because a model that was told "the tool failed" would otherwise
      // retry a call whose durable truth was never recorded.
      await input.failureSettlement.settleFailure({
        snapshot,
        code: "RUNTIME_ERROR",
        phase: "RUNTIME",
        message: "Tool execution returned an error result.",
        content: boundFailureContent(RUNTIME_CONTENT),
        now: input.clock.now(),
      });
      throw new ToolExecutionInfrastructureError("EXECUTION", "Tool execution failed.", {
        cause: error,
      });
    }

    // The raw archive, between execution and result processing: it carries the complete pre-projection
    // output, exactly as it always has, and it is written before the pipeline bounds anything. The
    // reference is bound here, because the frozen settlement signature has no field for it.
    rawArtifact.set(await archiveRawResult(input, snapshot.invocation, rawResult));
    const finishedAt = input.clock.now();
    let settlement;
    try {
      settlement = input
        .resultPipelineFactory({
          invocation,
          environment: execution.environment,
          sessionId: snapshot.sessionId,
        })
        .process({
          call: execution.call,
          invocation,
          rawResult,
          now: finishedAt,
        });
    } catch (error) {
      if (error instanceof ToolResultValidationError) {
        await input.failureSettlement.settleFailure({
          snapshot,
          code: "TOOL_OUTPUT_ERROR",
          phase: "TOOL",
          message: "Tool execution returned an error result.",
          content: boundFailureContent(OUTPUT_CONTENT),
          now: input.clock.now(),
        });
        throw new ToolExecutionInfrastructureError(
          "RESULT_PIPELINE",
          "Tool result violated its registered contract.",
          { cause: error },
        );
      }
      // A pipeline infrastructure failure invents nothing: no successful settlement, no fabricated
      // output error. The invocation stays RUNNING and the boundary fails.
      throw new ToolExecutionInfrastructureError(
        "RESULT_PIPELINE",
        "Tool result processing failed.",
        { cause: error },
      );
    }

    const settledSnapshot = await settlementCoordinator.settle({
      snapshot,
      settlement,
      now: finishedAt,
    });
    rawArtifact.clear();
    const observation = settledSnapshot.observation;
    if (observation === undefined) {
      throw new ToolExecutionInvariantError("Tool settlement produced no observation.");
    }
    return Object.freeze({
      kind: "SETTLED",
      invocation: settledSnapshot.invocation,
      observation,
    });
  }

  async function recoverWaitingApproval(
    execution: ExecutionInput,
    snapshot: ToolExecutionSnapshot,
  ): Promise<DurableToolExecutionOutcome> {
    // The approval is read from its own durable home first, because a host store may not echo it back
    // inside the invocation's snapshot. The snapshot is the fallback, never the authority: an approval
    // that has since been resolved must be seen as resolved.
    const loaded =
      input.approvalLookup === undefined ? null : await loadApproval(input, snapshot.invocation.id);
    const approval = loaded ?? snapshot.approval;
    if (approval === undefined || approval === null) {
      throw new ToolExecutionInfrastructureError(
        "RECOVERY",
        "Waiting ToolInvocation has no ApprovalRequest.",
      );
    }
    if (approval.status === "PENDING") {
      return Object.freeze({
        kind: "WAITING_APPROVAL",
        invocation: snapshot.invocation,
        approval,
      });
    }
    if (approval.status !== "APPROVED") {
      // REJECTED, EXPIRED and CANCELLED keep their existing safe failure semantics: a durable FAILED
      // invocation, a safe observation and a `tool.failed` event. The handler never runs.
      return await settleDurableFailure({
        snapshot,
        code: "APPROVAL_REJECTED",
        phase: "SECURITY",
        message: APPROVAL_REJECTED_CONTENT,
        content: APPROVAL_REJECTED_CONTENT,
        errorDetails: { approvalStatus: approval.status },
      });
    }

    // Approved. Admission is re-evaluated from current durable state, and the layer that owns the
    // approval identity recomputes the opaque key. The stored key is handed in so the comparison
    // happens against the identity this exact call would be admitted under today.
    const storedApprovalKey = await lookupStoredApprovalKey(input, snapshot.invocation.id);
    const admitted = await input.admission.admit({
      sessionId: snapshot.sessionId,
      invocation: snapshot.invocation,
      call: execution.call,
      environment: execution.environment,
      securityContext: execution.securityContext,
      storedApprovalKey,
    });

    if (admitted.kind === "DENY") {
      const failure = feedbackToDurableFailure(admitted.feedback);
      return await settleDurableFailure({
        snapshot,
        code: failure.code,
        phase: failure.phase,
        message: failure.message,
        content: admitted.feedback.content,
        // Same boundary as above: the feedback speaks the AI JSON model, the failure settlement the
        // Protocol one.
        details: admitted.feedback.details as unknown as JsonObject,
      });
    }

    if (admitted.kind === "WAITING_APPROVAL") {
      if (
        admitted.storedApprovalKey !== undefined &&
        admitted.storedApprovalKey !== admitted.approvalKey
      ) {
        // The stored identity was readable and it is *not* the identity this call would be admitted
        // under today. Executing would run a Tool under a grant that is about a different decision, so
        // the call fails closed — at the RECOVERY/ADMISSION invariant boundary, before any budget side
        // effect and without running the Tool.
        throw new ToolExecutionInfrastructureError(
          "RECOVERY",
          "Approval identity does not match the Tool call.",
        );
      }
      // `storedApprovalKey === undefined` means the host's approval lookup cannot answer "what identity
      // was this created under". That is a comparison this layer cannot make, not evidence of a
      // mismatch: the durable approval still had to be resolved APPROVED with a granted scope for
      // recovery to reach this point, and the identity was computed by the same admission adapter that
      // computed it at creation time.
      if (approval.grantedScope === undefined) {
        throw new ToolExecutionInfrastructureError(
          "RECOVERY",
          "Approved ApprovalRequest has no granted scope.",
        );
      }
    }

    if (admitted.kind === "BUDGET_EXCEEDED") {
      const committed = await input.failureSettlement.settleFailure({
        snapshot,
        code: "BUDGET_EXCEEDED",
        phase: "INTERNAL",
        message: "Tool execution returned an error result.",
        content: boundFailureContent(BUDGET_CONTENT),
        now: input.clock.now(),
      });
      return Object.freeze({
        kind: "BUDGET_EXCEEDED",
        invocation: committed.snapshot.invocation,
        block: admitted.block,
      });
    }

    return await startAndExecute(execution, snapshot);
  }

  async function recoverSnapshot(
    snapshot: ToolExecutionSnapshot,
    restore: {
      readonly environment: ToolExecutionEnvironment;
      readonly securityContext: ToolSecurityContext;
      readonly signal: AbortSignal;
    },
  ): Promise<DurableToolExecutionOutcome> {
    const invocation = snapshot.invocation;
    const externalCallId = invocation.externalCallId;
    if (externalCallId === undefined) {
      throw new ToolExecutionInfrastructureError(
        "RECOVERY",
        "Tool invocation has no external call identity.",
      );
    }
    const execution: ExecutionInput = {
      sessionId: snapshot.sessionId,
      runId: invocation.runId,
      sourceStepId: invocation.stepId,
      call: input.preparedCallFactory({ invocation, externalCallId }),
      environment: restore.environment,
      securityContext: restore.securityContext,
      signal: restore.signal,
    };

    if (invocation.status === "REQUESTED") {
      // Nothing has started, so re-entering admission is safe: policy, approval and budget are all
      // re-evaluated against current durable state.
      return await admitAndProceed(execution, snapshot);
    }
    if (invocation.status === "WAITING_APPROVAL") {
      return await recoverWaitingApproval(execution, snapshot);
    }
    if (invocation.status === "RUNNING") {
      // The side-effect boundary was crossed and the process did not come back. Nothing here may
      // invoke the executor: an interrupted Tool may have partially or fully run, so the only safe
      // statement is an uncertain one, and the executor call count for this path is zero.
      return await settleDurableFailure({
        snapshot,
        code: "TOOL_EXECUTION_ERROR",
        phase: "TOOL",
        message: "Tool execution returned an error result.",
        content: INTERRUPTED_CONTENT,
        errorDetails: { executionDisposition: "UNCERTAIN_SIDE_EFFECT" },
      });
    }
    if (invocation.status === "CANCELLED") {
      // A host already durably cancelled this invocation. This round adds no transition into
      // CANCELLED; it only refuses to execute one that is already there.
      return Object.freeze({
        kind: "CANCELLED",
        invocation,
        ...(snapshot.observation === undefined ? {} : { observation: snapshot.observation }),
      });
    }
    // Terminal: the durable answer already exists and is returned, never recomputed.
    if (snapshot.observation === undefined) {
      throw new ToolExecutionInfrastructureError(
        "RECOVERY",
        "Terminal ToolInvocation has no observation.",
      );
    }
    return Object.freeze({
      kind: "SETTLED",
      invocation,
      observation: snapshot.observation,
    });
  }

  return {
    async execute(request: DurableToolExecutionRequest): Promise<DurableToolExecutionOutcome> {
      const externalCallId = request.call.request.externalCallId;
      if (externalCallId.length === 0) {
        throw new ToolExecutionInfrastructureError(
          "PREPARATION",
          "Tool execution requires a non-empty external call identity.",
        );
      }
      throwIfAborted(request.signal);
      if (request.call.resolved === undefined) {
        throw new ToolExecutionInfrastructureError(
          "PREPARATION",
          "Tool execution requires a resolved Tool.",
        );
      }

      const key = callKey(request.runId, request.sourceStepId, externalCallId);
      assertCallIsNotActive(activeCalls, key, request.runId);
      activeCalls.add(key);
      try {
        const existing = await input.store.findByExternalCall(
          request.runId,
          request.sourceStepId,
          externalCallId,
        );
        if (existing !== null) {
          assertSameCall(request, existing.invocation);
          return await recoverSnapshot(existing, {
            environment: request.environment,
            securityContext: request.securityContext,
            signal: request.signal,
          });
        }

        const metadata = await input.metadata.get(request.call.resolved.tool.name);
        const createdAt = input.clock.now();
        const invocation = createRequestedToolInvocation({
          id: input.invocationIdFactory.create(),
          runId: request.runId,
          stepId: request.sourceStepId,
          toolName: request.call.resolved.tool.name,
          externalCallId,
          args: request.call.args as unknown as JsonObject,
          riskLevel: metadata.riskLevel,
          createdAt,
        });
        // The requested event is built from the invocation as it will be persisted, and committed with
        // it. Admission has not run yet: its side effects must never precede this durable row.
        const requested = await commitAndNotify({
          sessionId: request.sessionId,
          invocation,
          expectedRevision: null,
          events: [
            createToolRequestedEvent({
              eventId: input.eventIdFactory.create(),
              sessionId: request.sessionId,
              timestamp: createdAt,
              invocation,
              ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
            }),
          ],
        });
        return await admitAndProceed(
          {
            sessionId: request.sessionId,
            runId: request.runId,
            sourceStepId: request.sourceStepId,
            call: request.call,
            environment: request.environment,
            securityContext: request.securityContext,
            signal: request.signal,
          },
          requested.snapshot,
        );
      } finally {
        activeCalls.delete(key);
      }
    },

    async recover(
      snapshot: ToolExecutionSnapshot,
      restore: {
        readonly environment: ToolExecutionEnvironment;
        readonly securityContext: ToolSecurityContext;
        readonly signal: AbortSignal;
      },
    ): Promise<DurableToolExecutionOutcome> {
      throwIfAborted(restore.signal);
      if (isTerminalToolInvocation(snapshot.invocation) && snapshot.observation === undefined) {
        if (snapshot.invocation.status !== "CANCELLED") {
          throw new ToolExecutionInfrastructureError(
            "RECOVERY",
            "Terminal ToolInvocation has no observation.",
          );
        }
      }
      const externalCallId = snapshot.invocation.externalCallId;
      const key =
        externalCallId === undefined
          ? undefined
          : callKey(snapshot.invocation.runId, snapshot.invocation.stepId, externalCallId);
      if (key === undefined) return await recoverSnapshot(snapshot, restore);
      assertCallIsNotActive(activeCalls, key, snapshot.invocation.runId);
      activeCalls.add(key);
      try {
        return await recoverSnapshot(snapshot, restore);
      } finally {
        activeCalls.delete(key);
      }
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

async function startBudget(
  options: DurableToolExecutionCoordinatorOptions,
  runId: RunId,
  invocationId: ToolInvocationId,
  startedAt: TimestampMs,
): Promise<void> {
  if (options.budget === undefined) return;
  try {
    await options.budget.start({ runId, invocationId, startedAt });
  } catch (error) {
    throw new ToolExecutionInfrastructureError("ADMISSION", "Tool budget start failed.", {
      cause: error,
    });
  }
}

/**
 * The identity a stored approval for this invocation was created under.
 *
 * Recovery asks for it so the comparison against the recomputed identity is made from durable data
 * rather than from an in-memory value: an approval that was resolved for a different decision is
 * exactly the case a restart must catch.
 */
/**
 * The durable approval for one invocation.
 *
 * A lookup failure is an infrastructure failure, never "no approval": a recovery that could not read the
 * approval must not conclude that none exists, because the only outcome of that conclusion is either a
 * fabricated wait or an execution nobody authorised.
 */
async function loadApproval(
  options: DurableToolExecutionCoordinatorOptions,
  toolInvocationId: ToolInvocationId,
): Promise<ApprovalRequest | null> {
  try {
    return await options.approvalLookup!.getByInvocation(toolInvocationId);
  } catch (error) {
    throw new ToolExecutionInfrastructureError(
      "RECOVERY",
      "The durable ApprovalRequest for this Tool call could not be read.",
      { cause: error },
    );
  }
}

async function lookupStoredApprovalKey(
  options: DurableToolExecutionCoordinatorOptions,
  toolInvocationId: ToolInvocationId,
): Promise<string | null | undefined> {
  const approvals = options.approvalLookup;
  if (approvals === undefined) return undefined;
  try {
    return await approvals.getStoredApprovalKey(toolInvocationId);
  } catch (error) {
    throw new ToolExecutionInfrastructureError(
      "RECOVERY",
      "Stored approval identity could not be read.",
      { cause: error },
    );
  }
}

async function archiveRawResult(
  options: DurableToolExecutionCoordinatorOptions,
  invocation: ToolInvocation,
  rawResult: AgentToolResult,
): Promise<string | undefined> {
  if (options.rawOutputStore === undefined) return undefined;
  try {
    const artifact = await options.rawOutputStore.createOrGet({
      artifactId: `tool-output:${invocation.id}`,
      runId: invocation.runId,
      kind: "TOOL_OUTPUT",
      sourceRef: invocation.id,
      content: rawResult.content,
      mimeType: "text/plain; charset=utf-8",
      sensitivity: "INTERNAL",
      createdSequence: 0,
      createdAt: options.clock.now(),
    });
    return artifact.artifactId;
  } catch (error) {
    // The archive happens after the Tool may already have had its side effect. Recording COMPLETED
    // without it would leave durable state that cannot be reconciled with the workspace, so the
    // invocation stays RUNNING for uncertain recovery instead.
    throw new ToolExecutionInfrastructureError("SETTLEMENT", "Tool raw output archive failed.", {
      cause: error,
    });
  }
}

function assertCallIsNotActive(activeCalls: Set<string>, key: string, runId: RunId): void {
  if (activeCalls.has(key)) throw new ToolCallBusyError(runId);
}

/**
 * The same call is already in flight in this process.
 *
 * This is a **race guard, not a correctness mechanism**. Correctness comes from the durable idempotency
 * lookup, the revision check and the store's conflict on a duplicate external call. The active set only
 * stops two concurrent in-process callers from both reaching the store for the same identity, where one
 * would win and the other would have to unwind anyway.
 */
export class ToolCallBusyError extends Error {
  readonly runId: RunId;

  constructor(runId: RunId) {
    super("Tool execution for this Run is already in progress.");
    this.name = "ToolCallBusyError";
    this.runId = runId;
  }
}

function assertSameCall(request: DurableToolExecutionRequest, invocation: ToolInvocation): void {
  if (
    invocation.toolName !== request.call.resolved.tool.name ||
    canonicalJsonString(invocation.args) !==
      canonicalJsonString(request.call.args as unknown as JsonObject)
  ) {
    throw new ToolExecutionConflictError(
      "Tool call identity conflicts with existing durable data.",
    );
  }
}

function callKey(runId: RunId, stepId: StepId, externalCallId: string): string {
  return `${runId}:${stepId}:${externalCallId}`;
}

/**
 * The invocation-bound raw artifact reference.
 *
 * It exists because two frozen signatures cannot carry it: `ToolSettlementCoordinator.settle` takes a
 * snapshot, a settlement and a timestamp, and `DurableToolExecutionRequest` takes identity, a call, an
 * environment, a security context and a signal. Adding a fourth or eighth field for a host archive
 * locator would widen a public contract for an implementation need, so the reference is bound through
 * the implementation instead.
 */
interface RawArtifactBinding {
  set(reference: string | undefined): void;
  resolve(): Promise<string | undefined>;
  clear(): void;
}

function createRawArtifactBinding(): RawArtifactBinding {
  let reference: string | undefined;
  return {
    set(value: string | undefined): void {
      reference = value;
    },
    async resolve(): Promise<string | undefined> {
      return reference;
    },
    clear(): void {
      reference = undefined;
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolExecutionAbortedError();
}

/** A Tool call was cancelled before its durable boundary was crossed. */
export class ToolExecutionAbortedError extends Error {
  constructor() {
    super("Tool execution was cancelled.");
    this.name = "ToolExecutionAbortedError";
  }
}

/** Re-exported so a legacy facade can keep naming a denial without importing the admission module. */
export { DENIED_CONTENT as TOOL_DENIED_CONTENT };
