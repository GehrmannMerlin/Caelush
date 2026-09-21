import type {
  AIMessage,
  AIModelRequest,
  AIToolResultMessage,
  AIToolSpec,
  JsonObject,
  ModelCatalog,
  ModelDescriptor,
} from "@caelush/ai";
import type {
  AgentLoopAdvanceResult,
  ContextEnginePort,
  ContextPrepareInput,
  ModelTurnExecutionResult,
  ModelTurnExecutor,
  PreparedModelContext,
} from "@caelush/agent";
import { RunController, type RunAgentExecutionContextFactory } from "@caelush/core";
import {
  createModelToolFeedbackProjector,
  createToolResultBatchNormalizer,
  type ToolBatchCoordinator,
  type ToolBatchItemOutcome,
  type ToolBatchOutcome,
  type ToolBatchRequest,
} from "@caelush/agent";
import { toContextObservationProjection } from "@caelush/core";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  ApprovalRequest,
  ApprovalRequestId,
  ObservationId,
  RunId,
  StepId,
  ToolInvocationId,
  ToolName,
  ToolObservation,
  TimestampMs,
} from "@caelush/protocol";
import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";

import { modelTurnResult } from "./fake-model-turn-executor.js";
import {
  fakeFrozenModelTurnExecutor,
  type FakeFrozenModelTurnExecutor,
} from "./run-agent-execution.js";
import type {
  DurableAgentEvent,
  RunCandidateBoundaryCommit,
  RunCompletionPersistencePort,
  RunExecutionCommit,
  RunExecutionStore,
  RunVerifiedCompletionCommit,
} from "@caelush/core";

/**
 * The Phase 3D Tool turn test harness.
 *
 * ```text
 * RunController -> RunExecutionDriver -> the run-scoped ToolTurnCoordinator
 *                                              -> canonical ToolBatchCoordinator
 *                                              -> canonical ModelToolFeedbackProjector
 *                                              -> canonical ToolResultBatchNormalizer
 * ```
 *
 * The Tool Layer is stubbed at the canonical `ToolBatchCoordinator` and nowhere else, so every
 * production boundary between the Run Layer and that port is the real one: the frozen driver, the real
 * run-scoped adapter, the identity verification, the resource admission, the observation projection
 * and the typed settlement. That is what lets a test count what the Run Layer actually did rather
 * than what a mock was told to say.
 *
 * Phase 4D changed the stub's *shape*, not its purpose: the canonical batch reports
 * `ToolBatchItemOutcome` items, so an observation item now carries a durable `ToolObservation` rather
 * than a flat content string plus a detached artifact pointer.
 */

/** One recorded call to the canonical Tool batch port. */
export interface RecordedToolBatch {
  readonly operation: "execute";
  readonly request: ToolBatchRequest;
}

/**
 * What the stubbed Tool Layer answers one batch with.
 *
 * It is the Tool Layer's *own* outcome type, not a test-local approximation: a stub that answered a
 * different shape would prove the adapter handles a shape production never produces.
 */
export type ToolBatchAnswer = ToolBatchOutcome;

/** The identity of one requested Tool call, as the canonical batch carries it. */
export interface ItemLike {
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly args: JsonObject;
}

/** A deterministic id, so a fixture is byte-stable across runs. */
function fixtureId(prefix: string, index: number): string {
  return `${prefix}_0195f3a0-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
}

/**
 * One durable Tool observation, as the canonical batch reports it.
 *
 * The observation satisfies the Protocol invariant the real settlement enforces: `COMPLETED` carries
 * `isError: false`, `FAILED` carries `isError: true`, and `createdAt` is the settlement timestamp.
 */
export function toolObservation(input: {
  readonly toolInvocationId: string;
  readonly content: string;
  readonly isError?: boolean;
  readonly index?: number;
  readonly rawArtifactRef?: string;
}): ToolObservation {
  return {
    id: fixtureId("obs", input.index ?? 0) as ObservationId,
    runId: fixtureId("run", 0) as RunId,
    stepId: fixtureId("stp", 0) as StepId,
    kind: "TOOL",
    toolInvocationId: input.toolInvocationId as ToolInvocationId,
    ...(input.rawArtifactRef === undefined ? {} : { rawArtifactRef: input.rawArtifactRef }),
    content: input.content,
    isError: input.isError ?? false,
    createdAt: createTimestampMs(1),
  };
}

/**
 * One `OBSERVATION` item of a canonical batch outcome.
 *
 * The durable invocation is named explicitly by the caller when the test cares about recovery identity;
 * otherwise a deterministic fixture id is used, so two spellings of the same batch agree.
 */
export function toolResultItem(input: {
  readonly externalCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError?: boolean;
  readonly invocationId?: string;
  readonly observationId?: string;
  readonly rawArtifactRef?: string;
  readonly index?: number;
}): ToolBatchItemOutcome {
  const invocationId = input.invocationId ?? fixtureId("tiv", input.index ?? 0);
  return {
    kind: "OBSERVATION",
    call: { externalCallId: input.externalCallId, toolName: input.toolName as ToolName, args: {} },
    invocationId: invocationId as ToolInvocationId,
    finalStatus: (input.isError ?? false) ? "FAILED" : "COMPLETED",
    observation: {
      ...toolObservation({
        toolInvocationId: invocationId,
        content: input.content,
        isError: input.isError ?? false,
        ...(input.index === undefined ? {} : { index: input.index }),
        ...(input.rawArtifactRef === undefined ? {} : { rawArtifactRef: input.rawArtifactRef }),
      }),
      ...(input.observationId === undefined ? {} : { id: input.observationId as never }),
    },
  };
}

/**
 * One `REJECTED` item of a canonical batch outcome.
 *
 * A rejection has no durable invocation — that is the whole point of the 4D transition — so it carries
 * only the model's original call and safe feedback.
 */
export function rejectedItem(input: {
  readonly externalCallId: string;
  readonly toolName: string;
  readonly code?: string;
  readonly content?: string;
}): ToolBatchItemOutcome {
  return {
    kind: "REJECTED",
    call: { externalCallId: input.externalCallId, toolName: input.toolName as ToolName, args: {} },
    feedback: {
      code: input.code ?? "TOOL_ARGUMENT_ERROR",
      content: input.content ?? "Arguments do not match the Tool's input schema.",
      details: {},
      disposition: "SAFE_FAILURE",
    },
  };
}

/** One `SKIPPED` item of a canonical batch outcome. */
export function skippedItem(input: {
  readonly externalCallId: string;
  readonly toolName: string;
  readonly content?: string;
}): ToolBatchItemOutcome {
  return {
    kind: "SKIPPED",
    call: { externalCallId: input.externalCallId, toolName: input.toolName as ToolName, args: {} },
    feedback: {
      code: "SKIPPED_AFTER_UNCERTAIN_EXECUTION",
      content:
        input.content ??
        "This tool call was skipped because an earlier tool execution may have partially or fully completed.",
      details: {},
      disposition: "UNCERTAIN_SIDE_EFFECT",
    },
  };
}

export interface StubToolBatches extends ToolBatchCoordinator {
  readonly calls: RecordedToolBatch[];
  /** Physical Tool executions, as the Tool Layer would count them. */
  physicalExecutions: number;
  /**
   * What the Tool Layer answers, given the calls it was asked about.
   *
   * It is a property rather than an override of `execute`, so the recorded call log stays the stub's
   * own account of what it was asked: a test that replaced `execute` would lose the very count these
   * tests are about.
   */
  answerWith: ToolBatchAnswer | ((items: readonly ItemLike[]) => ToolBatchAnswer);
  /** A value the next call throws, consumed once. A queued failure outranks the answer. */
  failures: unknown[];
}

export function stubToolBatches(
  answers: readonly ToolBatchAnswer[] = [],
  failures: readonly unknown[] = [],
): StubToolBatches {
  const calls: RecordedToolBatch[] = [];
  const state = {
    answers: [...answers],
    failures: [...failures],
    physicalExecutions: 0,
    answerWith: undefined as
      ToolBatchAnswer | ((items: readonly ItemLike[]) => ToolBatchAnswer) | undefined,
  };
  async function answer(request: ToolBatchRequest): Promise<ToolBatchAnswer> {
    calls.push({ operation: "execute", request });
    const failure = state.failures.shift();
    if (failure !== undefined) throw failure;
    if (state.answerWith !== undefined) {
      return typeof state.answerWith === "function"
        ? state.answerWith(request.calls)
        : state.answerWith;
    }
    const next = state.answers.length > 1 ? state.answers.shift()! : state.answers[0];
    return next ?? complete(request, "completion by default");
  }
  function complete(request: ToolBatchRequest, content: string): ToolBatchAnswer {
    return {
      kind: "COMPLETED",
      items: request.calls.map((call, index) =>
        toolResultItem({
          externalCallId: call.externalCallId,
          toolName: call.toolName,
          content: `${content}:${call.externalCallId}`,
          index,
        }),
      ),
    };
  }
  return {
    get calls() {
      return calls;
    },
    get physicalExecutions() {
      return state.physicalExecutions;
    },
    set physicalExecutions(value: number) {
      state.physicalExecutions = value;
    },
    set answerWith(value: ToolBatchAnswer | ((items: readonly ItemLike[]) => ToolBatchAnswer)) {
      state.answerWith = value;
    },
    get answerWith(): ToolBatchAnswer | ((items: readonly ItemLike[]) => ToolBatchAnswer) {
      return state.answerWith ?? { kind: "COMPLETED", items: [] };
    },
    get failures() {
      return state.failures;
    },
    set failures(value: unknown[]) {
      state.failures = [...value];
    },
    async execute(request) {
      state.physicalExecutions += 1;
      return answer(request);
    },
  } as StubToolBatches;
}

/**
 * One `WAITING_APPROVAL` item set: the calls that already reached a final item outcome.
 *
 * The pending call is deliberately **not** an item. Building the outcome from an approval request and a
 * pending call is what the canonical batch does, so the fixture does the same rather than inventing an
 * observation for a call that is still waiting.
 */
export function approvalRequest(input: {
  readonly id: string;
  readonly toolInvocationId: string;
  readonly runId?: string;
  readonly riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly expiresAt?: TimestampMs;
}): ApprovalRequest {
  return {
    id: input.id as ApprovalRequestId,
    runId: (input.runId ?? fixtureId("run", 0)) as RunId,
    toolInvocationId: input.toolInvocationId as ToolInvocationId,
    riskLevel: input.riskLevel ?? "HIGH",
    title: "Tool execution requires approval",
    reason: "The active approval policy requires a decision for this Tool.",
    action: {},
    status: "PENDING",
    scope: "ONCE",
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    createdAt: createTimestampMs(1),
  };
}

/**
 * The canonical Tool turn pipeline over a stubbed batch scheduler.
 *
 * ```text
 * batches      the stub
 * feedback     the REAL canonical projector, wired with the REAL Context projection adapter
 * normalizer   the REAL canonical normalizer
 * ```
 *
 * Only the scheduler is stubbed. The projector and normalizer are production objects, so a test that
 * asserts "the model received these results" is asserting about the production model-feedback path
 * rather than about a second implementation written inside the test.
 */
export function stubToolTurnPipeline(batches: StubToolBatches): {
  readonly batches: StubToolBatches;
  readonly feedback: ReturnType<typeof createModelToolFeedbackProjector>;
  readonly normalizer: ReturnType<typeof createToolResultBatchNormalizer>;
} {
  return {
    batches,
    feedback: createModelToolFeedbackProjector({
      projection: toContextObservationProjection(),
    }),
    normalizer: createToolResultBatchNormalizer(),
  };
}

/* ------------------------------------------------------------------ store */

/**
 * A store that commits the way the production store does.
 *
 * An absent `state` means "this transition leaves the AgentState alone", exactly as the canonical
 * commit contract says — which is what makes a continuation-only transition, such as accepting a
 * Tool batch, keep the state it was already holding.
 */
export class MemoryRunStore implements RunExecutionStore, RunCompletionPersistencePort {
  stateRevision: number | undefined;
  continuationRevision: number | undefined;
  readonly commits: RunExecutionCommit[] = [];
  readonly steps = new Map<StepId, AgentStep>();
  private sequence = 0;
  /**
   * The verification plans a candidate boundary wrote.
   *
   * Phase 3E: a general Run snapshot carries no plan, so the store keeps them behind the Core-private
   * completion persistence port — written by the boundary that names them, exactly as the durable
   * store writes them in one transaction.
   */
  private readonly plans = new Map<string, import("@caelush/protocol").VerificationPlan>();

  constructor(public snapshot: import("@caelush/core").RunExecutionSnapshot) {
    this.stateRevision = snapshot.stateRevision;
    this.continuationRevision = snapshot.continuationRevision;
  }

  async loadVerificationPlan(
    _runId: RunId,
    planId: import("@caelush/protocol").VerificationPlanId,
  ): Promise<import("@caelush/protocol").VerificationPlan | null> {
    return this.plans.get(planId) ?? null;
  }

  async commitCandidateBoundary(command: RunCandidateBoundaryCommit) {
    this.plans.set(command.verificationPlan.id, command.verificationPlan);
    return this.commit({
      run: command.run,
      state: command.state,
      expectedStateRevision: command.expectedStateRevision,
      expectedContinuationRevision: command.expectedContinuationRevision,
      stepWrites: command.stepWrites,
      messagesToAppend: command.messagesToAppend,
      continuation: {
        operation: "SET",
        checkpoint: command.continuation,
        updatedAt: command.state.updatedAt,
      },
      events: command.events,
    });
  }

  async commitVerifiedCompletion(command: RunVerifiedCompletionCommit) {
    return this.commit({
      run: command.run,
      state: command.state,
      expectedStateRevision: command.expectedStateRevision,
      expectedContinuationRevision: command.expectedContinuationRevision,
      stepWrites: [],
      messagesToAppend: [],
      continuation: { operation: "CLEAR" },
      events: command.events,
    });
  }

  async load(): Promise<import("@caelush/core").RunExecutionSnapshot> {
    return this.snapshot;
  }

  async requestCancellation(
    runId: RunId,
    intent: import("@caelush/core").RunExecutionSnapshot["cancellationIntent"],
  ): Promise<import("@caelush/core").RunExecutionSnapshot> {
    if (intent === undefined || intent.runId !== runId) throw new Error("invalid cancellation");
    this.snapshot = { ...this.snapshot, cancellationIntent: intent };
    return this.snapshot;
  }

  async commit(command: RunExecutionCommit) {
    this.commits.push(command);
    if (command.state !== undefined) this.stateRevision = (this.stateRevision ?? 0) + 1;
    for (const write of command.stepWrites) this.steps.set(write.step.id, write.step);
    const activeStep = command.stepWrites.find((write) => write.step.status === "RUNNING")?.step;
    const nextContinuation =
      command.continuation === undefined
        ? this.snapshot.continuation
        : command.continuation.operation === "CLEAR"
          ? undefined
          : command.continuation.checkpoint;
    if (command.continuation?.operation === "SET") {
      this.continuationRevision = (this.continuationRevision ?? 0) + 1;
    }
    if (command.continuation?.operation === "CLEAR") this.continuationRevision = undefined;

    const conversation: import("@caelush/core").RunConversationEntry[] = [
      ...this.snapshot.conversation,
      ...command.messagesToAppend.map((entry, index) => ({
        runId: command.run.id,
        sequence: this.snapshot.conversation.length + index + 1,
        ...entry,
      })),
    ];
    this.snapshot = {
      run: command.run,
      conversation,
      ...(command.state === undefined
        ? this.snapshot.state === undefined
          ? {}
          : { state: this.snapshot.state }
        : { state: command.state }),
      ...(this.stateRevision === undefined ? {} : { stateRevision: this.stateRevision }),
      ...(activeStep === undefined ? {} : { activeStep }),
      ...(nextContinuation === undefined ? {} : { continuation: nextContinuation }),
      ...(nextContinuation === undefined || this.continuationRevision === undefined
        ? {}
        : { continuationRevision: this.continuationRevision }),
    };
    const events: DurableAgentEvent[] = command.events.map((draft) => ({
      ...draft,
      durability: { ...draft.durability, sequence: ++this.sequence },
    }));
    return { snapshot: this.snapshot, events };
  }
}

/* --------------------------------------------------------------- harness */

export interface RecordedTurn {
  readonly request: AIModelRequest;
}

export interface Phase3DHarness {
  readonly controller: RunController;
  readonly store: MemoryRunStore;
  readonly toolBatches: StubToolBatches;
  readonly notifications: DurableAgentEvent[];
  readonly allocatedSteps: StepId[];
  readonly turns: RecordedTurn[];
  readonly executor: FakeFrozenModelTurnExecutor;
  /**
   * The approval boundary the controller was composed with.
   *
   * The Run Layer orchestrates approval resolution but does not own Approval persistence, so a Run
   * can only reach a resolution boundary when its host supplies one — exactly as production does.
   * This stands in for the durable approval store: it answers for the single request the Tool Layer
   * already created and moves it from PENDING to APPROVED when it is resolved.
   */
  readonly approvals: ApprovalBoundary;
}

/** A single-request stand-in for the durable approval store. */
export interface ApprovalBoundary {
  /** Whether the request has been approved yet. */
  readonly approved: boolean;
  /**
   * Declare the request the Tool Layer created.
   *
   * A test knows the invocation and approval identities only after the batch has stopped, which is
   * why the boundary is *told* about them rather than describing them in advance: what it must not
   * do is invent an approval the Tool Layer never created.
   */
  declare(input: { readonly approvalId: string; readonly toolInvocationId: string }): void;
  readonly port: unknown;
}

function testApprovalBoundary(runId: RunId): ApprovalBoundary {
  let status: "PENDING" | "APPROVED" = "PENDING";
  let declaration: { readonly approvalId: string; readonly toolInvocationId: string } | undefined;
  const request = () => ({
    id: declaration?.approvalId,
    runId,
    toolInvocationId: declaration?.toolInvocationId,
    status,
    scope: "ONCE",
  });
  return {
    get approved() {
      return status === "APPROVED";
    },
    declare(input) {
      declaration = input;
    },
    port: {
      async getById(id: string) {
        return id === declaration?.approvalId ? request() : null;
      },
      async resolve(id: string) {
        if (id !== declaration?.approvalId) throw new Error("unknown approval");
        status = "APPROVED";
        return request();
      },
    },
  };
}

export function makeRunD(overrides: Partial<AgentRun> = {}): AgentRun {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect the project",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 100_000 },
    createdAt: createTimestampMs(1),
    ...overrides,
  });
}

let clockTick = 10;

export function harness3d(options: {
  readonly run?: AgentRun;
  readonly snapshot?: Partial<import("@caelush/core").RunExecutionSnapshot>;
  readonly script: (call: number) => Promise<ModelTurnExecutionResult> | ModelTurnExecutionResult;
  readonly toolBatches?: StubToolBatches;
  readonly extra?: Record<string, unknown>;
  readonly observationPolicy?: {
    readonly maxSingleObservationTokens: number;
    readonly maxObservationBatchTokens: number;
  };
}): Phase3DHarness {
  const run = options.run ?? makeRunD();
  const store = new MemoryRunStore({
    run,
    conversation: [],
    ...options.snapshot,
  });
  const notifications: DurableAgentEvent[] = [];
  const allocatedSteps: StepId[] = [];
  const turns: RecordedTurn[] = [];
  const contextEngine = policyContextEngine(options.observationPolicy);
  const executor = fakeFrozenModelTurnExecutor(async (request, _signal, callIndex) => {
    turns.push({ request });
    return options.script(callIndex);
  });
  const execution: RunAgentExecutionContextFactory = {
    async resolve(): Promise<Awaited<ReturnType<RunAgentExecutionContextFactory["resolve"]>>> {
      return {
        models: testCatalog(),
        modelTurnExecutor: executor,
        stepIds: {
          create: () => {
            const id = createStepId();
            allocatedSteps.push(id);
            return id;
          },
        },
        tools: [] as readonly AIToolSpec[],
        createContextEngine: () => contextEngine,
      };
    },
  };
  const toolBatches = options.toolBatches ?? stubToolBatches();
  const approvals = testApprovalBoundary(run.id);
  const controller = new RunController({
    agentExecution: execution,
    executionStore: store,
    events: {
      notifyCommitted: (events: readonly DurableAgentEvent[]) => notifications.push(...events),
    },
    configResolver: {
      resolve: async () => ({ baseSystemPrompt: "base", contextLimits: { maxInputTokens: 1000 } }),
    },
    clock: { now: () => createTimestampMs(++clockTick) },
    eventIdFactory: { create: createEventId },
    toolTurn: stubToolTurnPipeline(toolBatches),
    verificationPlanner: {
      plan: ({ runId, sourceStepId }: { runId: RunId; sourceStepId: StepId }) => ({
        runId,
        sourceStepId,
        plannerVersion: "phase-11a.v1",
        planHash: "b".repeat(64),
        checks: [
          {
            ordinal: 0,
            stage: "ACCEPTANCE",
            requirement: "REQUIRED",
            spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
          },
        ],
      }),
    },
    approvals: approvals.port,
    ...options.extra,
  } as never);
  return {
    controller,
    store,
    toolBatches,
    notifications,
    allocatedSteps,
    turns,
    executor,
    approvals,
  };
}

/** A Context Engine that renders the turn and reports a known observation policy. */
function policyContextEngine(policy?: {
  readonly maxSingleObservationTokens: number;
  readonly maxObservationBatchTokens: number;
}): ContextEnginePort {
  return {
    async prepare(input: ContextPrepareInput): Promise<PreparedModelContext> {
      return {
        messages: [...input.history, ...turnMessages(input)],
        report: {
          estimatedInputTokens: 1,
          effectiveInputLimitTokens: input.model.limits.contextWindowTokens,
          remainingTokens: input.model.limits.contextWindowTokens - 1,
          pressure: "NORMAL",
          compactionCount: 0,
          contributions: [],
        },
        observationPolicy: policy ?? {
          maxSingleObservationTokens: 4_000,
          maxObservationBatchTokens: 12_000,
        },
      };
    },
  };
}

export function turnMessages(input: ContextPrepareInput): readonly AIMessage[] {
  const turn = input.input;
  if (turn.kind === "USER_INPUT") return turn.messages;
  if (turn.kind === "CONTINUATION") return turn.messages ?? [];
  return [
    turn.pendingDecision.modelTurn.assistantMessage,
    ...(turn.results as readonly AIToolResultMessage[]),
  ];
}

/** One provider turn that asks for Tools. */
export function toolTurn(
  calls: readonly { readonly id: string; readonly name: string; readonly input?: unknown }[],
): ModelTurnExecutionResult {
  return {
    kind: "COMPLETED",
    result: modelTurnResult({
      callId: undefined as never,
      providerId: "fixture",
      model: { provider: "fixture", model: "fixture-model" },
      text: "",
      finishReason: "TOOL_CALLS",
      // A call with no explicit input still carries the schema-valid empty object the frozen
      // decision requires, and a call with one carries exactly it: the adapter hands the Tool Layer
      // the model's own arguments, never a reconstruction.
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        input: (call.input ?? {}) as never,
      })) as never,
    }),
  };
}

/** One provider turn that answers. */
export function answerTurn(text = "done"): ModelTurnExecutionResult {
  return {
    kind: "COMPLETED",
    result: modelTurnResult({
      callId: undefined as never,
      providerId: "fixture",
      model: { provider: "fixture", model: "fixture-model" },
      text,
      toolCalls: [],
      finishReason: "STOP",
    }),
  };
}

/** Every durable event type the Run published, in sequence order. */
export function eventTypes(events: readonly DurableAgentEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

/**
 * The requested Tool calls of one recorded batch, for identity assertions.
 *
 * Phase 4D: the canonical request names its calls `calls`, and the Run facts a batch carries travel
 * beside them rather than being merged into each call.
 */
export function recordedItems(batch: RecordedToolBatch): readonly ItemLike[] {
  return batch.request.calls;
}

export function stateOf(harness: { readonly store: MemoryRunStore }): AgentState | undefined {
  return harness.store.snapshot.state;
}

/** The frozen results one advance would append, as the model sees them. */
export function appendedToolResults(result: AgentLoopAdvanceResult): readonly AIMessage[] {
  return result.kind === "TOOL_REQUESTS" || result.kind === "FINAL_CANDIDATE"
    ? result.messagesToAppend.filter((message) => message.role === "tool")
    : [];
}

function testCatalog(): ModelCatalog {
  const descriptor: Omit<ModelDescriptor, "ref"> = {
    api: "test-api",
    limits: { contextWindowTokens: 100_000, maxOutputTokens: 8_000 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    source: "CONFIGURATION",
  };
  return {
    resolve: (ref) => ({ ...descriptor, ref }) as ModelDescriptor,
    has: () => true,
    list: () => [],
  } as ModelCatalog;
}

export type { ModelTurnExecutor };
