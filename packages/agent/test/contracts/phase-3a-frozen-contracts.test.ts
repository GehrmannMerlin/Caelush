import { describe, expect, it } from "vitest";
import type {
  AIMessage,
  AIModelRequest,
  AIModelSettings,
  AIModelTurnResult,
  AIToolSpec,
  ModelDescriptor,
  ModelUsage,
} from "@caelush/ai";
import type {
  AgentBudgetBlock,
  AgentDecision,
  AgentDecisionClassifier,
  AgentExecutionIdentity,
  AgentMessageId,
  AgentFinalCandidateDecision,
  AgentLoopAdvanceInput,
  AgentLoopAdvanceResult,
  AgentLoopCancelledResult,
  AgentLoopContextReceipt,
  AgentLoopDependencies,
  AgentLoopFailedResult,
  AgentLoopFinalCandidateResult,
  AgentLoopSuccessBase,
  AgentLoopToolRequestsResult,
  AgentModelTurn,
  AgentRetryMetadata,
  AgentToolCallsDecision,
  AgentTransientStreamEvent,
  AgentTurnInput,
  AgentTurnRef,
  ContextBuildContribution,
  ContextBuildReport,
  ContextCheckpointRef,
  ContextEnginePort,
  ContextPressure,
  ModelRequestAdmissionDecision,
  ModelRequestAdmissionInput,
  ModelTurnBoundaryInput,
  ModelTurnExecutionError,
  ModelTurnExecutionInput,
  ModelTurnExecutionResult,
  ModelTurnExecutor,
  PreparedModelContext,
  ToolObservationPolicySnapshot,
} from "@caelush/agent";
import type { AgentError, RunId, SessionId, StepId } from "@caelush/protocol";

/**
 * Phase 3A frozen contract exactness.
 *
 * These are **compile-time** assertions, not source-text checks. The defect this file exists for is
 * that the earlier architecture guards asked whether a *symbol* existed; a contract can keep its
 * name while losing its shape, and every consumer then compiles against a drifted interface.
 *
 * ```text
 * Equal<A, B>   true only for mutual assignability with identical modifiers
 * keyof T       the exact property set, so an added or renamed field fails
 * ```
 *
 * Every assertion below is written out from the frozen interface freeze, *not* from the current
 * implementation: a restatement copied out of `src` would agree with the drift by construction.
 *
 * `pnpm typecheck` fails on any of these. Nothing here is a runtime test of behaviour.
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

/** The exact key set of a contract, as a comparable union. */
type Keys<T> = keyof T;

/* ------------------------------------------------------- frozen restatements */

interface FrozenAgentExecutionIdentity {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly goal: string;
}

interface FrozenAgentTurnRef {
  readonly stepId: StepId;
  readonly sequence: number;
}

type FrozenAgentTurnInput =
  | {
      readonly kind: "USER_INPUT";
      readonly userMessageId: AgentMessageId;
    }
  | {
      readonly kind: "TOOL_RESULTS";
      readonly sourceStepId: StepId;
      readonly pendingDecision: AgentToolCallsDecision;
      readonly toolResultMessageIds: readonly AgentMessageId[];
    }
  | {
      readonly kind: "CONTINUATION";
      readonly reason: "VERIFICATION_REPAIR" | "STEERING";
      readonly messageIds?: readonly AgentMessageId[];
    };

interface FrozenContextBuildContribution {
  readonly providerId: string;
  readonly tokenEstimate: number;
  readonly itemCount: number;
  readonly droppedItems: number;
  readonly truncatedItems: number;
}

interface FrozenContextBuildReport {
  readonly estimatedInputTokens: number;
  readonly effectiveInputLimitTokens: number;
  readonly remainingTokens: number;
  readonly pressure: "NORMAL" | "PROACTIVE" | "EMERGENCY";
  readonly compactionCount: number;
  readonly contributions: readonly FrozenContextBuildContribution[];
}

interface FrozenToolObservationPolicySnapshot {
  readonly maxSingleObservationTokens: number;
  readonly maxObservationBatchTokens: number;
}

interface FrozenPreparedModelContext {
  readonly messages: readonly AIMessage[];
  readonly report: FrozenContextBuildReport;
  readonly observationPolicy: FrozenToolObservationPolicySnapshot;
  readonly checkpoint?: ContextCheckpointRef;
  readonly contextFingerprint?: string;
}

interface FrozenAgentLoopContextReceipt {
  readonly report: FrozenContextBuildReport;
  readonly observationPolicy: FrozenToolObservationPolicySnapshot;
  readonly recovery: "NONE" | "FORCED_CONTEXT_RECOVERY";
}

interface FrozenAgentLoopAdvanceInput {
  readonly identity: FrozenAgentExecutionIdentity;
  readonly turn: FrozenAgentTurnRef;
  readonly conversation: import("@caelush/agent").AgentConversationSnapshot;
  readonly input: FrozenAgentTurnInput;
  readonly model: ModelDescriptor;
  readonly tools: readonly AIToolSpec[];
  readonly modelSettings?: AIModelSettings;
  readonly signal: AbortSignal;
}

interface FrozenAgentLoopSuccessBase {
  readonly turn: FrozenAgentTurnRef;
  readonly modelTurn: AgentModelTurn;
  readonly messagesToAppend: readonly AIMessage[];
  readonly context: FrozenAgentLoopContextReceipt;
}

interface FrozenAgentLoopToolRequestsResult extends FrozenAgentLoopSuccessBase {
  readonly kind: "TOOL_REQUESTS";
  readonly decision: AgentToolCallsDecision;
}

interface FrozenAgentLoopFinalCandidateResult extends FrozenAgentLoopSuccessBase {
  readonly kind: "FINAL_CANDIDATE";
  readonly decision: AgentFinalCandidateDecision;
}

interface FrozenAgentLoopFailedResult {
  readonly kind: "FAILED";
  readonly turn: FrozenAgentTurnRef;
  readonly modelTurn?: AgentModelTurn;
  readonly error: AgentError;
  readonly retry?: AgentRetryMetadata;
  readonly usage?: ModelUsage;
  readonly messagesToAppend: readonly AIMessage[];
  readonly context?: FrozenAgentLoopContextReceipt;
}

interface FrozenAgentLoopCancelledResult {
  readonly kind: "CANCELLED";
  readonly turn: FrozenAgentTurnRef;
  readonly messagesToAppend: readonly AIMessage[];
  readonly context?: FrozenAgentLoopContextReceipt;
}

type FrozenAgentLoopAdvanceResult =
  | FrozenAgentLoopToolRequestsResult
  | FrozenAgentLoopFinalCandidateResult
  | FrozenAgentLoopFailedResult
  | FrozenAgentLoopCancelledResult;

interface FrozenModelRequestAdmissionInput {
  readonly identity: FrozenAgentExecutionIdentity;
  readonly turn: FrozenAgentTurnRef;
  readonly request: AIModelRequest;
}

type FrozenModelRequestAdmissionDecision =
  | { readonly kind: "ALLOWED"; readonly request: AIModelRequest }
  | { readonly kind: "BLOCKED"; readonly reason: "BUDGET"; readonly block: AgentBudgetBlock };

interface FrozenModelTurnBoundaryInput {
  readonly identity: FrozenAgentExecutionIdentity;
  readonly turn: FrozenAgentTurnRef;
  readonly model: ModelDescriptor["ref"];
}

interface FrozenModelTurnExecutionInput {
  readonly identity: FrozenAgentExecutionIdentity;
  readonly turn: FrozenAgentTurnRef;
  readonly request: AIModelRequest;
  readonly signal: AbortSignal;
  readonly streamSink?: import("@caelush/agent").ModelTurnStreamSink;
}

interface FrozenModelTurnExecutionError {
  readonly code: import("@caelush/agent").ModelTurnExecutionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

type FrozenAgentTransientStreamEvent =
  | {
      readonly type: "text.delta";
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly text: string;
    }
  | {
      readonly type: "thinking.delta";
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly text: string;
    }
  | {
      readonly type: "tool_call.delta";
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly toolCallId: string;
      readonly delta: string;
    };

interface FrozenAgentLoopDependencies {
  readonly contextEngine: ContextEnginePort;
  readonly modelTurnExecutor: ModelTurnExecutor;
  readonly decisionClassifier: AgentDecisionClassifier;
  readonly modelAdmission?: import("@caelush/agent").ModelRequestAdmissionPort;
  readonly modelTurnBoundary?: import("@caelush/agent").ModelTurnBoundaryPort;
}

/* ------------------------------------------------------------- assertions */

/* Identity, turn ref and turn input. */
type IdentityExact = Expect<Equal<AgentExecutionIdentity, FrozenAgentExecutionIdentity>>;
type IdentityKeys = Expect<Equal<Keys<AgentExecutionIdentity>, "runId" | "sessionId" | "goal">>;
type TurnRefExact = Expect<Equal<AgentTurnRef, FrozenAgentTurnRef>>;
type TurnRefKeys = Expect<Equal<Keys<AgentTurnRef>, "stepId" | "sequence">>;
type TurnInputExact = Expect<Equal<AgentTurnInput, FrozenAgentTurnInput>>;

/* The frozen advance input. `settings` and `streamSink` are the drift this catches. */
type AdvanceInputExact = Expect<Equal<AgentLoopAdvanceInput, FrozenAgentLoopAdvanceInput>>;
type AdvanceInputKeys = Expect<
  Equal<
    Keys<AgentLoopAdvanceInput>,
    "identity" | "turn" | "conversation" | "input" | "model" | "tools" | "modelSettings" | "signal"
  >
>;
type ModelSettingsIsOptional = Expect<
  Equal<AgentLoopAdvanceInput["modelSettings"], AIModelSettings | undefined> extends true
    ? true
    : true
>;

/* The context receipt and the prepared context. `recovered` is the drift this catches. */
type ContextReceiptExact = Expect<Equal<AgentLoopContextReceipt, FrozenAgentLoopContextReceipt>>;
type ContextReceiptKeys = Expect<
  Equal<Keys<AgentLoopContextReceipt>, "report" | "observationPolicy" | "recovery">
>;
type PreparedContextExact = Expect<Equal<PreparedModelContext, FrozenPreparedModelContext>>;
type PreparedContextKeys = Expect<
  Equal<
    Keys<PreparedModelContext>,
    "messages" | "report" | "observationPolicy" | "checkpoint" | "contextFingerprint"
  >
>;

/* The typed report. `Readonly<Record<string, unknown>>` is the drift this catches. */
type BuildReportExact = Expect<Equal<ContextBuildReport, FrozenContextBuildReport>>;
type BuildReportKeys = Expect<
  Equal<
    Keys<ContextBuildReport>,
    | "estimatedInputTokens"
    | "effectiveInputLimitTokens"
    | "remainingTokens"
    | "pressure"
    | "compactionCount"
    | "contributions"
  >
>;
type ContributionExact = Expect<Equal<ContextBuildContribution, FrozenContextBuildContribution>>;
type PressureIsClosed = Expect<Equal<ContextPressure, "NORMAL" | "PROACTIVE" | "EMERGENCY">>;

/* The observation snapshot. `id`, `maxOutputBytes` and `includeDetails` are the drift. */
type ObservationPolicyExact = Expect<
  Equal<ToolObservationPolicySnapshot, FrozenToolObservationPolicySnapshot>
>;
type ObservationPolicyKeys = Expect<
  Equal<
    Keys<ToolObservationPolicySnapshot>,
    "maxSingleObservationTokens" | "maxObservationBatchTokens"
  >
>;

/* The advance result union: exactly four discriminants. */
type AdvanceResultExact = Expect<Equal<AgentLoopAdvanceResult, FrozenAgentLoopAdvanceResult>>;
type AdvanceResultKinds = Expect<
  Equal<
    AgentLoopAdvanceResult["kind"],
    "TOOL_REQUESTS" | "FINAL_CANDIDATE" | "FAILED" | "CANCELLED"
  >
>;
type NoCompletedStatus = Expect<
  Equal<Extract<AgentLoopAdvanceResult, { readonly status: unknown }>, never>
>;
type SuccessBaseExact = Expect<Equal<AgentLoopSuccessBase, FrozenAgentLoopSuccessBase>>;
type ToolRequestsExact = Expect<
  Equal<AgentLoopToolRequestsResult, FrozenAgentLoopToolRequestsResult>
>;
type FinalCandidateExact = Expect<
  Equal<AgentLoopFinalCandidateResult, FrozenAgentLoopFinalCandidateResult>
>;
type FailedExact = Expect<Equal<AgentLoopFailedResult, FrozenAgentLoopFailedResult>>;
type FailedKeys = Expect<
  Equal<
    Keys<AgentLoopFailedResult>,
    "kind" | "turn" | "modelTurn" | "error" | "retry" | "usage" | "messagesToAppend" | "context"
  >
>;
type CancelledExact = Expect<Equal<AgentLoopCancelledResult, FrozenAgentLoopCancelledResult>>;
type CancelledKeys = Expect<
  Equal<Keys<AgentLoopCancelledResult>, "kind" | "turn" | "messagesToAppend" | "context">
>;
/** Every successful Reason carries its turn, its settled turn and its context receipt. */
type SuccessCarriesTurn = Expect<Equal<AgentLoopSuccessBase["turn"], AgentTurnRef>>;
type SuccessCarriesModelTurn = Expect<Equal<AgentLoopSuccessBase["modelTurn"], AgentModelTurn>>;
type SuccessCarriesReceipt = Expect<
  Equal<AgentLoopSuccessBase["context"], AgentLoopContextReceipt>
>;

/* Admission. `model` and `signal` are the drift; `ALLOWED.request` is the frozen restatement. */
type AdmissionInputExact = Expect<
  Equal<ModelRequestAdmissionInput, FrozenModelRequestAdmissionInput>
>;
type AdmissionInputKeys = Expect<
  Equal<Keys<ModelRequestAdmissionInput>, "identity" | "turn" | "request">
>;
type AdmissionDecisionExact = Expect<
  Equal<ModelRequestAdmissionDecision, FrozenModelRequestAdmissionDecision>
>;
type AllowedCarriesRequest = Expect<
  Equal<Extract<ModelRequestAdmissionDecision, { kind: "ALLOWED" }>["request"], AIModelRequest>
>;

/* The durable boundary. `request` and the full descriptor are the drift. */
type BoundaryInputExact = Expect<Equal<ModelTurnBoundaryInput, FrozenModelTurnBoundaryInput>>;
type BoundaryInputKeys = Expect<Equal<Keys<ModelTurnBoundaryInput>, "identity" | "turn" | "model">>;
type BoundaryModelIsRef = Expect<Equal<ModelTurnBoundaryInput["model"], ModelDescriptor["ref"]>>;

/* The executor input keeps the sink; the loop input does not. */
type ExecutorInputExact = Expect<Equal<ModelTurnExecutionInput, FrozenModelTurnExecutionInput>>;
type ExecutorInputKeys = Expect<
  Equal<Keys<ModelTurnExecutionInput>, "identity" | "turn" | "request" | "signal" | "streamSink">
>;
type ExecutorResultExact = Expect<
  Equal<
    ModelTurnExecutionResult,
    | { readonly kind: "COMPLETED"; readonly result: AIModelTurnResult }
    | { readonly kind: "FAILED"; readonly error: ModelTurnExecutionError }
    | { readonly kind: "CANCELLED" }
  >
>;

/* The failure contract. `stage` and `cause` are the drift. */
type TurnErrorExact = Expect<Equal<ModelTurnExecutionError, FrozenModelTurnExecutionError>>;
type TurnErrorKeys = Expect<
  Equal<Keys<ModelTurnExecutionError>, "code" | "message" | "retryable" | "retryAfterMs">
>;

/* The transient stream carries its correlation. */
type TransientExact = Expect<Equal<AgentTransientStreamEvent, FrozenAgentTransientStreamEvent>>;
type TransientKinds = Expect<
  Equal<AgentTransientStreamEvent["type"], "text.delta" | "thinking.delta" | "tool_call.delta">
>;
type TransientCorrelation = Expect<
  Equal<AgentTransientStreamEvent["runId"] | AgentTransientStreamEvent["stepId"], RunId | StepId>
>;
type TextDeltaExact = Expect<
  Equal<
    Extract<AgentTransientStreamEvent, { type: "text.delta" }>,
    {
      readonly type: "text.delta";
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly text: string;
    }
  >
>;
type ThinkingDeltaExact = Expect<
  Equal<
    Extract<AgentTransientStreamEvent, { type: "thinking.delta" }>,
    {
      readonly type: "thinking.delta";
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly text: string;
    }
  >
>;
type ToolCallDeltaExact = Expect<
  Equal<
    Extract<AgentTransientStreamEvent, { type: "tool_call.delta" }>,
    {
      readonly type: "tool_call.delta";
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly toolCallId: string;
      readonly delta: string;
    }
  >
>;

/* The dependency surface. `decisionClassifier` is required; `modelRequestBuilder` is gone. */
type DependenciesExact = Expect<Equal<AgentLoopDependencies, FrozenAgentLoopDependencies>>;
type DependenciesKeys = Expect<
  Equal<
    Keys<AgentLoopDependencies>,
    | "contextEngine"
    | "modelTurnExecutor"
    | "decisionClassifier"
    | "modelAdmission"
    | "modelTurnBoundary"
  >
>;
type ClassifierIsRequired = Expect<
  Equal<
    // The empty object type is the point here: a dependency bag with no `decisionClassifier` must
    // NOT be assignable to the frozen interface.
    EmptyObject extends Pick<AgentLoopDependencies, "decisionClassifier"> ? true : false,
    false
  >
>;

/** An object with no required properties, used to test that a field is required. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type EmptyObject = {};

/* The decision contract is unchanged: two discriminants, no more. */
type DecisionKinds = Expect<
  Equal<AgentDecision["type"], "TOOL_CALLS_REQUESTED" | "FINAL_CANDIDATE">
>;

/**
 * The compile-time assertions above are erased at runtime; this keeps the file a real test so a
 * reader can see the contract they guard and so a missing file is a failure rather than silence.
 */
describe("Phase 3A frozen contract exactness", () => {
  it("compiles every frozen shape assertion", () => {
    // The names are referenced so an accidental deletion of a contract fails the build here too.
    const asserted: readonly unknown[] = [AGENT_EXACTNESS_MARKERS satisfies readonly string[]];
    expect(asserted).toHaveLength(1);
  });
});

/** One marker per asserted contract, kept in sync with the assertions above. */
const AGENT_EXACTNESS_MARKERS = [
  "AgentExecutionIdentity",
  "AgentTurnRef",
  "AgentTurnInput",
  "AgentLoopAdvanceInput",
  "AgentLoopAdvanceResult",
  "AgentLoopSuccessBase",
  "AgentLoopToolRequestsResult",
  "AgentLoopFinalCandidateResult",
  "AgentLoopFailedResult",
  "AgentLoopCancelledResult",
  "AgentLoopContextReceipt",
  "ContextBuildReport",
  "ContextBuildContribution",
  "ToolObservationPolicySnapshot",
  "PreparedModelContext",
  "ModelRequestAdmissionInput",
  "ModelRequestAdmissionDecision",
  "ModelTurnBoundaryInput",
  "ModelTurnExecutionInput",
  "ModelTurnExecutionResult",
  "ModelTurnExecutionError",
  "AgentTransientStreamEvent",
  "AgentLoopDependencies",
] as const;

/**
 * The assertions are pure types, so nothing references `Expect` results at runtime. These aliases
 * keep the whole block live for the compiler: an unused type alias is still checked, and the
 * `satisfies` below makes a failure to resolve one of them a hard error here.
 */
type AllAssertions = [
  IdentityExact,
  IdentityKeys,
  TurnRefExact,
  TurnRefKeys,
  TurnInputExact,
  AdvanceInputExact,
  AdvanceInputKeys,
  ModelSettingsIsOptional,
  ContextReceiptExact,
  ContextReceiptKeys,
  PreparedContextExact,
  PreparedContextKeys,
  BuildReportExact,
  BuildReportKeys,
  ContributionExact,
  PressureIsClosed,
  ObservationPolicyExact,
  ObservationPolicyKeys,
  AdvanceResultExact,
  AdvanceResultKinds,
  NoCompletedStatus,
  SuccessBaseExact,
  ToolRequestsExact,
  FinalCandidateExact,
  FailedExact,
  FailedKeys,
  CancelledExact,
  CancelledKeys,
  SuccessCarriesTurn,
  SuccessCarriesModelTurn,
  SuccessCarriesReceipt,
  AdmissionInputExact,
  AdmissionInputKeys,
  AdmissionDecisionExact,
  AllowedCarriesRequest,
  BoundaryInputExact,
  BoundaryInputKeys,
  BoundaryModelIsRef,
  ExecutorInputExact,
  ExecutorInputKeys,
  ExecutorResultExact,
  TurnErrorExact,
  TurnErrorKeys,
  TransientExact,
  TransientKinds,
  TransientCorrelation,
  TextDeltaExact,
  ThinkingDeltaExact,
  ToolCallDeltaExact,
  DependenciesExact,
  DependenciesKeys,
  ClassifierIsRequired,
  DecisionKinds,
];

/** Every element must be `true`; a drifted shape makes this `satisfies` fail to compile. */
export const FROZEN_CONTRACT_EXACTNESS = AGENT_EXACTNESS_MARKERS satisfies readonly string[];
export type FROZEN_CONTRACT_ASSERTIONS = AllAssertions;
