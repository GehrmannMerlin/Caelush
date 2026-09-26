import type {
  AIMessage,
  AIModelRequest,
  AIToolSpec,
  ModelCatalog,
  ModelDescriptor,
} from "@caelush/ai";
import type {
  CompletionGate,
  ContextEnginePort,
  ContextPrepareInput,
  ModelTurnExecutionResult,
  PreparedModelContext,
} from "@caelush/agent";
import { assertVerificationCheckTransition } from "@caelush/verification";
import type {
  TaskAcceptanceReview,
  TaskReviewBundle,
  VerificationCommittedEvent,
  VerificationExecutionRecoveryStorePort,
  VerificationExecutionSnapshot,
  VerificationGitDiff,
  VerificationGitPort,
  VerificationGitStatus,
  VerificationRepairPolicy,
  VerificationRunnerInput,
  VerificationRunnerResult,
  VerificationSettlementCommit,
  VerificationSettlementCommitResult,
  VerificationStartCommit,
  VerificationStartCommitResult,
  WorkspaceInspectionFacts,
  WorkspaceVerificationPort,
} from "@caelush/verification";
import type {
  AgentEvent,
  AgentRun,
  AgentState,
  FileChangeSummary,
  RunId,
  SessionId,
  StepId,
  TimestampMs,
  VerificationCheck,
  VerificationCheckId,
  VerificationEvidence,
  VerificationPlan,
  VerificationPlanId,
  VerificationPlanningInput,
} from "@caelush/protocol";
import {
  VerificationEvidenceSchema,
  createEventId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
} from "@caelush/protocol";

import {
  RunController,
  createCodingCompletionAssembly,
  createRunCompletionGate,
  type CompletionTaskReviewerPort,
  type DurableAgentEvent,
  type RunAgentExecutionContextFactory,
  type RunCompletionAssembly,
  type RunCompletionGateDependencies,
  type VerificationPlannerPort,
  type RunCompletionPersistencePort,
  type RunContinuationCheckpoint,
  type RunExecutionSnapshot,
} from "../../src/index.js";
import { fakeFrozenModelTurnExecutor } from "./run-agent-execution.js";
import { testRunMessageAuthority } from "./run-message-authority.js";
import { MemoryRunStore, makeRunD, turnMessages } from "./phase-3d-tool-turn.js";
import { modelTurnResult } from "./fake-model-turn-executor.js";

/**
 * The Phase 3E completion test harness.
 *
 * ```text
 * RunController -> openCompletionBoundary -> VERIFYING + AWAITING_VERIFICATION + plan
 *        ↓
 * Coordinator -> EVALUATE_COMPLETION -> RunExecutionDriver -> REAL CompletionGate
 *        ↓
 * verification workflow -> typed ACCEPT / REPAIR / REJECT / ERROR -> RunController settlement
 * ```
 *
 * Nothing between the Run Layer and the verification *ports* is stubbed. The frozen driver, the
 * run-scoped gate, the candidate-identity verification, the plan loader, the real
 * `VerificationStageRunner`, the real workspace / Git / task-review evidence builders, the real
 * evaluator, the real freshness recheck, the real Phase 11D completion authority and the typed
 * settlement router are all production code. Only the host-facing ports a real host supplies are
 * stubs: the workspace inspector, the Git reader, the task reviewer, the project-check runner and the
 * verification execution store.
 *
 * That is what lets a test ask what the Run Layer *did* — how many provider turns it made, how many
 * times a durable check was executed, what it committed — instead of what a mock was told to say.
 */

/* ----------------------------------------------- verification execution store */

/**
 * The durable verification execution, in memory.
 *
 * It answers the same `VerificationExecutionRecoveryStorePort` the SQLite store answers, and enforces
 * the property these tests depend on: a check transitions through its lifecycle exactly once, settled
 * evidence is immutable, and a recovery finds whatever was already durable.
 */
export interface MemoryVerificationStore extends VerificationExecutionRecoveryStorePort {
  /** The plans the candidate boundary committed, keyed by plan id. */
  readonly plans: Map<string, VerificationPlan>;
  /** Every evidence row, in capture order. */
  readonly evidence: VerificationEvidence[];
  /** Check ids whose `startCheck` was accepted, in order. */
  readonly started: VerificationCheckId[];
  /** Check ids whose `settleCheck` was accepted, in order. */
  readonly settled: VerificationCheckId[];
  /** Write the durable plan a candidate boundary would have written. */
  seed(plan: VerificationPlan): void;
  /** The check a plan currently holds, or `undefined`. */
  check(planId: VerificationPlanId, checkId: VerificationCheckId): VerificationCheck | undefined;
  /** How many times this plan's checks were settled. */
  settlements(planId: VerificationPlanId): number;
  /** How many plans this Run has been through — the one authority for "which repair cycle is this". */
  countPlans(runId: RunId): Promise<number>;
}

export function memoryVerificationStore(input: {
  readonly nextSequence: () => number;
  readonly runId: RunId;
  readonly sessionId: SessionId;
}): MemoryVerificationStore {
  const plans = new Map<string, VerificationPlan>();
  const evidence: VerificationEvidence[] = [];
  const started: VerificationCheckId[] = [];
  const settled: VerificationCheckId[] = [];
  const settlements = new Map<string, number>();

  function require(planId: VerificationPlanId): VerificationPlan {
    const plan = plans.get(planId);
    if (plan === undefined) throw new Error(`unknown verification plan ${planId}`);
    return plan;
  }
  function requireCheck(plan: VerificationPlan, checkId: VerificationCheckId): VerificationCheck {
    const check = plan.checks.find((item) => item.id === checkId);
    if (check === undefined) throw new Error(`unknown verification check ${checkId}`);
    return check;
  }
  function replace(plan: VerificationPlan, check: VerificationCheck): void {
    plans.set(plan.id, {
      ...plan,
      checks: plan.checks.map((item) => (item.id === check.id ? check : item)),
    });
  }
  function committed(
    type: "verification.check.started" | "verification.check.completed",
    payload: Record<string, unknown>,
    timestamp: number,
  ): VerificationCommittedEvent {
    const draft = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: input.runId,
      sessionId: input.sessionId,
      timestamp: timestamp as unknown as AgentEvent["timestamp"],
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: input.nextSequence() },
      type,
      payload,
    };
    return draft as unknown as VerificationCommittedEvent;
  }

  return {
    plans,
    evidence,
    started,
    settled,
    seed(plan) {
      plans.set(plan.id, plan);
    },
    check(planId, checkId) {
      return plans.get(planId)?.checks.find((item) => item.id === checkId);
    },
    settlements(planId) {
      return settlements.get(planId) ?? 0;
    },
    async startCheck(commit: VerificationStartCommit): Promise<VerificationStartCommitResult> {
      const plan = require(commit.check.planId);
      const current = requireCheck(plan, commit.check.id);
      if (
        current.status === "RUNNING" &&
        JSON.stringify(current) === JSON.stringify(commit.check)
      ) {
        return { check: current, events: [] };
      }
      if (current.status !== "PENDING") throw new Error("verification check is not pending");
      assertVerificationCheckTransition(current, commit.check);
      const discovery = VerificationEvidenceSchema.parse(commit.discoveryEvidence);
      replace(plan, commit.check);
      evidence.push(discovery);
      started.push(commit.check.id);
      return {
        check: commit.check,
        events: [
          committed(
            "verification.check.started",
            {
              planId: commit.check.planId,
              checkId: commit.check.id,
              ordinal: commit.check.ordinal,
              kind: commit.check.spec.kind,
              purpose: commit.check.spec.purpose,
              stage: commit.check.stage,
            },
            discovery.capturedAt,
          ),
        ],
      };
    },
    async settleCheck(
      commit: VerificationSettlementCommit,
    ): Promise<VerificationSettlementCommitResult> {
      const plan = require(commit.check.planId);
      const current = requireCheck(plan, commit.check.id);
      if (isTerminal(current.status)) {
        if (JSON.stringify(current) === JSON.stringify(commit.check)) {
          return { check: current, events: [] };
        }
        throw new Error("verification check is already settled");
      }
      assertVerificationCheckTransition(current, commit.check);
      const rows = commit.evidence.map((item) => VerificationEvidenceSchema.parse(item));
      replace(plan, commit.check);
      evidence.push(...rows);
      settled.push(commit.check.id);
      settlements.set(plan.id, (settlements.get(plan.id) ?? 0) + 1);
      return {
        check: commit.check,
        events: [
          committed(
            "verification.check.completed",
            {
              planId: commit.check.planId,
              checkId: commit.check.id,
              status: commit.check.status,
              evidenceIds: rows.map((row) => row.id),
              durationMs:
                commit.check.startedAt === undefined || commit.check.finishedAt === undefined
                  ? undefined
                  : commit.check.finishedAt - commit.check.startedAt,
            },
            rows[0]?.capturedAt ?? commit.check.finishedAt ?? 0,
          ),
        ],
      };
    },
    async getPlanExecutionSnapshot(
      planId: VerificationPlanId,
    ): Promise<VerificationExecutionSnapshot | null> {
      const plan = plans.get(planId);
      if (plan === undefined) return null;
      return { plan, evidence: evidence.filter((row) => row.planId === planId) };
    },
    async countPlans(runId: RunId): Promise<number> {
      let count = 0;
      for (const plan of plans.values()) if (plan.runId === runId) count += 1;
      return count;
    },
  };
}

function isTerminal(status: VerificationCheck["status"]): boolean {
  return (
    status === "PASSED" ||
    status === "FAILED" ||
    status === "ERROR" ||
    status === "SKIPPED" ||
    status === "CANCELLED"
  );
}

/* --------------------------------------------------------------- plan facts */

/** One check a stubbed planner asks for, before the host mints its identity. */
export interface PlannedCheck {
  readonly kind: VerificationCheck["spec"]["kind"];
  readonly requirement: VerificationCheck["requirement"];
  readonly stage: VerificationCheck["stage"];
}

/** The default matrix a coding Run needs: an independent acceptance review, and nothing else. */
export const TASK_ONLY: readonly PlannedCheck[] = [
  { kind: "TASK", requirement: "REQUIRED", stage: "ACCEPTANCE" },
];

export const WORKSPACE_AND_TASK: readonly PlannedCheck[] = [
  { kind: "WORKSPACE", requirement: "REQUIRED", stage: "CHANGE_REVIEW" },
  { kind: "TASK", requirement: "REQUIRED", stage: "ACCEPTANCE" },
];

export function planDraft(checks: readonly PlannedCheck[]): {
  readonly plannerVersion: string;
  readonly planHash: string;
  readonly checks: {
    readonly ordinal: number;
    readonly stage: VerificationCheck["stage"];
    readonly requirement: VerificationCheck["requirement"];
    readonly spec: VerificationCheck["spec"];
  }[];
} {
  return {
    plannerVersion: "phase-3e.test",
    planHash: "b".repeat(64),
    checks: checks.map((check, ordinal) => ({
      ordinal,
      stage: check.stage,
      requirement: check.requirement,
      spec:
        check.kind === "PROJECT"
          ? { kind: check.kind, purpose: "TEST" as const, source: "SYSTEM" as const }
          : check.kind === "TASK"
            ? { kind: check.kind, purpose: "ACCEPTANCE" as const, source: "SYSTEM" as const }
            : check.kind === "WORKSPACE"
              ? {
                  kind: check.kind,
                  purpose: "CHANGESET_SANITY" as const,
                  source: "SYSTEM" as const,
                }
              : {
                  kind: check.kind,
                  purpose: "CHANGESET_REVIEW" as const,
                  source: "SYSTEM" as const,
                },
    })),
  };
}

/* -------------------------------------------------------------------- stubs */

/** What the task reviewer answers one review with. */
export type ReviewAnswer =
  | { readonly status: "PASSED"; readonly verdict?: "PASS" }
  | {
      readonly status: "FAILED";
      readonly verdict?: "FAIL";
      readonly repairInstructions?: readonly string[];
    }
  | { readonly status: "ERROR"; readonly errorCode?: string };

export interface StubReviewer extends CompletionTaskReviewerPort {
  /** Every bundle the reviewer was handed, in order. */
  readonly bundles: TaskReviewBundle[];
  /** The Run each review was attributed to, in call order. */
  readonly runs: RunId[];
  answerWith: ReviewAnswer | ((bundle: TaskReviewBundle) => ReviewAnswer);
  /** Run before the answer is produced — the hook a test uses to change the world mid-review. */
  onReview?: (bundle: TaskReviewBundle) => void | Promise<void>;
}

export function stubReviewer(
  answerWith: ReviewAnswer | ((bundle: TaskReviewBundle) => ReviewAnswer) = { status: "PASSED" },
): StubReviewer {
  const bundles: TaskReviewBundle[] = [];
  const runs: RunId[] = [];
  const state: { answerWith: typeof answerWith } = { answerWith };
  const stub: StubReviewer = {
    bundles,
    runs,
    get answerWith() {
      return state.answerWith;
    },
    set answerWith(value) {
      state.answerWith = value;
    },
    async review(input) {
      // The Run the review belongs to is an explicit argument, so recording it is how a test proves a
      // review was attributed to the Run that asked for it rather than to whichever Run ran first.
      runs.push(input.run.id);
      bundles.push(input.bundle);
      await stub.onReview?.(input.bundle);
      const answer =
        typeof state.answerWith === "function" ? state.answerWith(input.bundle) : state.answerWith;
      const review: TaskAcceptanceReview | undefined =
        answer.status === "ERROR"
          ? undefined
          : {
              verdict: answer.verdict ?? (answer.status === "PASSED" ? "PASS" : "FAIL"),
              summary:
                answer.status === "PASSED" ? "the goal is satisfied" : "the goal is not satisfied",
              ...(answer.status === "FAILED" && answer.repairInstructions !== undefined
                ? { repairInstructions: [...answer.repairInstructions] }
                : {}),
            };
      return {
        status: answer.status,
        ...(review === undefined ? {} : { review }),
        reviewInputHash: input.bundle.reviewInputHash,
        ...(answer.status === "ERROR" ? { errorCode: answer.errorCode ?? "REVIEWER_ERROR" } : {}),
      };
    },
  };
  return stub;
}

export interface StubWorkspace extends WorkspaceVerificationPort {
  /** How many inspections the workspace port was asked for. */
  readonly inspections: number;
  facts: WorkspaceInspectionFacts | ((call: number) => WorkspaceInspectionFacts);
}

export function stubWorkspace(
  facts: WorkspaceInspectionFacts | ((call: number) => WorkspaceInspectionFacts) = {
    inspectionComplete: true,
    paths: [],
  },
): StubWorkspace {
  const state = { calls: 0, facts };
  return {
    get inspections() {
      return state.calls;
    },
    get facts() {
      return state.facts;
    },
    set facts(value) {
      state.facts = value;
    },
    async inspect() {
      state.calls += 1;
      return typeof state.facts === "function" ? state.facts(state.calls) : state.facts;
    },
  };
}

export interface StubGit extends VerificationGitPort {
  readonly statusCalls: number;
  readonly diffCalls: number;
  statusWith: VerificationGitStatus | ((call: number) => VerificationGitStatus);
  diffWith: VerificationGitDiff | ((path: string) => VerificationGitDiff);
}

export function stubGit(
  statusWith: VerificationGitStatus | ((call: number) => VerificationGitStatus) = {
    available: false,
  },
  diffWith: VerificationGitDiff | ((path: string) => VerificationGitDiff) = (path) => ({
    path,
    diff: "",
    truncated: false,
  }),
): StubGit {
  const state = { statusCalls: 0, diffCalls: 0, statusWith, diffWith };
  return {
    get statusCalls() {
      return state.statusCalls;
    },
    get diffCalls() {
      return state.diffCalls;
    },
    get statusWith() {
      return state.statusWith;
    },
    set statusWith(value) {
      state.statusWith = value;
    },
    get diffWith() {
      return state.diffWith;
    },
    set diffWith(value) {
      state.diffWith = value;
    },
    async status() {
      state.statusCalls += 1;
      return typeof state.statusWith === "function"
        ? state.statusWith(state.statusCalls)
        : state.statusWith;
    },
    async diff(request) {
      state.diffCalls += 1;
      return typeof state.diffWith === "function" ? state.diffWith(request.path) : state.diffWith;
    },
  };
}

/** The project-check runner, counted rather than implemented. */
export interface StubProjectRunner {
  readonly runs: VerificationRunnerInput[];
  run(input: VerificationRunnerInput): Promise<VerificationRunnerResult>;
}

export function stubProjectRunner(): StubProjectRunner {
  const runs: VerificationRunnerInput[] = [];
  return {
    runs,
    async run(input) {
      runs.push(input);
      return {
        outcome: "PROJECT_CHECKS_PASSED",
        executedCount: 0,
        passedCount: 0,
        failedCount: 0,
        errorCount: 0,
        skippedCount: 0,
      };
    },
  };
}

/* ----------------------------------------------------------------- harness */

export interface Phase3EHarness {
  readonly controller: RunController;
  readonly store: MemoryRunStore;
  readonly verification: MemoryVerificationStore;
  readonly notifications: DurableAgentEvent[];
  readonly turns: { readonly request: AIModelRequest }[];
  readonly workspace: StubWorkspace;
  readonly git: StubGit;
  readonly reviewer: StubReviewer;
  readonly projectRunner: StubProjectRunner;
  readonly plannerInputs: VerificationPlanningInput[];
  readonly verified: { readonly run: AgentRun; readonly finalResult: unknown }[];
  readonly allocatedSteps: StepId[];
  /** The Run, as the store the Run Layer actually wrote to holds it. */
  snapshot(): RunExecutionSnapshot;
  /** Every durable event type the Run published, in sequence order. */
  eventTypes(): readonly string[];
}

export interface Phase3EHarnessOptions {
  readonly run?: AgentRun;
  readonly snapshot?: Partial<RunExecutionSnapshot>;
  readonly script: (call: number) => ModelTurnExecutionResult | Promise<ModelTurnExecutionResult>;
  readonly checks?: readonly PlannedCheck[];
  readonly workspace?: StubWorkspace;
  readonly git?: StubGit;
  readonly reviewer?: StubReviewer;
  readonly projectRunner?: StubProjectRunner;
  readonly repairPolicy?: VerificationRepairPolicy;
  readonly planCount?: (runId: RunId) => Promise<number>;
  /** Compose the completion persistence port; `false` models a host with no coding completion path. */
  readonly persistence?:
    boolean | ((port: RunCompletionPersistencePort) => RunCompletionPersistencePort);
  /** Compose the verification execution store; `false` models a host that composed it out. */
  readonly verificationStore?: boolean;
  /**
   * Which completion composition the Run Layer is built with.
   *
   * ```text
   * LEGACY_FLAT         the flat Phase 3E verification* fields (the default, so every existing test
   *                     keeps exercising the declared compatibility path)
   * CANONICAL_ASSEMBLY  the converged `completion:` port, and no flat field at all
   * ```
   *
   * Both must reach the *same* assembly implementation; `CANONICAL_ASSEMBLY` is what proves the
   * production-shaped path works on its own rather than only through the compatibility projection.
   */
  readonly composition?: "LEGACY_FLAT" | "CANONICAL_ASSEMBLY";
  /**
   * The clock the Run Layer *and* the completion assembly read.
   *
   * Supplying one is what lets a test move the Run past its deadline while a completion evaluation is
   * in flight: the deadline authority and the gate must be looking at the same time, or the test would
   * be measuring a disagreement it created itself.
   */
  readonly clock?: { now(): TimestampMs };
  /** Counts every completion commit the Run Layer asks the persistence port for. */
  readonly commits?: CompletionCommitCounter;
  readonly onVerifiedCompletion?: (input: {
    readonly run: AgentRun;
    readonly finalResult: unknown;
  }) => void;
  readonly extra?: Record<string, unknown>;
}

/** How many times each completion commit was attempted. CAS conflicts are attempts too. */
export interface CompletionCommitCounter {
  candidateBoundaries: number;
  verifiedCompletions: number;
  plansLoaded: number;
}

let clockTick = 100;

export function harness3e(options: Phase3EHarnessOptions): Phase3EHarness {
  const run = options.run ?? makeRunD();
  const store = new MemoryRunStore({ run, conversationRecords: [], ...options.snapshot });
  const messages = testRunMessageAuthority({ snapshot: () => store.snapshot });
  const notifications: DurableAgentEvent[] = [];
  const allocatedSteps: StepId[] = [];
  const turns: { readonly request: AIModelRequest }[] = [];
  const verified: { readonly run: AgentRun; readonly finalResult: unknown }[] = [];
  const plannerInputs: VerificationPlanningInput[] = [];
  const sequence = { value: 0 };
  const verification = memoryVerificationStore({
    nextSequence: () => ++sequence.value,
    runId: run.id,
    sessionId: run.sessionId,
  });
  const workspace = options.workspace ?? stubWorkspace();
  const git = options.git ?? stubGit();
  const reviewer = options.reviewer ?? stubReviewer();
  const projectRunner = options.projectRunner ?? stubProjectRunner();
  const checks = options.checks ?? TASK_ONLY;
  const contextEngine = policyContextEngine();
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

  const basePersistence: RunCompletionPersistencePort = {
    loadVerificationPlan: (runId, planId) => {
      if (options.commits !== undefined) options.commits.plansLoaded += 1;
      return store.loadVerificationPlan(runId, planId);
    },
    commitCandidateBoundary: (command) => {
      if (options.commits !== undefined) options.commits.candidateBoundaries += 1;
      // Production writes the plan row and the Run continuation in one SQLite transaction, and the
      // verification execution store reads the plan back from that same database. Two in-memory
      // objects have to be told the same thing explicitly: the boundary opens the plan, and the
      // execution store is where verification then finds it.
      verification.seed(command.verificationPlan);
      return store.commitCandidateBoundary(command);
    },
    commitVerifiedCompletion: (command) => {
      if (options.commits !== undefined) options.commits.verifiedCompletions += 1;
      return store.commitVerifiedCompletion(command);
    },
  };
  const persistence =
    options.persistence === false
      ? undefined
      : typeof options.persistence === "function"
        ? options.persistence(basePersistence)
        : basePersistence;

  /**
   * The same host facts, grouped the way a production composition groups them.
   *
   * It is deliberately built from the harness's own fixtures rather than from the flat fields, so a
   * canonical-composition test cannot accidentally pass because the compatibility path supplied
   * something the assembly would not have had.
   */
  const clock = options.clock ?? { now: () => createTimestampMs(++clockTick) };
  const resolver = {
    resolve: async () => ({ baseSystemPrompt: "base", contextLimits: { maxInputTokens: 1000 } }),
  };
  const planner: VerificationPlannerPort = {
    plan: (input: VerificationPlanningInput) => {
      plannerInputs.push(input);
      return { ...planDraft(checks), runId: input.runId, sourceStepId: input.sourceStepId };
    },
  };
  const assemblyFacts = {
    clock,
    configResolver: resolver,
    planner,
    planIdFactory: createVerificationPlanId,
    checkIdFactory: createVerificationCheckId,
    evidenceIdFactory: createVerificationEvidenceId,
    runner: projectRunner,
    workspace,
    git,
    reviewer,
  } satisfies Parameters<typeof createCodingCompletionAssembly>[0];

  const canonical = options.composition === "CANONICAL_ASSEMBLY";
  const completionPort: RunCompletionAssembly | undefined = canonical
    ? createCodingCompletionAssembly({
        ...assemblyFacts,
        planCount: options.planCount ?? (async (runId: RunId) => verification.countPlans(runId)),
        ...(options.repairPolicy === undefined ? {} : { repairPolicy: options.repairPolicy }),
        ...(options.verificationStore === false
          ? {}
          : { executionStore: verification, executionRecovery: verification }),
      })
    : undefined;

  const controller = new RunController({
    agentExecution: execution,
    executionStore: store,
    ...(persistence === undefined ? {} : { completionStore: persistence }),
    ...(completionPort === undefined ? {} : { completion: completionPort }),
    events: {
      notifyCommitted: (events: readonly DurableAgentEvent[]) => notifications.push(...events),
      emitTransient: () => undefined,
    },
    configResolver: {
      resolve: async () => ({ baseSystemPrompt: "base", contextLimits: { maxInputTokens: 1000 } }),
    },
    messages,
    clock,
    eventIdFactory: { create: createEventId },
    ...(canonical
      ? {}
      : {
          verificationPlanner: planner,
          verificationPlanIdFactory: { create: createVerificationPlanId },
          verificationCheckIdFactory: { create: createVerificationCheckId },
          verificationEvidenceIdFactory: createVerificationEvidenceId,
          verificationRunner: projectRunner,
          verificationWorkspace: workspace,
          verificationGit: git,
          verificationReviewer: reviewer,
          verificationPlanCount:
            options.planCount ?? (async (runId: RunId) => verification.countPlans(runId)),
          ...(options.repairPolicy === undefined
            ? {}
            : { verificationRepairPolicy: options.repairPolicy }),
          ...(options.verificationStore === false
            ? {}
            : {
                verificationExecutionStore: verification,
                verificationExecutionRecovery: verification,
              }),
        }),
    onVerifiedCompletion: (input: { run: AgentRun; finalResult: unknown }) => {
      verified.push({ run: input.run, finalResult: input.finalResult });
      options.onVerifiedCompletion?.(input);
    },
    ...options.extra,
  } as never);

  return {
    controller,
    store,
    verification,
    notifications,
    turns,
    workspace,
    git,
    reviewer,
    projectRunner,
    plannerInputs,
    verified,
    allocatedSteps,
    snapshot: () => store.snapshot,
    eventTypes: () => notifications.map((event) => event.type),
  };
}

/* ----------------------------------------------------------------- helpers */

/**
 * A completion gate bound to the durable facts a parked Run is holding.
 *
 * ```text
 * the Run Layer derives these facts once, for one evaluation
 *        ↓
 * this rebuilds exactly that capture, so a test can call the gate directly
 * ```
 *
 * It exists for the checks the Run Layer cannot perform on itself: the frozen `CompletionGateInput`
 * is validated against the durable Run, and only a caller that hands the gate a *different* identity,
 * Step or candidate can exercise that refusal. A controller-driven evaluation always agrees with its
 * own snapshot, which is the point — and the reason this seam is needed to test the disagreement.
 */
export function completionGateOver(
  harness: Phase3EHarness,
  overrides: Partial<RunCompletionGateDependencies> = {},
): {
  readonly gate: CompletionGate;
  readonly dependencies: RunCompletionGateDependencies;
} {
  const snapshot = harness.store.snapshot;
  if (snapshot.state === undefined) throw new Error("the parked Run has no AgentState");
  const continuation = snapshot.continuation;
  if (continuation?.type !== "AWAITING_VERIFICATION") {
    throw new Error("the parked Run has no verification boundary");
  }
  const dependencies: RunCompletionGateDependencies = {
    run: snapshot.run,
    state: snapshot.state,
    continuation,
    mode: "EXECUTE",
    signal: new AbortController().signal,
    clock: { now: () => createTimestampMs(++clockTick) },
    persistence: {
      loadVerificationPlan: (runId, planId) => harness.store.loadVerificationPlan(runId, planId),
      commitCandidateBoundary: (command) => harness.store.commitCandidateBoundary(command),
      commitVerifiedCompletion: (command) => harness.store.commitVerifiedCompletion(command),
    },
    configResolver: {
      resolve: async () => ({ baseSystemPrompt: "base", contextLimits: { maxInputTokens: 1000 } }),
    },
    reviewer: harness.reviewer,
    workspace: harness.workspace,
    git: harness.git,
    executionStore: harness.verification,
    executionRecovery: harness.verification,
    evidenceIdFactory: createVerificationEvidenceId,
    notifyCommitted: () => undefined,
    ...overrides,
  };
  return { gate: createRunCompletionGate(dependencies).gate, dependencies };
}

/** One provider turn that answers with a final candidate. */
export function candidateTurn(text: string): ModelTurnExecutionResult {
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

/** The verification continuation a Run is parked on, or a thrown description of why it is not. */
export function awaitingVerification(
  harness: Phase3EHarness,
): Extract<
  NonNullable<RunExecutionSnapshot["continuation"]>,
  { readonly type: "AWAITING_VERIFICATION" }
> {
  const continuation = harness.store.snapshot.continuation;
  if (continuation?.type !== "AWAITING_VERIFICATION") {
    throw new Error(`the Run is not awaiting verification (${String(continuation?.type)})`);
  }
  return continuation;
}

/**
 * The repair boundary a Run committed, read from the ledger.
 *
 * A repair returns the Run to `RUNNING` and hands it another Reason, so by the time a drive ends the
 * live continuation is usually a different one. The durable commit is where the repair boundary
 * survives, and that is what a test about repair provenance has to read.
 */
export function committedRepairBoundary(harness: Phase3EHarness): {
  readonly checkpoint: Extract<
    RunContinuationCheckpoint,
    { readonly type: "WAITING_VERIFICATION_REPAIR" }
  >;
  readonly run: AgentRun;
} {
  for (const commit of harness.store.commits) {
    const write = commit.continuation;
    if (write?.operation !== "SET") continue;
    const checkpoint = write.checkpoint;
    if (checkpoint.type !== "WAITING_VERIFICATION_REPAIR") continue;
    return { checkpoint, run: commit.run };
  }
  throw new Error("the Run never committed a verification repair boundary");
}

/** The state the Run Layer currently holds. */
export function stateOf(harness: Phase3EHarness): AgentState | undefined {
  return harness.store.snapshot.state;
}

export function changedFile(
  path: string,
  changeType: FileChangeSummary["changeType"] = "MODIFIED",
): FileChangeSummary {
  return { path, changeType };
}

/* ------------------------------------------------------------- test doubles */

function policyContextEngine(): ContextEnginePort {
  return {
    async prepare(input: ContextPrepareInput): Promise<PreparedModelContext> {
      return {
        messages: [...turnMessages(input)],
        report: {
          estimatedInputTokens: 1,
          effectiveInputLimitTokens: input.model.limits.contextWindowTokens,
          remainingTokens: input.model.limits.contextWindowTokens - 1,
          pressure: "NORMAL",
          compactionCount: 0,
          requestOverheadTokens: 0,
          contributions: [],
        },
        observationPolicy: {
          maxSingleObservationTokens: 4_000,
          maxObservationBatchTokens: 12_000,
        },
      };
    },
  };
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

export type { AIMessage };
