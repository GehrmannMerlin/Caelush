import {
  ApprovalRequestSchema,
  type JsonObject,
  type ToolInvocation,
  type ToolName,
} from "@caelush/protocol";
import {
  createDurableToolExecutionCoordinator,
  createToolAdmissionCoordinator,
  createToolFailureSettlement,
  ToolCallBusyError,
  ToolExecutionAbortedError,
  ToolExecutionInfrastructureError,
  createToolCallPreparer,
  createToolFailedEvent,
  createToolObservation,
  createToolRequestedEvent,
  createRequestedToolInvocation,
  failToolInvocation,
  type DurableToolExecutionCoordinator,
  type DurableToolExecutionOutcome,
  type PreparedToolCall,
  type ToolAdmissionCoordinator,
  type ToolAdmissionPreCheck,
  type ToolApprovalRequestFactory,
  type ToolArgumentNormalization,
  type ToolCallPreparer,
  type ToolDurableMetadataPort,
  type ToolExecutionUpdateSanitizerPort,
  type ToolInvocationExecutor,
  type ToolResultPipeline,
  type TransientToolUpdateConsumer,
  type TransientToolUpdateDiagnostics,
  type ToolSettlementExtensionProjector,
} from "@caelush/agent";
import {
  assertToolDispatchRequest,
  DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
  DEFAULT_MAX_INVOCATION_ARGS_BYTES,
  DEFAULT_APPROVAL_TTL_MS,
  type ToolDispatchRequest,
  type ToolDispatcherOutcome,
  type ToolApprovalRequestIdFactory,
  type ToolClock,
  type ToolEventIdFactory,
  type ToolInvocationIdFactory,
  type ToolObservationIdFactory,
} from "./dispatcher-types.js";
import {
  ToolDispatcherBusyError,
  ToolDispatcherInfrastructureError,
  ToolDispatcherInvariantError,
} from "./dispatcher-errors.js";
import type {
  ToolBudgetAdmission,
  ToolApprovalLookupPort,
  ToolBudgetPorts,
  ToolCommittedEventNotifier,
  ToolExecutionGatePort,
} from "./dispatcher-ports.js";
import { ToolExecutionConflictError, type ToolExecutionStorePort } from "./execution-store.js";
import type { ToolOutputPolicy } from "./output-policy.js";
import { boundToolModelContent, DEFAULT_TOOL_OUTPUT_POLICY } from "./output-policy.js";
import { cloneJsonValue, canonicalJsonString, jsonUtf8ByteLength } from "./json-canonical.js";
import type { ResolvedTool, ToolRegistry } from "./registry.js";
import type { ToolPresentationPort } from "./presentation.js";
import {
  assertToolExecutionEnvironment,
  type ToolExecutionEnvironment,
} from "./execution-environment.js";
import { assertToolSecurityContext, type ToolSecurityContext } from "./security-context.js";
import { ToolPreflight, type ToolPreflightResult } from "./preflight.js";
import {
  createToolFailureMemoryPreCheck,
  TOOL_FAILURE_MEMORY_CODE,
  ToolFailureMemory,
} from "./tool-failure-memory.js";
import type { ToolCallingDebugEvent, ToolCallingDebugPort } from "./debug.js";
import type { ToolResultSanitizerPort } from "./result-sanitizer.js";
import { createLegacyToolSettlementExtensionProjector } from "./settlement-extension-bridge.js";
import { toolEffectsToEvents } from "./tool-effects.js";
import {
  createCodingToolAdmissionPort,
  createCodingToolDurableMetadataPort,
  createDurableInvocationGatePort,
} from "./tool-admission-adapter.js";
import { toCanonicalApprovalLookup } from "./approval-lookup-adapter.js";
import { toCanonicalToolBudgetPort } from "./tool-budget-adapter.js";
import {
  toLegacyToolExecutionStore as toLegacyToolExecutionStoreAdapter,
  type LegacyToolExecutionStorePort,
} from "./tool-execution-store-compatibility.js";

/**
 * The Agent Tool execution factories, imported once and named in one place.
 *
 * They arrive as a namespace binding rather than being re-declared here, so this file cannot drift into
 * holding a second execution or result algorithm: every identifier below resolves to the Phase 4B
 * implementation.
 */
import * as agentToolExecution from "@caelush/agent";

/* ------------------------------------------------------------------------------------------------
 * Canonical execution dependencies
 * ---------------------------------------------------------------------------------------------- */

/** Builds the canonical executor for one durable invocation. */
export type ToolInvocationExecutorFactory = (input: {
  readonly invocation: ToolInvocation;
  readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
}) => ToolInvocationExecutor;

/** Builds the canonical result pipeline for one durable settlement. */
export type ToolResultPipelineFactory = (input: {
  readonly invocation: ToolInvocation;
  readonly environment: ToolExecutionEnvironment;
  /**
   * The Session the Run belongs to, when the caller knows it.
   *
   * An invocation carries its Run and Step but not its Session, and a host-domain effect event needs
   * one. The durable coordinator knows it from the snapshot it committed and passes it here; a host
   * that produces no effect events does not need it at all.
   */
  readonly sessionId?: import("@caelush/protocol").SessionId | undefined;
}) => ToolResultPipeline;

/** Everything `createToolExecutionDependencies` needs to assemble the canonical execution pair. */
export interface ToolExecutionDependenciesOptions {
  readonly registry: ToolRegistry;
  /**
   * The durable event identity factory the settlement uses.
   *
   * Effect events and the terminal event are drawn from one sequence, so a host sees one ordered
   * chronology rather than two interleaved ones. Absent means this composition contributes no effect
   * events; the effects themselves are unaffected.
   */
  readonly eventIdFactory?: { create(): import("@caelush/protocol").EventId } | undefined;
  /** Optional safe, presentation-only projection. A presenter can never alter an outcome. */
  readonly presentation?: ToolPresentationPort | undefined;
  /** The real result sanitizer. Absent means the canonical identity sanitizer. */
  readonly resultSanitizer?: ToolResultSanitizerPort | undefined;
  /** The real transient update sanitizer. Absent means transient updates are dropped. */
  readonly updateSanitizer?: ToolExecutionUpdateSanitizerPort | undefined;
  readonly transientUpdates?: TransientToolUpdateConsumer | undefined;
  readonly updateDiagnostics?: TransientToolUpdateDiagnostics | undefined;
  /** Legacy output policy; its content budget maps onto the canonical durable content bound. */
  readonly outputPolicy?: ToolOutputPolicy | undefined;
}

/**
 * The canonical execution pair, bound for the durable coordinator.
 *
 * ```text
 * invocationExecutorFactory  createToolInvocationExecutor, bound per invocation
 * updateSanitizer            the caller's sanitizer, or a drop-everything default
 * resultPipelineFactory      createToolResultPipeline with the sanitizer, limits and effect bridge
 * ```
 *
 * This is the one place a host's execution pair is described, so a production composition and a test
 * composition differ only in which sanitizers they inject — never in how execution or result processing
 * works. Phase 4B built the pair; Phase 4C only changed *who calls it*, and the answer is now the
 * canonical durable coordinator rather than this facade.
 */
export function createToolExecutionDependencies(options: ToolExecutionDependenciesOptions): {
  readonly outputPolicy: ToolOutputPolicy;
  readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
  readonly invocationExecutorFactory: ToolInvocationExecutorFactory;
  readonly resultPipelineFactory: ToolResultPipelineFactory;
} {
  const updateSanitizer: ToolExecutionUpdateSanitizerPort =
    options.updateSanitizer ?? DROP_EVERY_TRANSIENT_UPDATE;
  const outputPolicy = options.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY;
  return Object.freeze({
    outputPolicy,
    invocationExecutorFactory: ({ invocation, updateSanitizer: bound }) =>
      createInvocationExecutor({
        invocation,
        updateSanitizer: bound,
        ...(options.transientUpdates === undefined
          ? {}
          : { transientUpdates: options.transientUpdates }),
        ...(options.updateDiagnostics === undefined
          ? {}
          : { diagnostics: options.updateDiagnostics }),
      }),
    updateSanitizer,
    resultPipelineFactory: ({ invocation, environment, sessionId }) =>
      createResultPipeline({
        ...(options.resultSanitizer === undefined ? {} : { sanitizer: options.resultSanitizer }),
        ...(options.outputPolicy === undefined
          ? {}
          : {
              limits: {
                maxDurableContentBytes: options.outputPolicy.maxModelContentBytes,
                maxDetailsBytes: options.outputPolicy.maxDetailsBytes,
              },
            }),
        settlementExtension: createLegacyToolSettlementExtensionProjector({
          registry: options.registry,
          invocation: {
            invocation,
            ...(sessionId === undefined ? {} : { sessionId }),
            environment,
            ...(options.eventIdFactory === undefined
              ? {}
              : { nextEventId: () => options.eventIdFactory!.create() }),
            ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
          },
          effectsPayload: (effects) => {
            return { effects: effects as unknown as never };
          },
          ...(options.eventIdFactory === undefined
            ? {}
            : {
                effectEvents: (
                  effects,
                  context: {
                    readonly sessionId: import("@caelush/protocol").SessionId;
                    readonly nextEventId: () => import("@caelush/protocol").EventId;
                  },
                ) =>
                  toolEffectsToEvents(effects, {
                    runId: invocation.runId,
                    sessionId: context.sessionId,
                    stepId: invocation.stepId,
                    timestamp: (invocation.finishedAt ?? invocation.createdAt) as never,
                    nextEventId: context.nextEventId,
                    invocation,
                    ...(options.presentation === undefined
                      ? {}
                      : { presentation: options.presentation }),
                  }),
              }),
        }),
      }),
  });
}

const createInvocationExecutor: (input: {
  readonly invocation: ToolInvocation;
  readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
  readonly transientUpdates?: TransientToolUpdateConsumer | undefined;
  readonly diagnostics?: TransientToolUpdateDiagnostics | undefined;
}) => ToolInvocationExecutor = agentToolExecution.createToolInvocationExecutor;

const createResultPipeline: (input: {
  readonly sanitizer?: ToolResultSanitizerPort | undefined;
  readonly limits?: { readonly maxDurableContentBytes: number; readonly maxDetailsBytes: number };
  readonly settlementExtension?: ToolSettlementExtensionProjector | undefined;
}) => ToolResultPipeline = agentToolExecution.createToolResultPipeline;

/**
 * The sanitizer a composition gets when it declares none.
 *
 * It refuses every update, which the executor turns into a drop. There is no "forward the raw update"
 * branch anywhere in the pipeline, so an unconfigured host loses progress output and leaks nothing.
 */
const DROP_EVERY_TRANSIENT_UPDATE: ToolExecutionUpdateSanitizerPort = Object.freeze({
  sanitize(): null {
    return null;
  },
});

export interface ToolBudgetBatchPreflight {
  readonly runId: ToolDispatchRequest["runId"];
  readonly requests: readonly ToolDispatchRequest[];
}

/* ------------------------------------------------------------------------------------------------
 * The compatibility facade
 * ---------------------------------------------------------------------------------------------- */

export interface ToolDispatcherOptions {
  readonly registry: ToolRegistry;
  /**
   * The durable Tool store.
   *
   * Either contract is accepted: the canonical `@caelush/agent` port — which is what a production
   * composition passes, and what `@caelush/storage` implements — or the pre-4C legacy contract, which
   * additionally accepts the `effects`/`effectTimestamp` facets. A legacy store is adapted once, in the
   * constructor, so nothing below this line sees two store shapes.
   */
  readonly store: ToolExecutionStorePort | LegacyToolExecutionStorePort;
  readonly gate: ToolExecutionGatePort;
  readonly notifier: ToolCommittedEventNotifier;
  readonly clock: ToolClock;
  readonly invocationIdFactory: ToolInvocationIdFactory;
  readonly observationIdFactory: ToolObservationIdFactory;
  readonly eventIdFactory: ToolEventIdFactory;
  /**
   * The canonical execution authority: the executor, its transient update sanitizer and the result
   * pipeline.
   *
   * Required, not optional. A composition that reached the lexical Tool without these three would be a
   * second execution implementation, so the option group is mandatory and this facade holds no
   * fallback path.
   */
  readonly execution: {
    readonly invocationExecutorFactory: ToolInvocationExecutorFactory;
    readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
    readonly resultPipelineFactory: ToolResultPipelineFactory;
    /**
     * The result bound the *failure* observations are written under.
     *
     * Failure content is host-owned model-facing text — a denial, a rejection, an interruption — and it
     * never reaches the canonical result pipeline, so this is where it is bounded.
     */
    readonly outputPolicy: ToolOutputPolicy;
  };
  /**
   * The Tool Invocation Lifecycle Authority.
   *
   * Supplied by the production composition, which is the layer that knows its host policy. When it is
   * absent, this facade builds the canonical coordinator from the options below, so an existing caller
   * that only knows the legacy option names still runs against the *canonical* implementation — never a
   * second one.
   */
  readonly coordinator?: DurableToolExecutionCoordinator | undefined;
  /** The durable metadata the invocation row requires. Absent means the Coding catalog projection. */
  readonly metadata?: ToolDurableMetadataPort | undefined;
  /** How a durable `ApprovalRequest` is built. Absent means the generic compatibility projection. */
  readonly approvalRequests?: ToolApprovalRequestFactory | undefined;
  /** A bounded host short-circuit. Absent means the Tool failure memory. */
  readonly admissionPreCheck?: ToolAdmissionPreCheck | undefined;
  /** Optional safe, presentation-only projection. It must never participate in execution. */
  readonly presentation?: ToolPresentationPort;
  readonly approvalStore?: ToolApprovalLookupPort;
  readonly approvalIdFactory?: ToolApprovalRequestIdFactory;
  readonly budget?: ToolBudgetPorts;
  readonly debug?: ToolCallingDebugPort;
  readonly failureMemory?: ToolFailureMemory;
  readonly outputPolicy?: ToolOutputPolicy;
  /** Durable store for the complete pre-projection Tool output. */
  readonly rawOutputStore?: {
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
  };
  readonly maxExternalCallIdBytes?: number;
  readonly maxInvocationArgsBytes?: number;
  /**
   * Registration-level argument compatibility normalization, supplied by the composition root.
   *
   * The canonical Preparer applies it inside preparation, so the numeric-string compatibility the
   * legacy Tool registrations rely on keeps exactly one implementation and stays out of the general
   * Agent Tool Layer.
   */
  readonly normalization?: ToolArgumentNormalization | undefined;
}

const ARGUMENT_ERROR_CONTENT = "Correct the tool arguments before calling it again.";

/**
 * The legacy Tool entry point, as a compatibility facade.
 *
 * ```text
 * legacy ToolDispatchRequest
 *        ↓
 * legacy boundary validation + argument preparation
 *        ↓
 * DurableToolExecutionCoordinator        ← the Tool Invocation Lifecycle Authority
 *        ↓
 * canonical DurableToolExecutionOutcome
 *        ↓
 * legacy ToolDispatcherOutcome
 * ```
 *
 * ## What it no longer does
 *
 * ```text
 * create REQUESTED                       the coordinator does
 * apply gate / approve / budget          the admission coordinator does
 * create ApprovalRequest                 the admission coordinator + the injected factory do
 * RUNNING transition                     the coordinator does
 * terminal invocation transition         the settlement coordinator does
 * ToolObservation creation               the settlement coordinator does
 * durable Tool events                    the canonical factories do
 * settlement commit                      the settlement coordinator does
 * RUNNING / WAITING_APPROVAL recovery    the coordinator does
 * ```
 *
 * ## What it still does, and why
 *
 * ```text
 * legacy request validation and the argument-failure path   the Phase 4A rejection difference
 * UNAVAILABLE_TOOL outcome mapping                           a model-facing answer with no invocation
 * debug diagnostics                                          PREFLIGHT and EXECUTION phases
 * outcome translation                                        durable → legacy vocabulary
 * budget preflight for the batch                             the batch is still legacy until 4D
 * ```
 *
 * ### The one deliberate difference
 *
 * A call whose arguments fail validation still produces the **historical durable failure row** here,
 * exactly as it always has. The canonical Preparer rejects such a call without creating an invocation,
 * and switching production onto that behaviour is a Phase 4D acceptance item. This round must not claim
 * the no-row cutover has happened, so the legacy path is preserved, documented and guarded.
 */
export class ToolDispatcher {
  private readonly preflight: ToolPreflight;
  private readonly failureMemory: ToolFailureMemory;
  private readonly canonicalPreparer: ToolCallPreparer;
  private readonly coordinator: DurableToolExecutionCoordinator;
  private readonly outputPolicy: ToolOutputPolicy;
  /**
   * The store in the canonical vocabulary.
   *
   * A legacy store is adapted exactly once, here, rather than at each of the three call sites — and the
   * adapter is pure, so the single transaction argument is untouched.
   */
  private readonly store: ToolExecutionStorePort;

  constructor(private readonly options: ToolDispatcherOptions) {
    this.preflight = new ToolPreflight(options.registry, {
      maxInvocationArgsBytes: options.maxInvocationArgsBytes ?? DEFAULT_MAX_INVOCATION_ARGS_BYTES,
    });
    this.failureMemory = options.failureMemory ?? new ToolFailureMemory();
    this.outputPolicy = options.execution.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY;
    this.store = resolveCanonicalStore(options.store);
    this.canonicalPreparer = createToolCallPreparer(options.registry.agentRegistry(), {
      maxInvocationArgsBytes: options.maxInvocationArgsBytes ?? DEFAULT_MAX_INVOCATION_ARGS_BYTES,
      ...(options.normalization === undefined ? {} : { normalization: options.normalization }),
    });
    this.coordinator = options.coordinator ?? this.buildCoordinator();
  }

  /** The failure memory this facade records model-recoverable failures in. */
  failureMemoryPort(): ToolFailureMemory {
    return this.failureMemory;
  }

  /**
   * The canonical Tool-call preparation boundary.
   *
   * ```text
   * registry.resolve            canonical resolution
   * raw argument bound          before any Tool-authored code runs
   * defensive copy              the caller's payload is never mutated
   * prepareArguments            the Tool's own declared compatibility normalization
   * prepared argument bound     a hook cannot enlarge past the boundary
   * strict input schema         compiled once, at registry build
   * ```
   *
   * Exposed so the production composition can be asserted to reach this implementation: the preflight
   * facade and the batch budget preflight both route through it, so there is exactly one resolution,
   * one normalization and one validation for a Tool call in flight.
   */
  prepareToolCall(request: import("@caelush/agent").ToolCallRequest) {
    return this.canonicalPreparer.prepare(request);
  }

  /**
   * The canonical durable invocation lifecycle this facade already drives.
   *
   * The dispatcher constructs one `DurableToolExecutionCoordinator` over its own store, gate,
   * admission metadata and approval store; the legacy `dispatch` facade is one caller of it and the
   * canonical Tool batch is another.
   *
   * This accessor exists so a **test** can compose the canonical batch over the *same* coordinator
   * rather than building a second one over the same SQLite store. Two coordinators over one store would
   * each hold their own in-process busy guard, so the concurrency guard would silently stop covering
   * both callers — the durable idempotency would still hold, but the fast, in-process guard would not.
   *
   * It adds no behaviour and grants no authority the dispatcher did not already have: the returned
   * object is the same instance the facade calls.
   */
  durableCoordinator(): DurableToolExecutionCoordinator {
    return this.coordinator;
  }

  /** The canonical Tool that resolves a name, for a caller projecting canonical outcomes. */
  resolveAgentTool(
    name: import("@caelush/protocol").ToolName,
  ): PreparedToolCall["resolved"] | undefined {
    return this.options.registry.agentRegistry().resolve(name);
  }

  modelDefinitions(): readonly import("@caelush/protocol").ToolDefinition[] {
    return this.options.registry.modelDefinitions();
  }

  /**
   * Whole-segment budget admission for the legacy batch.
   *
   * It prepares every call through the **canonical** Preparer, so the segment length the budget is
   * asked about is the number of calls that would really execute — not the number the batch was handed.
   */
  async preflightBudget(input: ToolBudgetBatchPreflight): Promise<ToolBudgetAdmission | undefined> {
    const budget = this.options.budget;
    if (budget?.admitBatch === undefined) return undefined;
    const executable = input.requests.filter((request) => {
      return (
        this.prepareToolCall({
          externalCallId: request.externalCallId,
          toolName: request.toolName,
          args: request.args,
        }).kind === "READY"
      );
    });
    return budget.admitBatch({ runId: input.runId, requested: executable.length });
  }

  async dispatch(value: unknown): Promise<ToolDispatcherOutcome> {
    return await this.run(value);
  }

  /**
   * The restart-aware entry point.
   *
   * It delegates identically to `dispatch`, because the canonical coordinator performs the idempotency
   * lookup by `(runId, sourceStepId, externalCallId)` on every entry. Two legacy names, one canonical
   * authority — which is what a compatibility facade is for.
   */
  async recoverOrDispatch(value: unknown): Promise<ToolDispatcherOutcome> {
    return await this.run(value);
  }

  async recover(
    invocationId: import("@caelush/protocol").ToolInvocationId,
    environment: ToolExecutionEnvironment,
    securityContext: ToolSecurityContext,
    signal?: AbortSignal,
  ): Promise<ToolDispatcherOutcome> {
    assertToolExecutionEnvironment(environment);
    assertToolSecurityContext(securityContext);
    const existing = await this.store.load(invocationId);
    if (existing === null) {
      throw new ToolDispatcherInvariantError("Tool invocation does not exist.");
    }
    return await this.delegate(
      () =>
        this.coordinator.recover(existing, {
          environment,
          securityContext,
          signal: signal ?? new AbortController().signal,
        }),
      { toolName: existing.invocation.toolName, args: existing.invocation.args },
    );
  }

  private async run(value: unknown): Promise<ToolDispatcherOutcome> {
    assertToolDispatchRequest(value, {
      maxExternalCallIdBytes:
        this.options.maxExternalCallIdBytes ?? DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
    });
    const preflight = this.preflight.prepare(value.toolName, value.args);
    this.emitPreflightDebug(value.toolName, value.args, preflight);
    const request = {
      ...value,
      args:
        preflight.kind === "READY"
          ? preflight.args
          : (cloneJsonValue(value.args) as import("@caelush/protocol").JsonObject),
    } satisfies ToolDispatchRequest;

    const resolved = this.options.registry.resolve(request.toolName);
    if (resolved === undefined) {
      this.emitToolDebug({
        phase: "PREFLIGHT",
        toolName: request.toolName,
        args: request.args,
        validation: "PASS",
        normalization: "UNCHANGED",
        preflight: "READY",
      });
      return {
        kind: "UNAVAILABLE_TOOL",
        toolName: request.toolName,
        content: `Tool "${request.toolName}" is not available.`,
        isError: true,
      };
    }

    const prepared = this.prepareToolCall({
      externalCallId: request.externalCallId,
      toolName: request.toolName,
      args: request.args,
    });
    if (prepared.kind === "REJECTED") {
      return await this.persistArgumentFailure(
        request,
        resolved,
        preflight.kind === "INVALID_ARGUMENTS" ? preflight.error.message : "",
        preflight.kind === "INVALID_ARGUMENTS" ? preflight.error.issues : [],
      );
    }
    return await this.delegate(
      () =>
        this.coordinator.execute({
          runId: request.runId,
          sessionId: request.sessionId,
          sourceStepId: request.stepId,
          call: prepared.call,
          environment: request.environment,
          securityContext: request.securityContext,
          signal: request.signal ?? new AbortController().signal,
        }),
      { toolName: request.toolName, args: request.args },
    );
  }

  /** Delegate one call to the coordinator and translate its result into the legacy vocabulary. */
  private async delegate(
    call: () => Promise<DurableToolExecutionOutcome>,
    debug: {
      readonly toolName: ToolName;
      readonly args: JsonObject;
    },
  ): Promise<ToolDispatcherOutcome> {
    this.emitToolDebug({
      phase: "EXECUTION",
      toolName: debug.toolName,
      args: debug.args,
      validation: "PASS",
      normalization: "UNCHANGED",
      preflight: "READY",
      execution: "STARTED",
    });
    try {
      const outcome = translateOutcome(await call());
      if (outcome.kind === "RESULT" && outcome.observation.isError) {
        // A model-recoverable Tool failure is remembered, so an identical retry can be refused before
        // it runs again. The *decision* to refuse is the admission pre-check's; this only records the
        // fact, and a transient infrastructure refusal never reaches here.
        this.failureMemory.record({
          runId: outcome.invocation.runId,
          toolName: outcome.invocation.toolName,
          args: outcome.invocation.args,
          failureCode: TOOL_FAILURE_MEMORY_CODE,
          now: this.options.clock.now(),
        });
      }
      this.emitToolDebug({
        phase: "EXECUTION",
        toolName: debug.toolName,
        args: debug.args,
        validation: "PASS",
        normalization: "UNCHANGED",
        preflight: "READY",
        execution:
          outcome.kind !== "RESULT"
            ? "STARTED"
            : outcome.observation.isError
              ? "MODEL_ERROR"
              : "COMPLETED",
      });
      return outcome;
    } catch (error) {
      throw translateError(error);
    }
  }

  private buildCoordinator(): DurableToolExecutionCoordinator {
    const options = this.options;
    const metadata: ToolDurableMetadataPort =
      options.metadata ??
      createCodingToolDurableMetadataPort({
        registry: options.registry,
        definitions: options.registry.modelDefinitions(),
      });
    const approvalRequests = options.approvalRequests ?? this.genericApprovalRequests();
    const admission: ToolAdmissionCoordinator = createToolAdmissionCoordinator({
      policy: createCodingToolAdmissionPort({
        gate: createDurableInvocationGatePort({
          gate: options.gate,
          invocations: this.durableInvocations(),
        }),
        registry: options.registry,
        definitions: options.registry.modelDefinitions(),
        approvalPresentation: (decision) => decision.safeAction,
        onDecision: (decision, request) => {
          this.emitToolDebug({
            phase: "GATE",
            toolName: request.toolName,
            args: request.args as JsonObject,
            validation: "PASS",
            normalization: "UNCHANGED",
            preflight: "READY",
            gate: decision.kind,
          });
        },
      }),
      preCheck:
        options.admissionPreCheck ??
        createToolFailureMemoryPreCheck({ memory: this.failureMemory, clock: options.clock }),
      ...(options.approvalStore === undefined
        ? {}
        : { approvals: toCanonicalApprovalLookup(options.approvalStore) }),
      ...(options.approvalIdFactory === undefined ? {} : { approvalRequests }),
      ...(options.budget === undefined
        ? {}
        : { budget: toCanonicalToolBudgetPort(options.budget) }),
      clock: options.clock,
      eventIdFactory: options.eventIdFactory,
    });
    const failureSettlement = createToolFailureSettlement({
      store: this.store,
      clock: options.clock,
      observationIdFactory: options.observationIdFactory,
      eventIdFactory: options.eventIdFactory,
      ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
      boundContent: (content) => boundToolModelContent(content, this.outputPolicy),
      notifier: options.notifier,
    });
    return createDurableToolExecutionCoordinator({
      store: this.store,
      admission,
      metadata,
      approvalRequests,
      invocationIdFactory: options.invocationIdFactory,
      observationIdFactory: options.observationIdFactory,
      eventIdFactory: options.eventIdFactory,
      clock: options.clock,
      invocationExecutorFactory: options.execution.invocationExecutorFactory,
      updateSanitizer: options.execution.updateSanitizer,
      resultPipelineFactory: options.execution.resultPipelineFactory,
      preparedCallFactory: ({ invocation, externalCallId }) =>
        this.preparedCallFor(invocation, externalCallId),
      failureSettlement,
      ...(options.approvalStore === undefined
        ? {}
        : { approvalLookup: toCanonicalApprovalLookup(options.approvalStore) }),
      ...(options.budget === undefined
        ? {}
        : {
            budget: toCanonicalToolBudgetPort(options.budget),
          }),
      ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
      ...(options.rawOutputStore === undefined ? {} : { rawOutputStore: options.rawOutputStore }),
      notifier: options.notifier,
      boundFailureContent: (content) => boundToolModelContent(content, this.outputPolicy),
    });
  }

  /**
   * The generic approval projection a legacy caller gets when it declares none.
   *
   * It keeps every field the production `ApprovalRequest` has always carried — risk level, title,
   * reason, action, `PENDING` status, `RUN` scope and the 15-minute TTL — with the timestamp supplied by
   * the canonical clock. The production composition replaces it with the Security/Coding one, which can
   * additionally carry a redacted `safeAction` preview from the real security facts.
   */
  private genericApprovalRequests(): ToolApprovalRequestFactory {
    const approvalIdFactory = this.options.approvalIdFactory;
    return ({ identity, call, requirement, createdAt }) => {
      if (approvalIdFactory === undefined) return null;
      const resolved = this.options.registry.resolve(call.resolved.tool.name);
      if (resolved === undefined) return null;
      return ApprovalRequestSchema.parse({
        id: approvalIdFactory.create(),
        runId: identity.runId,
        toolInvocationId: identity.invocationId,
        riskLevel: resolved.definition.riskLevel,
        title: "Approve Tool execution",
        reason: requirement.reason,
        action:
          requirement.presentation ??
          ({
            kind: "TOOL_EXECUTION",
            toolName: resolved.definition.name,
            riskLevel: resolved.definition.riskLevel,
            requiredCapabilities: [...resolved.definition.requiredCapabilities].sort(),
            runtimeRequirements: resolved.definition.runtimeRequirements,
          } satisfies JsonObject),
        status: "PENDING",
        scope: requirement.requestedScope ?? "RUN",
        expiresAt: (createdAt + DEFAULT_APPROVAL_TTL_MS) as typeof createdAt,
        createdAt,
      });
    };
  }

  /**
   * The canonical prepared call for an invocation whose durable row already exists.
   *
   * Nothing is resolved, normalized or validated here: the canonical registry resolved the Tool at
   * registration, preparation validated the arguments before the `REQUESTED` row was written, and the
   * arguments come from the durable invocation itself. This is a projection of durable state onto the
   * canonical call type, not a second preparation path.
   */
  private preparedCallFor(invocation: ToolInvocation, externalCallId: string): PreparedToolCall {
    const resolved = this.options.registry.agentRegistry().resolve(invocation.toolName);
    if (resolved === undefined) {
      throw new ToolDispatcherInvariantError(
        "The canonical Tool entry is unavailable for execution.",
      );
    }
    return Object.freeze({
      request: Object.freeze({
        externalCallId,
        toolName: invocation.toolName,
        args: invocation.args,
      }),
      resolved,
      args: invocation.args,
    });
  }

  /**
   * The historical durable argument failure — the Phase 4A rejection difference, retained.
   *
   * ```text
   * REQUESTED → FAILED, with a TOOL_ARGUMENT_ERROR, a bounded safe observation and one tool.failed
   * ```
   *
   * The canonical Preparer creates **no invocation** for a rejected call. Switching production onto that
   * is Phase 4D's, and until then this method is the one place a durable row is written for a call that
   * never became READY. It is deliberately the only lifecycle-shaped code left in this facade, and the
   * Phase 4C architecture guard asserts that it is.
   */
  /**
   * The durable invocation lookup the legacy gate contract requires.
   *
   * The gate validates that the invocation it is handed agrees with its definition on Tool name and
   * **risk level**, so it must be the real durable row — not a synthesized one with a guessed risk.
   * Admission runs after the `REQUESTED` commit, so the row exists by the time the gate asks.
   */
  private durableInvocations(): {
    resolve(request: {
      readonly runId: string;
      readonly stepId: string;
      readonly invocationId: string;
      readonly externalCallId: string;
      readonly toolName: ToolName;
    }): Promise<ToolInvocation | undefined>;
  } {
    return {
      resolve: async (request) =>
        (await this.store.load(request.invocationId as never))?.invocation,
    };
  }

  private async persistArgumentFailure(
    request: ToolDispatchRequest,
    resolved: ResolvedTool,
    reason: string,
    issues: readonly { readonly instancePath: string; readonly message: string }[] = [],
  ): Promise<ToolDispatcherOutcome> {
    const createdAt = this.options.clock.now();
    const invocation = createRequestedToolInvocation({
      id: this.options.invocationIdFactory.create(),
      runId: request.runId,
      stepId: request.stepId,
      toolName: request.toolName,
      externalCallId: request.externalCallId,
      args: request.args,
      riskLevel: resolved.coding?.riskLevel ?? resolved.definition.riskLevel,
      createdAt,
    });
    const failed = failToolInvocation(
      invocation,
      {
        code: "TOOL_ARGUMENT_ERROR",
        message: "Tool arguments failed validation.",
        retryable: false,
        phase: "TOOL",
        ...(issues.length === 0
          ? {}
          : {
              details: {
                issues: issues
                  .slice(0, 16)
                  .map(({ instancePath, message }) => ({ instancePath, message })),
              },
            }),
      },
      createdAt,
    );
    const observation = createToolObservation({
      id: this.options.observationIdFactory.create(),
      runId: failed.runId,
      stepId: failed.stepId,
      toolInvocationId: failed.id,
      content: boundToolModelContent(
        formatArgumentFailureContent(request.toolName, reason),
        this.outputPolicy,
      ),
      details: {},
      isError: true,
      createdAt,
    });
    const committed = await this.commitLegacy({
      sessionId: request.sessionId,
      invocation: failed,
      expectedRevision: null,
      observation,
      events: [
        createToolRequestedEvent({
          eventId: this.options.eventIdFactory.create(),
          sessionId: request.sessionId,
          timestamp: createdAt,
          invocation,
          ...(this.options.presentation === undefined
            ? {}
            : { presentation: this.options.presentation }),
        }),
        createToolFailedEvent({
          eventId: this.options.eventIdFactory.create(),
          sessionId: request.sessionId,
          timestamp: createdAt,
          invocation: failed,
          error: failed.error as import("@caelush/protocol").AgentError,
          ...(this.options.presentation === undefined
            ? {}
            : { presentation: this.options.presentation }),
        }),
      ],
    });
    if (committed.snapshot.observation === undefined) {
      throw new ToolDispatcherInvariantError("Argument failure committed without an observation.");
    }
    return {
      kind: "RESULT",
      invocation: committed.snapshot.invocation,
      observation: committed.snapshot.observation,
    };
  }

  private async commitLegacy(
    command: Parameters<ToolExecutionStorePort["commit"]>[0],
  ): Promise<import("./execution-store.js").ToolExecutionCommitResult> {
    try {
      const result = await this.store.commit(command);
      if (result.events.length > 0) this.options.notifier.notifyCommitted(result.events);
      return result;
    } catch (error) {
      if (error instanceof ToolExecutionConflictError) throw error;
      throw new ToolDispatcherInfrastructureError("Tool execution persistence failed.", {
        cause: error,
      });
    }
  }

  private emitPreflightDebug(
    toolName: import("@caelush/protocol").ToolName,
    rawArgs: import("@caelush/protocol").JsonObject,
    preflight: ToolPreflightResult,
  ): void {
    this.emitToolDebug({
      phase: "PREFLIGHT",
      toolName,
      args: rawArgs,
      validation: preflight.kind === "READY" ? "PASS" : "FAIL",
      normalization:
        preflight.kind !== "READY"
          ? "NOT_APPLIED"
          : canonicalJsonString(rawArgs) === canonicalJsonString(preflight.args)
            ? "UNCHANGED"
            : "SAFE_NUMERIC_CONVERSION",
      preflight: preflight.kind,
    });
  }

  private emitToolDebug(input: {
    readonly phase: ToolCallingDebugEvent["phase"];
    readonly toolName: ToolCallingDebugEvent["toolName"];
    readonly args: import("@caelush/protocol").JsonObject;
    readonly validation: ToolCallingDebugEvent["validation"];
    readonly normalization: ToolCallingDebugEvent["normalization"];
    readonly preflight: ToolCallingDebugEvent["preflight"];
    readonly gate?: ToolCallingDebugEvent["gate"];
    readonly execution?: ToolCallingDebugEvent["execution"];
  }): void {
    if (this.options.debug === undefined) return;
    const event: ToolCallingDebugEvent = Object.freeze({
      phase: input.phase,
      toolName: input.toolName,
      argumentKeys: Object.freeze(Object.keys(input.args).sort()),
      argumentBytes: jsonUtf8ByteLength(canonicalJsonString(input.args)),
      validation: input.validation,
      normalization: input.normalization,
      preflight: input.preflight,
      ...(input.gate === undefined ? {} : { gate: input.gate }),
      ...(input.execution === undefined ? {} : { execution: input.execution }),
    });
    try {
      this.options.debug.emit(event);
    } catch {
      // Diagnostics are strictly best effort and must never alter execution semantics.
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Translation
 * ---------------------------------------------------------------------------------------------- */

function translateOutcome(outcome: DurableToolExecutionOutcome): ToolDispatcherOutcome {
  if (outcome.kind === "SETTLED") {
    return { kind: "RESULT", invocation: outcome.invocation, observation: outcome.observation };
  }
  if (outcome.kind === "WAITING_APPROVAL") {
    return {
      kind: "WAITING_APPROVAL",
      invocation: outcome.invocation,
      approvalId: outcome.approval.id,
    };
  }
  if (outcome.kind === "BUDGET_EXCEEDED") {
    const block = outcome.block;
    return {
      kind: "BUDGET_EXCEEDED",
      invocation: outcome.invocation,
      dimension: "TOOL_CALLS",
      accounted: block.kind === "EXCEEDED" ? block.accounted : 0,
      limit: block.kind === "EXCEEDED" ? block.limit : 0,
    };
  }
  if (outcome.observation === undefined) {
    throw new ToolDispatcherInfrastructureError(
      "Cancelled ToolInvocation recovery has no legacy outcome.",
    );
  }
  return { kind: "RESULT", invocation: outcome.invocation, observation: outcome.observation };
}

function formatArgumentFailureContent(toolName: string, reason: string): string {
  if (reason.startsWith(`Tool ${toolName} failed validation:`)) {
    return `${reason} ${ARGUMENT_ERROR_CONTENT}`;
  }
  return `Invalid arguments for tool "${toolName}". ${ARGUMENT_ERROR_CONTENT} ${reason}`;
}

/**
 * Keep the legacy error vocabulary exact.
 *
 * A caller catches these by identity — the batch coordinator turns exactly four of them into a batch
 * infrastructure failure, and `ToolDispatcherInfrastructureError` is one of the four — so the canonical
 * classes are mapped back onto the legacy ones rather than leaking a new taxonomy through an unchanged
 * contract.
 *
 * The canonical `phase` is *not* discarded: it becomes the legacy error's `cause`, so a host that wants
 * to know whether admission, execution, the result pipeline, settlement or recovery failed still can,
 * without the legacy contract growing a field.
 */
function translateError(error: unknown): unknown {
  if (error instanceof ToolCallBusyError) return new ToolDispatcherBusyError(error.runId);
  if (error instanceof ToolExecutionAbortedError) {
    return new ToolDispatcherInfrastructureError("Tool execution was cancelled.", { cause: error });
  }
  if (error instanceof ToolExecutionInfrastructureError) {
    return new ToolDispatcherInfrastructureError(error.message, { cause: error });
  }
  return error;
}

/**
 * The one place a store is normalized into the canonical vocabulary.
 *
 * ```text
 * canonical store (what @caelush/storage implements)   passed through unchanged
 * pre-4C store   (a legacy implementation or test double)   commit's effects facets → extension
 * ```
 *
 * The legacy adapter is `commit`-only and pure, so a store that already speaks `extension` loses
 * nothing by going through it, and a store that speaks `effects` gains the canonical facet. One
 * normalization, one transaction, and no second durable path.
 */
function resolveCanonicalStore(
  store: ToolExecutionStorePort | LegacyToolExecutionStorePort,
): ToolExecutionStorePort {
  return toLegacyToolExecutionStoreAdapter(store);
}
