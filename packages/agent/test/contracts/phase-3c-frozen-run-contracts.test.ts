import { describe, expect, it } from "vitest";
import type {
  AgentLoopAdvanceResult,
  AgentTurnInput,
  CompletionGate,
  CompletionGateDecision,
  EvaluateCompletionDirective,
  ExecuteToolBatchDirective,
  AdvanceAgentDirective,
  FinalizeDirective,
  ReturnTerminalDirective,
  RunExecutionCoordinator,
  RunExecutionDirective,
  RunExecutionEffectResult,
  RunExecutionMode,
  RunExecutionSnapshot,
  RunExecutionStorePort,
  RunTransitionPlanInput,
  RunTransitionPlanner,
  SuspendDirective,
  ToolTurnCoordinator,
  ToolTurnResult,
} from "@caelush/agent";
import type { AgentDecision, AgentLoop } from "@caelush/agent";
import type { StepId, TimestampMs } from "@caelush/protocol";

/**
 * Phase 3C frozen Run contracts, asserted at compile time.
 *
 * The 3A and 3B exactness files cover the kernel and the context boundary. This one covers the
 * durable Run driver, and it is written from the interface freeze rather than from the
 * implementation: a restatement copied out of `src` would agree with any drift by construction.
 *
 * `pnpm typecheck` fails on any assertion below. Nothing here is a runtime behaviour test.
 */

/* ------------------------------------------------------------- helpers */

/** Structural equality that also distinguishes optional, readonly and `any`. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type Expect<T extends true> = T;
type Keys<T> = keyof T;

/* ------------------------------------------------------- frozen restatements */

type FrozenRunExecutionMode = "EXECUTE" | "RECOVER";

type FrozenRunExecutionDirective =
  | {
      readonly kind: "ADVANCE_AGENT";
      readonly mode: FrozenRunExecutionMode;
      readonly reason: "INITIAL" | "TOOL_RESULTS" | "RETRY" | "COMPLETION_REPAIR" | "STEERING";
      readonly input: AgentTurnInput;
    }
  | {
      readonly kind: "EXECUTE_TOOL_BATCH";
      readonly mode: FrozenRunExecutionMode;
      readonly sourceStepId: StepId;
      readonly pendingDecision: import("@caelush/agent").AgentToolCallsDecision;
      // | undefined is what a decoder produces under xactOptionalPropertyTypes: the field may be absent, and a present-but-undefined value must round-trip rather than be rejected.
      readonly observationPolicy?:
        import("@caelush/agent").ToolObservationPolicySnapshot | undefined;
    }
  | {
      readonly kind: "EVALUATE_COMPLETION";
      readonly mode: FrozenRunExecutionMode;
      readonly sourceStepId: StepId;
      readonly candidate: import("@caelush/agent").AgentFinalCandidateDecision;
    }
  | {
      readonly kind: "SUSPEND";
      readonly boundary: "APPROVAL" | "RESOURCE" | "RETRY";
      // Only a RETRY suspension carries one, and a decoded value may be explicitly undefined.
      readonly resumeAt?: TimestampMs | undefined;
    }
  | {
      readonly kind: "FINALIZE";
      readonly reason: "CANCELLED" | "TIMEOUT" | "MAX_STEPS_REACHED";
    }
  | {
      readonly kind: "RETURN_TERMINAL";
    };

type FrozenRunExecutionEffectResult =
  | { readonly kind: "AGENT"; readonly result: AgentLoopAdvanceResult }
  | { readonly kind: "TOOLS"; readonly result: ToolTurnResult }
  | { readonly kind: "COMPLETION"; readonly result: CompletionGateDecision }
  | { readonly kind: "NONE" };

type FrozenToolTurnResult =
  | {
      readonly kind: "COMPLETED";
      readonly results: readonly import("@caelush/agent").AgentToolResult[];
    }
  | {
      readonly kind: "WAITING_APPROVAL";
      readonly completedResults: readonly import("@caelush/agent").AgentToolResult[];
      readonly waiting: import("@caelush/agent").WaitingApprovalBoundary;
    }
  | {
      readonly kind: "BUDGET_EXCEEDED";
      readonly completedResults: readonly import("@caelush/agent").AgentToolResult[];
      readonly block: import("@caelush/agent").AgentBudgetBlock;
    }
  | { readonly kind: "RESOURCE_WAIT"; readonly reason: "NO_PROGRESS" }
  | {
      readonly kind: "REPLAN";
      readonly syntheticResults: readonly import("@caelush/agent").AgentToolResult[];
    };

type FrozenCompletionGateDecision =
  | { readonly outcome: "ACCEPT" }
  | { readonly outcome: "REPAIR"; readonly repairRef: string; readonly cycle: number }
  | { readonly outcome: "REJECT"; readonly reason: string }
  | { readonly outcome: "ERROR"; readonly error: import("@caelush/protocol").AgentError };

interface FrozenRunExecutionDriverDependencies {
  readonly agentLoop: AgentLoop;
  readonly toolTurns: ToolTurnCoordinator;
  readonly completionGate: CompletionGate;
}

interface FrozenRunExecutionDriver {
  execute(
    directive: RunExecutionDirective,
    context: import("@caelush/agent").RunExecutionEffectContext,
  ): Promise<RunExecutionEffectResult>;
}

interface FrozenRunTransitionPlanInput {
  readonly snapshot: RunExecutionSnapshot;
  readonly directive: RunExecutionDirective;
  readonly effect: RunExecutionEffectResult;
  readonly now: TimestampMs;
}

interface FrozenRunTransitionPlanner {
  plan(input: RunTransitionPlanInput): import("@caelush/agent").RunExecutionCommit;
}

interface FrozenRunExecutionCoordinator {
  next(snapshot: RunExecutionSnapshot, now: TimestampMs): RunExecutionDirective;
}

/* ------------------------------------------------------------- assertions */

/* Mode: exactly two values. START / TOOLS / REPAIR must never be modes again. */
type ModeExact = Expect<Equal<RunExecutionMode, FrozenRunExecutionMode>>;
type ModeRejectsStart = Expect<Equal<Extract<RunExecutionMode, "START">, never>>;
type ModeRejectsTools = Expect<Equal<Extract<RunExecutionMode, "TOOLS">, never>>;
type ModeRejectsRepair = Expect<Equal<Extract<RunExecutionMode, "REPAIR">, never>>;
type ModeRejectsEvaluate = Expect<Equal<Extract<RunExecutionMode, "EVALUATE">, never>>;

/* The directive union: six discriminants, and nothing else. */
type DirectiveExact = Expect<Equal<RunExecutionDirective, FrozenRunExecutionDirective>>;
type DirectiveKinds = Expect<
  Equal<
    RunExecutionDirective["kind"],
    | "ADVANCE_AGENT"
    | "EXECUTE_TOOL_BATCH"
    | "EVALUATE_COMPLETION"
    | "SUSPEND"
    | "FINALIZE"
    | "RETURN_TERMINAL"
  >
>;

/* Every variant carries its own execution payload. */
type AdvanceExact = Expect<
  Equal<AdvanceAgentDirective, Extract<FrozenRunExecutionDirective, { kind: "ADVANCE_AGENT" }>>
>;
type AdvanceKeys = Expect<Equal<Keys<AdvanceAgentDirective>, "kind" | "mode" | "reason" | "input">>;
type ToolBatchExact = Expect<
  Equal<
    ExecuteToolBatchDirective,
    Extract<FrozenRunExecutionDirective, { kind: "EXECUTE_TOOL_BATCH" }>
  >
>;
type ToolBatchKeys = Expect<
  Equal<
    Keys<ExecuteToolBatchDirective>,
    "kind" | "mode" | "sourceStepId" | "pendingDecision" | "observationPolicy"
  >
>;
type CompletionDirectiveExact = Expect<
  Equal<
    EvaluateCompletionDirective,
    Extract<FrozenRunExecutionDirective, { kind: "EVALUATE_COMPLETION" }>
  >
>;
type CompletionDirectiveKeys = Expect<
  Equal<Keys<EvaluateCompletionDirective>, "kind" | "mode" | "sourceStepId" | "candidate">
>;
type SuspendExact = Expect<
  Equal<SuspendDirective, Extract<FrozenRunExecutionDirective, { kind: "SUSPEND" }>>
>;
type SuspendKeys = Expect<Equal<Keys<SuspendDirective>, "kind" | "boundary" | "resumeAt">>;
type SuspendBoundaries = Expect<
  Equal<SuspendDirective["boundary"], "APPROVAL" | "RESOURCE" | "RETRY">
>;
type FinalizeExact = Expect<
  Equal<FinalizeDirective, Extract<FrozenRunExecutionDirective, { kind: "FINALIZE" }>>
>;
type FinalizeKeys = Expect<Equal<Keys<FinalizeDirective>, "kind" | "reason">>;
type FinalizeReasons = Expect<
  Equal<FinalizeDirective["reason"], "CANCELLED" | "TIMEOUT" | "MAX_STEPS_REACHED">
>;
/* `FAILED` and `BUDGET_EXCEEDED` are effect outcomes, never next actions. */
type FinalizeRejectsFailed = Expect<Equal<Extract<FinalizeDirective["reason"], "FAILED">, never>>;
type FinalizeRejectsBudget = Expect<
  Equal<Extract<FinalizeDirective["reason"], "BUDGET_EXCEEDED">, never>
>;
/* A terminal report says nothing beyond "the Run is settled". */
type ReturnTerminalExact = Expect<
  Equal<ReturnTerminalDirective, Extract<FrozenRunExecutionDirective, { kind: "RETURN_TERMINAL" }>>
>;
type ReturnTerminalKeys = Expect<Equal<Keys<ReturnTerminalDirective>, "kind">>;
type ReturnTerminalHasNoStatus = Expect<
  Equal<Extract<Keys<ReturnTerminalDirective>, "status">, never>
>;
type ReturnTerminalHasNoReason = Expect<
  Equal<Extract<Keys<ReturnTerminalDirective>, "reason">, never>
>;

/* The coordinator takes the durable snapshot, not a parallel fact type. */
type CoordinatorExact = Expect<Equal<RunExecutionCoordinator, FrozenRunExecutionCoordinator>>;

/* The effect result wraps the canonical subsystem types and adds nothing. */
type EffectResultExact = Expect<Equal<RunExecutionEffectResult, FrozenRunExecutionEffectResult>>;
type EffectKinds = Expect<
  Equal<RunExecutionEffectResult["kind"], "AGENT" | "TOOLS" | "COMPLETION" | "NONE">
>;
type AgentEffectExact = Expect<
  Equal<Extract<RunExecutionEffectResult, { kind: "AGENT" }>["result"], AgentLoopAdvanceResult>
>;
type ToolsEffectExact = Expect<
  Equal<Extract<RunExecutionEffectResult, { kind: "TOOLS" }>["result"], ToolTurnResult>
>;
type CompletionEffectExact = Expect<
  Equal<Extract<RunExecutionEffectResult, { kind: "COMPLETION" }>["result"], CompletionGateDecision>
>;
/** `NONE` is exactly `{ kind: "NONE" }` — no reason, no summary, no status. */
type NoneEffectKeys = Expect<
  Equal<Keys<Extract<RunExecutionEffectResult, { kind: "NONE" }>>, "kind">
>;

/* The Tool turn and completion gate contracts. */
type ToolTurnExact = Expect<Equal<ToolTurnResult, FrozenToolTurnResult>>;
type ToolTurnKinds = Expect<
  Equal<
    ToolTurnResult["kind"],
    "COMPLETED" | "WAITING_APPROVAL" | "BUDGET_EXCEEDED" | "RESOURCE_WAIT" | "REPLAN"
  >
>;
type CompletionDecisionExact = Expect<Equal<CompletionGateDecision, FrozenCompletionGateDecision>>;
type CompletionOutcomes = Expect<
  Equal<CompletionGateDecision["outcome"], "ACCEPT" | "REPAIR" | "REJECT" | "ERROR">
>;
type CompletionGateExact = Expect<
  Equal<
    CompletionGate,
    {
      evaluate(
        request: import("@caelush/agent").CompletionGateRequest,
      ): Promise<CompletionGateDecision>;
    }
  >
>;
type ToolTurnCoordinatorExact = Expect<
  Equal<
    ToolTurnCoordinator,
    { execute(request: import("@caelush/agent").ToolTurnRequest): Promise<ToolTurnResult> }
  >
>;

/* The driver: three required ports, one effect per call. */
type DriverDependenciesExact = Expect<
  Equal<
    import("@caelush/agent").RunExecutionDriverDependencies,
    FrozenRunExecutionDriverDependencies
  >
>;
type DriverDependenciesKeys = Expect<
  Equal<
    Keys<import("@caelush/agent").RunExecutionDriverDependencies>,
    "agentLoop" | "toolTurns" | "completionGate"
  >
>;
type DriverExact = Expect<
  Equal<import("@caelush/agent").RunExecutionDriver, FrozenRunExecutionDriver>
>;

/* The planner: frozen input, and a canonical commit as its answer. */
type PlanInputExact = Expect<Equal<RunTransitionPlanInput, FrozenRunTransitionPlanInput>>;
type PlanInputKeys = Expect<
  Equal<Keys<RunTransitionPlanInput>, "snapshot" | "directive" | "effect" | "now">
>;
type PlannerExact = Expect<Equal<RunTransitionPlanner, FrozenRunTransitionPlanner>>;
/** The draft is gone: the planner answers with a commit, not a declarative sketch. */
type PlannerReturnsCommit = Expect<
  Equal<ReturnType<RunTransitionPlanner["plan"]>, import("@caelush/agent").RunExecutionCommit>
>;

/* The store port ownership surface. */
type StorePortExact = Expect<
  Equal<
    RunExecutionStorePort,
    {
      load(runId: import("@caelush/protocol").RunId): Promise<RunExecutionSnapshot | null>;
      commit(
        command: import("@caelush/agent").RunExecutionCommit,
      ): Promise<import("@caelush/agent").RunExecutionCommitResult>;
      requestCancellation(
        runId: import("@caelush/protocol").RunId,
        intent: import("@caelush/protocol").RunCancellationIntent,
      ): Promise<RunExecutionSnapshot>;
    }
  >
>;
type StorePortKeys = Expect<
  Equal<Keys<RunExecutionStorePort>, "load" | "commit" | "requestCancellation">
>;
/** The general port carries no coding-verification concern. */
type StorePortHasNoVerification = Expect<
  Equal<Extract<Keys<RunExecutionStorePort>, "commitVerifiedCompletion">, never>
>;
type SnapshotKeys = Expect<
  Equal<
    Keys<RunExecutionSnapshot>,
    | "run"
    | "state"
    | "stateRevision"
    | "activeStep"
    | "conversation"
    | "continuation"
    | "continuationRevision"
    | "cancellationIntent"
  >
>;
type SnapshotHasNoVerificationPlan = Expect<
  Equal<Extract<Keys<RunExecutionSnapshot>, "verificationPlan">, never>
>;
/** The canonical conversation speaks the frozen AI message contract, not a legacy encoding. */
type ConversationMessageIsAIMessage = Expect<
  Equal<RunExecutionSnapshot["conversation"][number]["message"], import("@caelush/ai").AIMessage>
>;

/* The continuation domain is agent-owned and ordinal-stable. */
type ContinuationTypes = Expect<
  Equal<
    import("@caelush/agent").RunContinuationCheckpoint["type"],
    | "WAITING_TOOL_RESULTS"
    | "AWAITING_VERIFICATION"
    | "WAITING_VERIFICATION_REPAIR"
    | "WAITING_RESOURCE"
    | "WAITING_RETRY"
  >
>;
type ToolContinuationHasPolicy = Expect<
  Equal<
    import("@caelush/agent").WaitingToolResultsContinuation["observationPolicy"],
    import("@caelush/agent").ToolObservationPolicySnapshot | undefined
  >
>;
type ToolContinuationResultsAreAI = Expect<
  Equal<
    NonNullable<import("@caelush/agent").WaitingToolResultsContinuation["receivedResults"]>[number],
    import("@caelush/ai").AIToolResultMessage
  >
>;

/* Decisions are the frozen kernel's, not a Run-Layer restatement. */
type DecisionIsFrozen = Expect<Equal<AdvanceAgentDirective["input"], AgentTurnInput>>;
type RunDecisionIsFrozen = Expect<
  Equal<
    ExecuteToolBatchDirective["pendingDecision"],
    import("@caelush/agent").AgentToolCallsDecision
  >
>;
type CompletionCandidateIsFrozen = Expect<
  Equal<
    EvaluateCompletionDirective["candidate"],
    import("@caelush/agent").AgentFinalCandidateDecision
  >
>;
type AgentDecisionUnchanged = Expect<
  Equal<AgentDecision["type"], "TOOL_CALLS_REQUESTED" | "FINAL_CANDIDATE">
>;

/**
 * The compile-time assertions are erased at runtime; this keeps the file a real test so a deleted
 * file is a failure rather than silence.
 */
describe("Phase 3C frozen run contracts", () => {
  it("compiles every frozen Run assertion", () => {
    expect(FROZEN_RUN_CONTRACT_MARKERS.length).toBeGreaterThan(0);
  });
});

/** One marker per asserted contract, kept in sync with the assertions above. */
export const FROZEN_RUN_CONTRACT_MARKERS = [
  "RunExecutionMode",
  "RunExecutionDirective",
  "AdvanceAgentDirective",
  "ExecuteToolBatchDirective",
  "EvaluateCompletionDirective",
  "SuspendDirective",
  "FinalizeDirective",
  "ReturnTerminalDirective",
  "RunExecutionCoordinator",
  "RunExecutionEffectResult",
  "ToolTurnResult",
  "CompletionGateDecision",
  "RunExecutionDriverDependencies",
  "RunExecutionDriver",
  "RunTransitionPlanInput",
  "RunTransitionPlanner",
  "RunExecutionStorePort",
  "RunExecutionSnapshot",
  "RunContinuationCheckpoint",
] as const;

export type PHASE_3C_ASSERTIONS = [
  ModeExact,
  ModeRejectsStart,
  ModeRejectsTools,
  ModeRejectsRepair,
  ModeRejectsEvaluate,
  DirectiveExact,
  DirectiveKinds,
  AdvanceExact,
  AdvanceKeys,
  ToolBatchExact,
  ToolBatchKeys,
  CompletionDirectiveExact,
  CompletionDirectiveKeys,
  SuspendExact,
  SuspendKeys,
  SuspendBoundaries,
  FinalizeExact,
  FinalizeKeys,
  FinalizeReasons,
  FinalizeRejectsFailed,
  FinalizeRejectsBudget,
  ReturnTerminalExact,
  ReturnTerminalKeys,
  ReturnTerminalHasNoStatus,
  ReturnTerminalHasNoReason,
  CoordinatorExact,
  EffectResultExact,
  EffectKinds,
  AgentEffectExact,
  ToolsEffectExact,
  CompletionEffectExact,
  NoneEffectKeys,
  ToolTurnExact,
  ToolTurnKinds,
  CompletionDecisionExact,
  CompletionOutcomes,
  CompletionGateExact,
  ToolTurnCoordinatorExact,
  DriverDependenciesExact,
  DriverDependenciesKeys,
  DriverExact,
  PlanInputExact,
  PlanInputKeys,
  PlannerExact,
  PlannerReturnsCommit,
  StorePortExact,
  StorePortKeys,
  StorePortHasNoVerification,
  SnapshotKeys,
  SnapshotHasNoVerificationPlan,
  ConversationMessageIsAIMessage,
  ContinuationTypes,
  ToolContinuationHasPolicy,
  ToolContinuationResultsAreAI,
  DecisionIsFrozen,
  RunDecisionIsFrozen,
  CompletionCandidateIsFrozen,
  AgentDecisionUnchanged,
];
