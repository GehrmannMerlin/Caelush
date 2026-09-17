import type {
  AIMessage,
  AIModelRequest,
  AIToolResultMessage,
  AIToolSpec,
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
import type {
  ToolBatchItemResult,
  ToolBatchOutcome,
  ToolBatchRequest,
  ToolBatchCoordinatorPort,
  ToolDispatchRequest,
} from "@caelush/tools";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  RunId,
  StepId,
  ToolDefinition,
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
 *                                              -> ToolBatchCoordinatorPort
 * ```
 *
 * The Tool Layer is stubbed at the *legacy* port — `ToolBatchCoordinatorPort` — and nowhere else, so
 * every production boundary between the Run Layer and that port is the real one: the frozen driver,
 * the real run-scoped adapter, the identity verification, the resource admission, the observation
 * projection and the typed settlement. That is what lets a test count what the Run Layer actually
 * did rather than what a mock was told to say.
 */

/** One recorded call to the legacy Tool batch port. */
export interface RecordedToolBatch {
  readonly operation: "execute" | "recover";
  readonly request: ToolBatchRequest;
}

/**
 * What the stubbed Tool Layer answers one batch with.
 *
 * It is the Tool Layer's *own* outcome type, not a test-local approximation: a stub that answered a
 * different shape would prove the adapter handles a shape production never produces.
 */
export type ToolBatchAnswer = ToolBatchOutcome;

/** One model-facing Tool result item, as the Tool Layer reports it. */
export function toolResultItem(input: {
  readonly externalCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError?: boolean;
  readonly invocationId?: string;
  readonly observationId?: string;
  readonly rawArtifactRef?: string;
}): ToolBatchItemResult {
  return {
    kind: "TOOL_RESULT",
    externalCallId: input.externalCallId,
    toolName: input.toolName,
    content: input.content,
    isError: input.isError ?? false,
    ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId as never }),
    ...(input.observationId === undefined ? {} : { observationId: input.observationId as never }),
    ...(input.rawArtifactRef === undefined ? {} : { rawArtifactRef: input.rawArtifactRef }),
  };
}

export interface StubToolBatches extends ToolBatchCoordinatorPort {
  readonly calls: RecordedToolBatch[];
  /** Physical Tool executions, as the Tool Layer would count them. */
  physicalExecutions: number;
  /**
   * What the Tool Layer answers, given the items it was asked about.
   *
   * It is a property rather than an override of `execute`, so the recorded call log stays the stub's
   * own account of what it was asked: a test that replaced `execute` would lose the very count these
   * tests are about.
   */
  answerWith: ToolBatchAnswer | ((items: readonly ItemLike[]) => ToolBatchAnswer);
  /** A value the next call throws, consumed once. A queued failure outranks the answer. */
  failures: unknown[];
}

/** The identity of one requested Tool call, as the legacy batch port carries it. */
export interface ItemLike {
  readonly externalCallId: string;
  readonly toolName: string;
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
  async function answer(operation: "execute" | "recover", request: ToolBatchRequest) {
    calls.push({ operation, request });
    const failure = state.failures.shift();
    if (failure !== undefined) throw failure;
    if (state.answerWith !== undefined) {
      return typeof state.answerWith === "function"
        ? state.answerWith(request.items)
        : state.answerWith;
    }
    const next = state.answers.length > 1 ? state.answers.shift()! : state.answers[0];
    return next ?? complete(request, "completion by default");
  }
  function complete(request: ToolBatchRequest, content: string): ToolBatchAnswer {
    return {
      kind: "COMPLETED",
      results: request.items.map((item, index) =>
        toolResultItem({
          externalCallId: item.externalCallId,
          toolName: item.toolName,
          content: `${content}:${item.externalCallId}`,
          invocationId: `tiv_0195f3a0-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
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
      return state.answerWith ?? complete({ items: [] } as never, "completion by default");
    },
    get failures() {
      return state.failures;
    },
    set failures(value: unknown[]) {
      state.failures = [...value];
    },
    modelDefinitions: (): readonly ToolDefinition[] => [],
    async execute(request) {
      state.physicalExecutions += 1;
      return answer("execute", request);
    },
    async recover(request) {
      return answer("recover", request);
    },
  } as StubToolBatches;
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
    toolCoordinator: toolBatches,
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

/** A `ToolDispatchRequest`-shaped view of one recorded batch, for identity assertions. */
export function recordedItems(batch: RecordedToolBatch): readonly ToolDispatchRequest[] {
  return batch.request.items.map((item) => ({ ...batch.request, ...item }) as ToolDispatchRequest);
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
