import type {
  AdvanceAgentDirective,
  EvaluateCompletionDirective,
  ExecuteToolBatchDirective,
  FinalizeDirective,
  ReturnTerminalDirective,
  RunExecutionContinuationKind,
  RunExecutionDirective,
  RunExecutionFacts,
  RunExecutionStatus,
} from "@caelush/agent";
import type { AgentRun, RunStatus } from "@caelush/protocol";
import type { RunContinuationCheckpoint } from "./agent-continuation.js";
import type { RunExecutionSnapshot } from "./run-execution-store.js";

/**
 * The transition from a durable snapshot to the coordinator's routing facts.
 *
 * Phase 3C split one decision into two inputs:
 *
 * ```text
 * RunExecutionSnapshot   the durable row: AgentRun, AgentState, continuation payload, revisions
 * RunExecutionFacts      the routing discriminants, and nothing else
 * ```
 *
 * This projection is the only place the two meet. Keeping it here — rather than letting the
 * coordinator see a snapshot — is what makes the decision testable without a database, and what
 * stops a timestamp, a token counter or a message array from quietly becoming a routing input.
 */

/** Every Run status the frozen coordinator routes on. */
const EXECUTION_STATUSES: readonly RunExecutionStatus[] = [
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_RESOURCE",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
];

/**
 * Project a durable Run status onto the frozen execution status.
 *
 * The two vocabularies are the same closed set today, and the projection asserts that instead of
 * casting it: a status the coordinator cannot route must fail loudly at the boundary rather than
 * become `undefined` and be treated as a boundary to guess at.
 */
export function toExecutionStatus(status: RunStatus): RunExecutionStatus {
  const match = EXECUTION_STATUSES.find((candidate) => candidate === status);
  if (match === undefined) {
    throw new Error(`Run status "${status}" is not a frozen execution status.`);
  }
  return match;
}

/** Every continuation the frozen coordinator routes on. */
const EXECUTION_CONTINUATIONS: readonly RunExecutionContinuationKind[] = [
  "WAITING_TOOL_RESULTS",
  "WAITING_RETRY",
  "WAITING_VERIFICATION_REPAIR",
  "WAITING_RESOURCE",
  "AWAITING_VERIFICATION",
];

/**
 * Project a durable continuation onto its frozen discriminant.
 *
 * A continuation type with no frozen discriminant would be a routing gap, so it fails loudly here
 * rather than becoming `undefined` and being read as "this Run has no boundary".
 */
export function toContinuationKind(
  continuation: RunContinuationCheckpoint | undefined,
): RunExecutionContinuationKind | undefined {
  if (continuation === undefined) return undefined;
  const kind = EXECUTION_CONTINUATIONS.find((candidate) => candidate === continuation.type);
  if (kind === undefined) {
    throw new Error(`Run continuation "${continuation.type}" is not routable.`);
  }
  return kind;
}

/**
 * Everything the coordinator is allowed to know about one durable Run.
 *
 * The optional fields are omitted rather than set to `undefined`, because the coordinator
 * distinguishes "this composition has no Tool batch authority" from "the Tool batch is idle".
 */
export function toRunExecutionFacts(input: {
  readonly snapshot: RunExecutionSnapshot;
  readonly now: number;
  readonly toolBatchAvailable: boolean;
  readonly completionAvailable: boolean;
  readonly aborted: boolean;
  readonly abortCause?: "USER_REQUESTED" | "DEADLINE_EXCEEDED";
  readonly deadlineExceeded: boolean;
}): RunExecutionFacts {
  const { snapshot } = input;
  const continuation = snapshot.continuation;
  const kind = toContinuationKind(continuation);
  return {
    runId: snapshot.run.id,
    status: toExecutionStatus(snapshot.run.status),
    ...(kind === undefined ? {} : { continuation: kind }),
    ...(continuation?.type === "WAITING_TOOL_RESULTS" && continuation.waitingApproval !== undefined
      ? { awaitingApproval: true }
      : {}),
    ...(continuation?.type === "WAITING_TOOL_RESULTS" && continuation.receivedResults !== undefined
      ? { toolResultsAccepted: true }
      : {}),
    ...(snapshot.activeStep === undefined ? {} : { activeStep: true }),
    ...(snapshot.state === undefined ? {} : { stepsCompleted: snapshot.state.usage.steps }),
    maxSteps: snapshot.run.limits.maxSteps,
    ...(snapshot.cancellationIntent === undefined ? {} : { cancellationRequested: true }),
    ...(input.aborted ? { aborted: true } : {}),
    ...(input.abortCause === undefined ? {} : { abortCause: input.abortCause }),
    ...(input.deadlineExceeded ? { deadlineExceeded: true } : {}),
    ...(continuation?.type === "WAITING_RETRY"
      ? {
          retryNextAttemptAt: continuation.nextAttemptAt,
          retryResumesToolResults: continuation.mode === "TOOL_RESULTS",
        }
      : {}),
    toolBatchAvailable: input.toolBatchAvailable,
    completionAvailable: input.completionAvailable,
  };
}

/* ------------------------------------------------------- directive handling */

/**
 * Project the frozen Run failure code onto the durable Protocol error code.
 *
 * The frozen vocabulary is the smaller one: it names the failure classes the Run Layer actually
 * settles on, while the Protocol set is the durable contract that already exists. The mapping is
 * explicit so a new frozen code cannot silently become `INTERNAL_ERROR`.
 */
export function toProtocolErrorCode(
  code: import("@caelush/agent").RunExecutionErrorCode,
): import("@caelush/protocol").AgentErrorCode {
  switch (code) {
    case "MODEL_ERROR":
      return "MODEL_ERROR";
    case "TOOL_OUTPUT_ERROR":
      return "TOOL_OUTPUT_ERROR";
    case "RUNTIME_ERROR":
      return "RUNTIME_ERROR";
    case "PERMISSION_DENIED":
      return "PERMISSION_DENIED";
    case "APPROVAL_REJECTED":
      return "APPROVAL_REJECTED";
    case "VERIFICATION_FAILED":
      return "VERIFICATION_FAILED";
    case "CONTEXT_EXHAUSTED":
      return "CONTEXT_EXHAUSTED";
    case "BUDGET_ENFORCEMENT_UNAVAILABLE":
      return "BUDGET_ENFORCEMENT_UNAVAILABLE";
    case "INTERNAL_ERROR":
      return "INTERNAL_ERROR";
  }
}

/** Project the frozen budget block onto the durable one the Run Layer settles with. */
export function toLegacyBudgetBlock(
  block: import("@caelush/agent").RunExecutionBudgetBlock,
): import("./agent-errors.js").AgentBudgetBlock {
  if (block.kind === "UNAVAILABLE") {
    return { kind: "UNAVAILABLE", reason: block.reason ?? "TOKEN_ESTIMATE" };
  }
  return {
    kind: "EXCEEDED",
    dimension: block.dimension ?? "TOKENS",
    accounted: block.accounted ?? 0,
    limit: block.limit ?? 0,
    ...(block.limitMicros === undefined ? {} : { limitMicros: block.limitMicros }),
    ...(block.accountedMicros === undefined ? {} : { accountedMicros: block.accountedMicros }),
  };
}

/**
 * The five directive kinds a Run execution can act on.
 *
 * `RETURN_TERMINAL` is answered with a *reason* rather than an action, so the Run Layer can tell a
 * normal settled Run from a state it must not guess at. `UNAVAILABLE_BOUNDARY` and the other
 * "unavailable" reasons are lifecycle violations, not results: a Run that cannot be routed is a
 * composition error, and reporting it as a successful boundary would hide it.
 */
export type RunExecutionDirectiveAction =
  | { readonly action: "ADVANCE_AGENT"; readonly directive: AdvanceAgentDirective }
  | { readonly action: "EXECUTE_TOOL_BATCH"; readonly directive: ExecuteToolBatchDirective }
  | { readonly action: "EVALUATE_COMPLETION"; readonly directive: EvaluateCompletionDirective }
  | {
      readonly action: "SUSPEND";
      readonly directive: Extract<RunExecutionDirective, { kind: "SUSPEND" }>;
    }
  | { readonly action: "FINALIZE"; readonly directive: FinalizeDirective }
  | { readonly action: "RETURN_TERMINAL"; readonly directive: ReturnTerminalDirective };

/** Classify one directive for the Run Layer. */
export function toDirectiveAction(directive: RunExecutionDirective): RunExecutionDirectiveAction {
  switch (directive.kind) {
    case "ADVANCE_AGENT":
      return { action: "ADVANCE_AGENT", directive };
    case "EXECUTE_TOOL_BATCH":
      return { action: "EXECUTE_TOOL_BATCH", directive };
    case "EVALUATE_COMPLETION":
      return { action: "EVALUATE_COMPLETION", directive };
    case "SUSPEND":
      return { action: "SUSPEND", directive };
    case "FINALIZE":
      return { action: "FINALIZE", directive };
    case "RETURN_TERMINAL":
      return { action: "RETURN_TERMINAL", directive };
  }
}

/** Re-exported so the Run Layer names the same statuses the coordinator routes on. */
export type { AgentRun, RunExecutionStatus };
