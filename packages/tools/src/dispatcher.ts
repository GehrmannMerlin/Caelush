import {
  ApprovalRequestSchema,
  type AgentError,
  type ApprovalRequest,
  type JsonObject,
  type ToolInvocation,
} from "@caelush/protocol";
import {
  assertToolDispatchRequest,
  DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
  DEFAULT_MAX_INVOCATION_ARGS_BYTES,
  DEFAULT_APPROVAL_TTL_MS,
  type DurableToolEventDraft,
  type ToolDispatchRequest,
  type ToolDispatcherOutcome,
  type ToolExecutionCommitResult,
  type ToolExecutionSnapshot,
  type ToolClock,
  type ToolEventIdFactory,
  type ToolInvocationIdFactory,
  type ToolObservationIdFactory,
  type ToolApprovalRequestIdFactory,
} from "./dispatcher-types.js";
import {
  ToolDispatcherBusyError,
  ToolDispatcherInfrastructureError,
  ToolDispatcherInvariantError,
} from "./dispatcher-errors.js";
import type {
  ToolExecutionGateDecision,
  ToolExecutionGatePort,
  ToolCommittedEventNotifier,
  ToolApprovalStorePort,
  ToolBudgetAdmissionPort,
} from "./dispatcher-ports.js";
import { ToolExecutionConflictError, type ToolExecutionStorePort } from "./execution-store.js";
import type { ToolOutputPolicy } from "./output-policy.js";
import { boundToolModelContent, DEFAULT_TOOL_OUTPUT_POLICY } from "./output-policy.js";
import { canonicalJsonString, cloneJsonValue, jsonUtf8ByteLength } from "./json-canonical.js";
import { computeToolApprovalKey } from "./approval-key.js";
import type { ResolvedTool, ToolRegistry } from "./registry.js";
import {
  assertToolInvocationInvariant,
  completeToolInvocation,
  createRequestedToolInvocation,
  createToolObservation,
  failToolInvocation,
  markToolInvocationWaitingApproval,
  startToolInvocation,
} from "./invocation-lifecycle.js";
import {
  createToolCompletedEvent,
  createToolFailedEvent,
  createToolOutputEvent,
  createToolRequestedEvent,
  createToolStartedEvent,
  createApprovalRequestedEvent,
} from "./event-factory.js";
import type { ToolPresentationPort } from "./presentation.js";
import {
  assertToolExecutionEnvironment,
  type ToolExecutionEnvironment,
} from "./execution-environment.js";
import { assertToolSecurityContext, type ToolSecurityContext } from "./security-context.js";
import { ToolExecutionUncertainError } from "./errors.js";
import { toolEffectsToEvents, type ToolEffect } from "./tool-effects.js";
import type { ToolSecurityFacts } from "./security-facts.js";
import type { ToolExecutionResult } from "./execution-result.js";
import { ToolPreflight, type ToolPreflightResult } from "./preflight.js";
import { ToolFailureMemory } from "./tool-failure-memory.js";
import type { ToolCallingDebugEvent, ToolCallingDebugPort } from "./debug.js";
import {
  CODING_TOOL_EFFECTS_EXTENSION_KIND,
  createToolCallPreparer,
  createToolInvocationExecutor,
  createToolResultPipeline,
  ToolResultValidationError,
  type PreparedToolCall,
  type ToolArgumentNormalization,
  type ToolCallPreparationOutcome,
  type ToolCallPreparer,
  type ToolCallRequest,
  type ToolExecutionIdentity,
  type ToolExecutionUpdateSanitizerPort,
  type ToolInvocationExecutor,
  type ToolResultPipeline,
  type ToolResultSanitizerPort,
  type TransientToolUpdateConsumer,
  type TransientToolUpdateDiagnostics,
} from "@caelush/agent";
import { createLegacyToolSettlementExtensionProjector } from "./settlement-extension-bridge.js";

/**
 * Builds the canonical executor for one durable invocation.
 *
 * The legacy shell owns the durable row, so it is the layer that binds an invocation to its executor;
 * `@caelush/agent` therefore never loads a ToolInvocation from storage.
 */
export type ToolInvocationExecutorFactory = (input: {
  readonly invocation: ToolInvocation;
  readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
}) => ToolInvocationExecutor;

/**
 * Builds the canonical result pipeline for one durable invocation.
 *
 * A pipeline is bound per settlement because the Coding effect bridge needs the invocation's durable
 * identity, and the Agent result layer must not be handed one. The factory is how the shell supplies
 * it without widening a frozen contract.
 */
export type ToolResultPipelineFactory = (input: {
  readonly invocation: ToolInvocation;
  readonly environment: ToolExecutionEnvironment;
}) => ToolResultPipeline;

/** Everything `createToolExecutionDependencies` needs to assemble the canonical execution pair. */
export interface ToolExecutionDependenciesOptions {
  readonly registry: ToolRegistry;
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
 * Assemble the canonical execution dependencies for a `ToolDispatcher`.
 *
 * ```text
 * invocationExecutorFactory  createToolInvocationExecutor, bound per invocation
 * updateSanitizer            the caller's sanitizer, or a drop-everything default
 * resultPipelineFactory      createToolResultPipeline with the sanitizer, limits and effect bridge
 * ```
 *
 * This is the one place the legacy shell's execution pair is described, so a production composition
 * and a test composition differ only in which sanitizers they inject — never in how execution or
 * result processing works.
 */
export function createToolExecutionDependencies(
  options: ToolExecutionDependenciesOptions,
): NonNullable<ToolDispatcherOptions["execution"]> {
  const updateSanitizer: ToolExecutionUpdateSanitizerPort =
    options.updateSanitizer ?? DROP_EVERY_TRANSIENT_UPDATE;
  const outputPolicy = options.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY;
  return Object.freeze({
    outputPolicy,
    invocationExecutorFactory: ({ invocation, updateSanitizer: bound }) =>
      createToolInvocationExecutor({
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
    resultPipelineFactory: ({ invocation, environment }) =>
      createToolResultPipeline({
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
            runId: invocation.runId,
            sourceStepId: invocation.stepId,
            invocationId: invocation.id,
            environment,
          },
          effectsPayload: (effects) => ({ effects: effects as unknown as JsonObject }),
        }),
      }),
  });
}
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

export interface ToolDispatcherOptions {
  readonly registry: ToolRegistry;
  readonly store: ToolExecutionStorePort;
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
   * Required, not optional. The durable shell decides *whether* and *when* a Tool may run; it no
   * longer decides *how*. A composition that reached the lexical Tool without these three would be a
   * second execution implementation, so the option group is mandatory and the legacy shell holds no
   * fallback path.
   */
  readonly execution: {
    readonly invocationExecutorFactory: ToolInvocationExecutorFactory;
    readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
    readonly resultPipelineFactory: ToolResultPipelineFactory;
    /**
     * The result bound this composition commits under.
     *
     * It stays reachable because the shell bounds the *failure* observations it writes on paths that
     * never reach a Tool (an argument failure, a policy denial, an interrupted recovery). Those are
     * shell-owned model-facing text, not Tool results, so the canonical pipeline does not see them.
     */
    readonly outputPolicy: ToolOutputPolicy;
  }; /** Optional safe, presentation-only projection. It must never participate in execution. */
  readonly presentation?: ToolPresentationPort;
  readonly approvalStore?: ToolApprovalStorePort;
  readonly approvalIdFactory?: ToolApprovalRequestIdFactory;
  readonly budget?: ToolBudgetAdmissionPort;
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
const DENIED_CONTENT = "Tool execution was denied by the active execution policy.";
const INTERRUPTED_CONTENT =
  "Tool execution was interrupted before its result was durably recorded. The operation may have partially or fully executed. Do not automatically repeat the operation.";
const RUNTIME_CONTENT =
  "Tool execution failed because the tool runtime encountered an internal error.";
const OUTPUT_CONTENT = "Tool execution failed because its output violated the registered contract.";
const UNCERTAIN_CONTENT =
  "Tool execution side effects could not be verified safely. Do not automatically repeat the operation.";
const APPROVAL_REJECTED_CONTENT = "Tool execution was not approved by the user.";
const FAILURE_MEMORY_CONTENT =
  "This Tool call was blocked because the same Tool input recently failed. Change the arguments or choose another Tool.";

export class ToolDispatcher {
  private readonly activeCalls = new Set<string>();
  private readonly preflight: ToolPreflight;
  private readonly failureMemory: ToolFailureMemory;
  private readonly canonicalPreparer: ToolCallPreparer;

  constructor(private readonly options: ToolDispatcherOptions) {
    this.preflight = new ToolPreflight(options.registry, {
      maxInvocationArgsBytes: options.maxInvocationArgsBytes ?? DEFAULT_MAX_INVOCATION_ARGS_BYTES,
    });
    this.failureMemory = options.failureMemory ?? new ToolFailureMemory();
    this.canonicalPreparer = createToolCallPreparer(options.registry.agentRegistry(), {
      maxInvocationArgsBytes: options.maxInvocationArgsBytes ?? DEFAULT_MAX_INVOCATION_ARGS_BYTES,
      ...(options.normalization === undefined ? {} : { normalization: options.normalization }),
    });
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
   * Exposed so the production composition can be asserted to reach this implementation: the
   * preflight facade and the batch budget preflight both route through it, so there is exactly one
   * resolution, one normalization and one validation for a Tool call in flight.
   */
  prepareToolCall(request: ToolCallRequest): ToolCallPreparationOutcome {
    return this.canonicalPreparer.prepare(request);
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

  async preflightBudget(
    input: ToolBudgetBatchPreflight,
  ): Promise<import("./dispatcher-ports.js").ToolBudgetAdmission | undefined> {
    if (this.options.budget?.admitBatch === undefined) return undefined;
    const executable = input.requests.filter((request) => {
      return (
        this.prepareToolCall({
          externalCallId: request.externalCallId,
          toolName: request.toolName,
          args: request.args,
        }).kind === "READY"
      );
    });
    return this.options.budget.admitBatch({
      runId: input.runId,
      requested: executable.length,
    });
  }

  async dispatch(value: unknown): Promise<ToolDispatcherOutcome> {
    assertToolDispatchRequest(value, {
      maxExternalCallIdBytes:
        this.options.maxExternalCallIdBytes ?? DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
    });
    const preflight = this.preflight.prepare(value.toolName, value.args);
    this.emitPreflightDebug(value.toolName, value.args, preflight);
    const request = {
      ...value,
      args:
        preflight.kind === "READY" ? preflight.args : (cloneJsonValue(value.args) as JsonObject),
    } satisfies ToolDispatchRequest;
    const key = callKey(request);
    this.assertCallIsNotActive(key, request.runId);
    this.activeCalls.add(key);
    try {
      return await this.dispatchLocked(request, preflight);
    } finally {
      this.activeCalls.delete(key);
    }
  }

  async recoverOrDispatch(value: unknown): Promise<ToolDispatcherOutcome> {
    assertToolDispatchRequest(value, {
      maxExternalCallIdBytes:
        this.options.maxExternalCallIdBytes ?? DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
    });
    const preflight = this.preflight.prepare(value.toolName, value.args);
    this.emitPreflightDebug(value.toolName, value.args, preflight);
    const existing = await this.options.store.findByExternalCall(
      value.runId,
      value.stepId,
      value.externalCallId,
    );
    if (existing === null) return this.dispatch(value);
    this.assertSameCall(
      preflight.kind === "READY" ? { ...value, args: preflight.args } : value,
      existing,
    );
    return this.recover(
      existing.invocation.id,
      value.environment,
      value.securityContext,
      value.signal,
    );
  }

  async recover(
    invocationId: ToolInvocation["id"],
    environment: ToolExecutionEnvironment,
    securityContext: ToolSecurityContext,
    signal?: AbortSignal,
  ): Promise<ToolDispatcherOutcome> {
    assertToolExecutionEnvironment(environment);
    assertToolSecurityContext(securityContext);
    const existing = await this.options.store.load(invocationId);
    if (existing === null)
      throw new ToolDispatcherInvariantError("Tool invocation does not exist.");
    const externalCallId = existing.invocation.externalCallId;
    if (externalCallId === undefined) {
      throw new ToolDispatcherInvariantError("Tool invocation has no external call identity.");
    }
    const key = callKey({
      runId: existing.invocation.runId,
      stepId: existing.invocation.stepId,
      externalCallId,
    });
    this.assertCallIsNotActive(key, existing.invocation.runId);
    this.activeCalls.add(key);
    try {
      return await this.recoverLocked(existing, environment, securityContext, signal);
    } finally {
      this.activeCalls.delete(key);
    }
  }

  private async dispatchLocked(
    request: ToolDispatchRequest,
    preflight: ToolPreflightResult,
  ): Promise<ToolDispatcherOutcome> {
    const existing = await this.options.store.findByExternalCall(
      request.runId,
      request.stepId,
      request.externalCallId,
    );
    if (existing !== null) {
      this.assertSameCall(request, existing);
      if (existing.invocation.status === "RUNNING")
        throw new ToolDispatcherBusyError(request.runId);
      return this.recoverLocked(
        existing,
        request.environment,
        request.securityContext,
        request.signal,
      );
    }
    throwIfAborted(request.signal);
    const resolvedTool = this.options.registry.resolve(request.toolName);
    if (resolvedTool === undefined) {
      return {
        kind: "UNAVAILABLE_TOOL",
        toolName: request.toolName,
        content: `Tool "${request.toolName}" is not available.`,
        isError: true,
      };
    }
    if (preflight.kind === "INVALID_ARGUMENTS") {
      return this.persistArgumentFailure(
        request,
        resolvedTool,
        preflight.error.message,
        preflight.error.issues,
      );
    }
    if (
      this.failureMemory.has({
        runId: request.runId,
        toolName: request.toolName,
        args: request.args,
        failureCode: "TOOL_EXECUTION_ERROR",
        now: this.options.clock.now(),
      })
    ) {
      this.emitToolDebug({
        phase: "PREFLIGHT",
        toolName: request.toolName,
        args: request.args,
        validation: "PASS",
        normalization: "UNCHANGED",
        preflight: "FAILURE_MEMORY_BLOCKED",
      });
      return this.persistFailureMemoryBlock(request, resolvedTool);
    }
    const createdAt = this.options.clock.now();
    const invocation = createRequestedToolInvocation({
      id: this.options.invocationIdFactory.create(),
      runId: request.runId,
      stepId: request.stepId,
      toolName: request.toolName,
      externalCallId: request.externalCallId,
      args: request.args,
      riskLevel: resolvedTool.definition.riskLevel,
      createdAt,
    });
    const requestedEvent = createToolRequestedEvent({
      eventId: this.options.eventIdFactory.create(),
      sessionId: request.sessionId,
      timestamp: createdAt,
      invocation,
      presentation: this.options.presentation,
    });
    const requested = await this.commitAndNotify({
      sessionId: request.sessionId,
      invocation,
      expectedRevision: null,
      events: [requestedEvent],
    });
    return this.applyGate(request, resolvedTool, requested.snapshot);
  }

  private async recoverLocked(
    snapshot: ToolExecutionSnapshot,
    environment: ToolExecutionEnvironment,
    securityContext: ToolSecurityContext,
    signal?: AbortSignal,
  ): Promise<ToolDispatcherOutcome> {
    const resolvedTool = this.options.registry.resolve(snapshot.invocation.toolName);
    if (resolvedTool === undefined) {
      throw new ToolDispatcherInvariantError("The registered Tool is unavailable during recovery.");
    }
    assertToolInvocationInvariant(snapshot.invocation);
    if (snapshot.invocation.status === "REQUESTED") {
      return this.applyGate(
        {
          sessionId: snapshot.sessionId,
          runId: snapshot.invocation.runId,
          stepId: snapshot.invocation.stepId,
          externalCallId: snapshot.invocation.externalCallId ?? "",
          toolName: snapshot.invocation.toolName,
          args: snapshot.invocation.args,
          environment,
          securityContext,
          ...(signal === undefined ? {} : { signal }),
        },
        resolvedTool,
        snapshot,
      );
    }
    if (snapshot.invocation.status === "WAITING_APPROVAL") {
      return this.recoverWaitingApproval(snapshot, environment, securityContext, signal);
    }
    if (snapshot.invocation.status === "RUNNING") return this.failInterrupted(snapshot);
    if (snapshot.invocation.status === "COMPLETED" || snapshot.invocation.status === "FAILED") {
      if (snapshot.observation === undefined) {
        throw new ToolDispatcherInvariantError("Terminal ToolInvocation has no observation.");
      }
      return { kind: "RESULT", invocation: snapshot.invocation, observation: snapshot.observation };
    }
    throw new ToolDispatcherInvariantError("Cancelled ToolInvocation recovery is not supported.");
  }

  private async applyGate(
    request: ToolDispatchRequest,
    resolvedTool: ResolvedTool,
    snapshot: ToolExecutionSnapshot,
  ): Promise<ToolDispatcherOutcome> {
    throwIfAborted(request.signal);
    const securityFacts = this.projectSecurityFacts(resolvedTool, snapshot.invocation.args);
    let decision: ToolExecutionGateDecision;
    try {
      decision = await this.options.gate.decide({
        invocation: snapshot.invocation,
        toolName: resolvedTool.definition.name,
        definition: resolvedTool.definition,
        securityContext: request.securityContext,
        runtimeKind: request.environment.runtime.kind,
        ...(securityFacts === undefined ? {} : { securityFacts }),
      });
    } catch (error) {
      throw new ToolDispatcherInfrastructureError("Tool execution policy evaluation failed.", {
        cause: error,
      });
    }
    this.emitToolDebug({
      phase: "GATE",
      toolName: resolvedTool.definition.name,
      args: snapshot.invocation.args,
      validation: "PASS",
      normalization: "UNCHANGED",
      preflight: "READY",
      gate: decision.kind,
    });
    if (decision.kind === "REQUIRE_APPROVAL") {
      if (
        this.options.approvalStore === undefined ||
        this.options.approvalIdFactory === undefined
      ) {
        throw new ToolDispatcherInfrastructureError(
          "Durable approval infrastructure is required for approval-gated Tool execution.",
        );
      }
      const approvalKey = computeToolApprovalKey({
        toolName: resolvedTool.definition.name,
        definition: resolvedTool.definition,
        args: snapshot.invocation.args,
        securityContext: request.securityContext,
      });
      throwIfAborted(request.signal);
      const grant = await this.options.approvalStore.findApplicableRunGrant({
        runId: snapshot.invocation.runId,
        approvalKey,
      });
      if (grant !== null) return this.startAndExecute(request, resolvedTool, snapshot);
      const waiting = markToolInvocationWaitingApproval(snapshot.invocation);
      throwIfAborted(request.signal);
      const approval = this.createApprovalRequest(request, resolvedTool, waiting, decision);
      const approvalEvent = createApprovalRequestedEvent({
        eventId: this.options.eventIdFactory.create(),
        sessionId: request.sessionId,
        stepId: waiting.stepId,
        timestamp: approval.createdAt,
        approval,
      });
      const committed = await this.commitAndNotify({
        sessionId: request.sessionId,
        invocation: waiting,
        expectedRevision: snapshot.revision,
        approval,
        approvalKey,
        events: [approvalEvent],
      });
      if (committed.snapshot.approval === undefined) {
        throw new ToolDispatcherInvariantError("Approval request was not durably committed.");
      }
      return {
        kind: "WAITING_APPROVAL",
        invocation: committed.snapshot.invocation,
        approvalId: committed.snapshot.approval.id,
      };
    }
    if (decision.kind === "DENY") {
      return this.persistFailure(
        request.sessionId,
        snapshot,
        "PERMISSION_DENIED",
        "SECURITY",
        DENIED_CONTENT,
        {},
      );
    }
    return this.startAndExecute(request, resolvedTool, snapshot);
  }

  private async startAndExecute(
    request: ToolDispatchRequest,
    resolvedTool: ResolvedTool,
    snapshot: ToolExecutionSnapshot,
  ): Promise<ToolDispatcherOutcome> {
    throwIfAborted(request.signal);
    if (this.options.budget !== undefined) {
      const admission = await this.options.budget.admit({
        runId: request.runId,
        requested: 1,
        invocationId: snapshot.invocation.id,
      });
      if (admission.kind === "EXCEEDED") {
        const failed = await this.persistFailure(
          request.sessionId,
          snapshot,
          "BUDGET_EXCEEDED",
          "INTERNAL",
          "Tool execution budget is exhausted.",
          {},
        );
        if (failed.kind !== "RESULT") {
          throw new ToolDispatcherInvariantError("Budget failure did not produce a Tool result.");
        }
        return {
          kind: "BUDGET_EXCEEDED",
          invocation: failed.invocation,
          dimension: admission.dimension,
          accounted: admission.accounted,
          limit: admission.limit,
        };
      }
    }
    const running = startToolInvocation(snapshot.invocation, this.options.clock.now());
    const startedEvent = createToolStartedEvent({
      eventId: this.options.eventIdFactory.create(),
      sessionId: request.sessionId,
      timestamp: running.startedAt ?? running.createdAt,
      invocation: running,
      presentation: this.options.presentation,
    });
    const committed = await this.commitAndNotify({
      sessionId: request.sessionId,
      invocation: running,
      expectedRevision: snapshot.revision,
      events: [startedEvent],
      ...(this.options.budget === undefined
        ? {}
        : {
            budgetStart: {
              ownerId: snapshot.invocation.id,
              startedAt: running.startedAt ?? running.createdAt,
            },
          }),
    });
    this.emitToolDebug({
      phase: "EXECUTION",
      toolName: resolvedTool.definition.name,
      args: running.args,
      validation: "PASS",
      normalization: "UNCHANGED",
      preflight: "READY",
      execution: "STARTED",
    });
    await this.options.budget?.start?.({
      runId: request.runId,
      invocationId: snapshot.invocation.id,
    });
    return this.executeHandler(request, resolvedTool, committed.snapshot);
  }

  private createApprovalRequest(
    request: ToolDispatchRequest,
    resolvedTool: ResolvedTool,
    invocation: ToolInvocation,
    decision: Extract<ToolExecutionGateDecision, { kind: "REQUIRE_APPROVAL" }>,
  ): ApprovalRequest {
    if (this.options.approvalStore === undefined || this.options.approvalIdFactory === undefined) {
      throw new ToolDispatcherInfrastructureError(
        "Durable approval infrastructure is required for approval-gated Tool execution.",
      );
    }
    const createdAt = this.options.clock.now();
    return ApprovalRequestSchema.parse({
      id: this.options.approvalIdFactory.create(),
      runId: invocation.runId,
      toolInvocationId: invocation.id,
      riskLevel: invocation.riskLevel,
      title: "Approve Tool execution",
      reason: decision.safeReason ?? "The active policy requires review before this Tool runs.",
      action: decision.safeAction ?? {
        kind: "TOOL_EXECUTION",
        toolName: resolvedTool.definition.name,
        riskLevel: resolvedTool.definition.riskLevel,
        requiredCapabilities: [...resolvedTool.definition.requiredCapabilities].sort(),
        runtimeRequirements: resolvedTool.definition.runtimeRequirements,
        permissionProfile: request.securityContext.permissionProfile,
        approvalPolicy: request.securityContext.approvalPolicy,
      },
      status: "PENDING",
      scope: "RUN",
      expiresAt: (createdAt + DEFAULT_APPROVAL_TTL_MS) as typeof createdAt,
      createdAt,
    });
  }

  private async recoverWaitingApproval(
    snapshot: ToolExecutionSnapshot,
    environment: ToolExecutionEnvironment,
    securityContext: ToolSecurityContext,
    signal?: AbortSignal,
  ): Promise<ToolDispatcherOutcome> {
    const approvalStore = this.options.approvalStore;
    if (approvalStore === undefined) {
      throw new ToolDispatcherInfrastructureError(
        "Durable approval infrastructure is required to recover a waiting Tool.",
      );
    }
    const approval =
      (await approvalStore.getByInvocation(snapshot.invocation.id)) ?? snapshot.approval;
    if (approval === null || approval === undefined) {
      throw new ToolDispatcherInvariantError("Waiting ToolInvocation has no ApprovalRequest.");
    }
    if (approval.status === "PENDING") {
      return { kind: "WAITING_APPROVAL", invocation: snapshot.invocation, approvalId: approval.id };
    }
    const request: ToolDispatchRequest = {
      sessionId: snapshot.sessionId,
      runId: snapshot.invocation.runId,
      stepId: snapshot.invocation.stepId,
      externalCallId: snapshot.invocation.externalCallId ?? "",
      toolName: snapshot.invocation.toolName,
      args: snapshot.invocation.args,
      environment,
      securityContext,
      ...(signal === undefined ? {} : { signal }),
    };
    if (approval.status !== "APPROVED") {
      return this.persistFailure(
        request.sessionId,
        snapshot,
        "APPROVAL_REJECTED",
        "SECURITY",
        APPROVAL_REJECTED_CONTENT,
        {},
        { approvalStatus: approval.status },
      );
    }
    const resolvedTool = this.options.registry.resolve(snapshot.invocation.toolName);
    if (resolvedTool === undefined) {
      throw new ToolDispatcherInvariantError("The registered Tool is unavailable during recovery.");
    }
    const securityFacts = this.projectSecurityFacts(resolvedTool, snapshot.invocation.args);
    const decision = await this.options.gate.decide({
      invocation: snapshot.invocation,
      toolName: resolvedTool.definition.name,
      definition: resolvedTool.definition,
      securityContext,
      runtimeKind: environment.runtime.kind,
      ...(securityFacts === undefined ? {} : { securityFacts }),
    });
    if (decision.kind === "DENY") {
      return this.persistFailure(
        request.sessionId,
        snapshot,
        "PERMISSION_DENIED",
        "SECURITY",
        DENIED_CONTENT,
        {},
      );
    }
    if (decision.kind === "REQUIRE_APPROVAL") {
      const approvalKey = computeToolApprovalKey({
        toolName: resolvedTool.definition.name,
        definition: resolvedTool.definition,
        args: snapshot.invocation.args,
        securityContext,
      });
      const storedKey = await approvalStore.getApprovalKeyByInvocation?.(snapshot.invocation.id);
      if (storedKey !== undefined && storedKey !== approvalKey) {
        throw new ToolDispatcherInvariantError("Approval identity does not match the Tool call.");
      }
      if (approval.grantedScope === undefined) {
        throw new ToolDispatcherInvariantError("Approved ApprovalRequest has no granted scope.");
      }
    }
    return this.startAndExecute(request, resolvedTool, snapshot);
  }

  /**
   * Execute an invocation the shell has already durably started.
   *
   * ```text
   * durable RUNNING commit  (startAndExecute, above)
   *   ↓
   * canonical ToolInvocationExecutor.execute(...)      @caelush/agent   ← execution authority
   *   ↓
   * raw AgentToolResult
   *   ↓
   * raw artifact compatibility                          this shell (storage-owned, so not in the pipeline)
   *   ↓
   * canonical ToolResultPipeline.process(...)           @caelush/agent   ← result authority
   *   ↓
   * PreparedToolSettlement
   *   ↓
   * terminal lifecycle / observation / events / effects / atomic commit   this shell, until 4C
   * ```
   *
   * What this method no longer owns: reaching a `ToolHandler` directly, building an execution input,
   * the update lifetime, the exact-shape rule, the details budget, the schema check, the sanitize →
   * revalidate sequence and the content bound. It calls the canonical executor and the canonical
   * pipeline, and projects what they return into the durable rows this round still commits.
   */
  private async executeHandler(
    request: ToolDispatchRequest,
    resolvedTool: ResolvedTool,
    snapshot: ToolExecutionSnapshot,
  ): Promise<ToolDispatcherOutcome> {
    const identity: ToolExecutionIdentity = Object.freeze({
      runId: snapshot.invocation.runId,
      sessionId: request.sessionId,
      sourceStepId: snapshot.invocation.stepId,
      invocationId: snapshot.invocation.id,
      externalCallId: request.externalCallId,
    });
    const executor = this.options.execution.invocationExecutorFactory({
      invocation: snapshot.invocation,
      updateSanitizer: this.options.execution.updateSanitizer,
    });

    // The canonical execution result type. `ToolExecutionResult` is the legacy alias for the same
    // structure, so this is one value under two names, not a conversion.
    let rawResult: ToolExecutionResult;
    try {
      rawResult = await executor.execute({
        call: this.preparedCallFor(resolvedTool, request),
        identity,
        environment: request.environment,
        signal: request.signal ?? new AbortController().signal,
      });
    } catch (error) {
      if (error instanceof ToolExecutionUncertainError) {
        return this.persistFailure(
          request.sessionId,
          snapshot,
          "TOOL_EXECUTION_ERROR",
          "RUNTIME",
          UNCERTAIN_CONTENT,
          {},
          { executionDisposition: "UNCERTAIN_SIDE_EFFECT" },
        );
      }
      await this.persistFatalFailure(
        request.sessionId,
        snapshot,
        "RUNTIME_ERROR",
        "RUNTIME",
        RUNTIME_CONTENT,
      );
      throw new ToolDispatcherInfrastructureError("Tool execution failed.", { cause: error });
    }

    /**
     * The complete raw Tool output, as the compatibility artifact.
     *
     * It uses the raw execution `content`, exactly as it always has, and it is written before the
     * result pipeline runs. Archiving is a storage concern, so it stays here rather than moving into
     * a pipeline that must not know storage exists; the durable observation still carries only the
     * sanitized, bounded content.
     */
    const rawArtifactRef =
      this.options.rawOutputStore === undefined
        ? undefined
        : (
            await this.options.rawOutputStore.createOrGet({
              artifactId: `tool-output:${snapshot.invocation.id}`,
              runId: snapshot.invocation.runId,
              kind: "TOOL_OUTPUT",
              sourceRef: snapshot.invocation.id,
              content: rawResult.content,
              mimeType: "text/plain; charset=utf-8",
              sensitivity: "INTERNAL",
              createdSequence: 0,
              createdAt: this.options.clock.now(),
            })
          ).artifactId;

    const finishedAt = this.options.clock.now();
    let settlement;
    try {
      settlement = this.options.execution
        .resultPipelineFactory({
          invocation: snapshot.invocation,
          environment: request.environment,
        })
        .process({
          call: this.preparedCallFor(resolvedTool, request),
          invocation: snapshot.invocation,
          rawResult,
          now: finishedAt,
        });
    } catch (error) {
      // A result contract violation is settled as a fatal Tool output error; a pipeline
      // infrastructure failure is not. Both leave the durable boundary exactly as they found it, and
      // neither ever becomes an ordinary `isError: true` model result.
      if (error instanceof ToolResultValidationError) {
        await this.persistFatalFailure(
          request.sessionId,
          snapshot,
          "TOOL_OUTPUT_ERROR",
          "TOOL",
          OUTPUT_CONTENT,
        );
        throw new ToolDispatcherInfrastructureError(
          "Tool result violated its registered contract.",
          { cause: error },
        );
      }
      throw new ToolDispatcherInfrastructureError("Tool result processing failed.", {
        cause: error,
      });
    }
    const result: ToolExecutionResult = settlement.result;
    const effects = this.legacyEffectsFromSettlement(settlement);
    const terminal = result.isError
      ? failToolInvocation(
          snapshot.invocation,
          {
            code: "TOOL_EXECUTION_ERROR",
            message: "Tool execution returned an error result.",
            retryable: false,
            phase: "TOOL",
          },
          finishedAt,
        )
      : completeToolInvocation(snapshot.invocation, finishedAt);
    const observation = createToolObservation({
      id: this.options.observationIdFactory.create(),
      runId: terminal.runId,
      stepId: terminal.stepId,
      toolInvocationId: terminal.id,
      content: result.content,
      // The canonical result layer speaks the AI package's JSON model; the durable observation speaks
      // the Protocol one. They describe the same JSON value and differ only in declaration, so this is
      // the single point where the two vocabularies meet.
      details: result.details as unknown as JsonObject,
      isError: result.isError,
      ...(rawArtifactRef === undefined ? {} : { rawArtifactRef }),
      createdAt: finishedAt,
    });
    const event: DurableToolEventDraft = result.isError
      ? createToolFailedEvent({
          eventId: this.options.eventIdFactory.create(),
          sessionId: request.sessionId,
          timestamp: finishedAt,
          invocation: terminal,
          error: terminal.error as AgentError,
          presentation: this.options.presentation,
          result,
        })
      : createToolCompletedEvent({
          eventId: this.options.eventIdFactory.create(),
          sessionId: request.sessionId,
          timestamp: finishedAt,
          invocation: terminal,
          observationId: observation.id,
          presentation: this.options.presentation,
          result,
        });
    const outputEvent = createToolOutputEvent({
      eventId: this.options.eventIdFactory.create(),
      sessionId: request.sessionId,
      timestamp: finishedAt,
      invocation: terminal,
      presentation: this.options.presentation,
      result,
    });
    const committed = await this.commitAndNotify({
      sessionId: request.sessionId,
      invocation: terminal,
      expectedRevision: snapshot.revision,
      observation,
      events: [
        ...toolEffectsToEvents(effects, {
          runId: terminal.runId,
          sessionId: request.sessionId,
          stepId: terminal.stepId,
          timestamp: finishedAt,
          nextEventId: () => this.options.eventIdFactory.create(),
          invocation: terminal,
          presentation: this.options.presentation,
        }),
        ...(outputEvent === undefined ? [] : [outputEvent]),
        event,
      ],
      effects,
      effectTimestamp: finishedAt,
    });
    if (committed.snapshot.observation === undefined) {
      throw new ToolDispatcherInvariantError("Tool settlement committed without an observation.");
    }
    if (result.isError) {
      this.failureMemory.record({
        runId: request.runId,
        toolName: resolvedTool.definition.name,
        args: snapshot.invocation.args,
        failureCode: "TOOL_EXECUTION_ERROR",
        now: finishedAt,
      });
    }
    this.emitToolDebug({
      phase: "EXECUTION",
      toolName: resolvedTool.definition.name,
      args: snapshot.invocation.args,
      validation: "PASS",
      normalization: "UNCHANGED",
      preflight: "READY",
      execution: result.isError ? "MODEL_ERROR" : "COMPLETED",
    });
    await this.options.budget?.settle?.({
      runId: request.runId,
      invocationId: snapshot.invocation.id,
    });
    return {
      kind: "RESULT",
      invocation: committed.snapshot.invocation,
      observation: committed.snapshot.observation,
    };
  }

  /**
   * The canonical prepared call for an invocation this shell already durably started.
   *
   * Nothing is resolved, normalized or validated here: the canonical registry resolved the Tool at
   * registration, 4A's preparation validated the arguments before the `REQUESTED` row was written,
   * and the arguments come from the durable invocation itself. This is a projection of durable state
   * onto the canonical call type, not a second preparation path.
   */
  private preparedCallFor(
    resolvedTool: ResolvedTool,
    request: ToolDispatchRequest,
  ): PreparedToolCall {
    const resolved =
      resolvedTool.agentTool === undefined
        ? undefined
        : this.options.registry.agentRegistry().resolve(resolvedTool.definition.name);
    if (resolved === undefined) {
      throw new ToolDispatcherInvariantError(
        "The canonical Tool entry is unavailable for execution.",
      );
    }
    return Object.freeze({
      request: Object.freeze({
        externalCallId: request.externalCallId,
        toolName: resolvedTool.definition.name,
        args: request.args,
      }),
      resolved,
      args: request.args,
    });
  }

  /**
   * Project the legacy Tool effects, or refuse to settle.
   *
   * Effects are Coding-overlay metadata and stay in the legacy composition until 4E. A projector that
   * throws leaves the invocation `RUNNING` for uncertain recovery rather than producing a durable
   * state that disagrees with the workspace.
   */
  private projectEffects(
    resolvedTool: ResolvedTool,
    request: ToolDispatchRequest,
    snapshot: ToolExecutionSnapshot,
    result: ToolExecutionResult,
    now: import("@caelush/protocol").TimestampMs,
  ): readonly ToolEffect[] {
    try {
      return (
        resolvedTool.effectProjector?.({
          request: {
            ...request,
            invocationId: snapshot.invocation.id,
            args: snapshot.invocation.args,
          },
          result,
          now,
        }) ?? []
      );
    } catch (error) {
      throw new ToolDispatcherInfrastructureError("Tool effect projection failed.", {
        cause: error,
      });
    }
  }

  /**
   * Read the Coding Tool effects back out of the opaque settlement extension.
   *
   * ```text
   * canonical pipeline   produced an opaque { kind, payload } it does not interpret
   * this shell           decodes it into the ToolEffect[] the existing atomic commit understands
   * ```
   *
   * The decode is total and defensive: an absent extension means no effects, and a payload that is not
   * an array is a Coding-overlay contract violation this shell refuses to settle rather than guessing
   * through.
   */
  private legacyEffectsFromSettlement(settlement: {
    readonly effects?: import("@caelush/agent").ToolSettlementExtension | undefined;
  }): readonly ToolEffect[] {
    const extension = settlement.effects;
    if (extension === undefined) return [];
    if (extension.kind !== CODING_TOOL_EFFECTS_EXTENSION_KIND) {
      throw new ToolDispatcherInfrastructureError(
        "Tool settlement carried an unknown settlement extension.",
      );
    }
    // The canonical payload speaks the AI package's JSON model; the Coding effect vocabulary speaks
    // the legacy one. Same JSON, two declarations, so the boundary is where they meet.
    const payload = extension.payload as unknown as JsonObject;
    const effects = payload.effects;
    if (!Array.isArray(effects)) {
      throw new ToolDispatcherInfrastructureError(
        "Tool settlement extension payload is malformed.",
      );
    }
    return effects as unknown as readonly ToolEffect[];
  }

  private projectSecurityFacts(
    resolvedTool: ResolvedTool,
    args: JsonObject,
  ): ToolSecurityFacts | undefined {
    if (resolvedTool.securityFactsProjector === undefined) return undefined;
    try {
      return resolvedTool.securityFactsProjector(args);
    } catch {
      // Security facts that cannot be projected fail closed: the input is described as opaque so an
      // admission decision is never made on a partial description.
      return { resourceAccesses: [], secretScanInputs: [], opaqueInput: true };
    }
  }

  private emitPreflightDebug(
    toolName: ToolDispatchRequest["toolName"],
    rawArgs: JsonObject,
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
    readonly args: JsonObject;
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

  private async persistArgumentFailure(
    request: ToolDispatchRequest,
    resolvedTool: ResolvedTool,
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
      riskLevel: resolvedTool.definition.riskLevel,
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
        this.options.execution.outputPolicy,
      ),
      details: {},
      isError: true,
      createdAt,
    });
    const events = [
      createToolRequestedEvent({
        eventId: this.options.eventIdFactory.create(),
        sessionId: request.sessionId,
        timestamp: createdAt,
        invocation,
        presentation: this.options.presentation,
      }),
      createToolFailedEvent({
        eventId: this.options.eventIdFactory.create(),
        sessionId: request.sessionId,
        timestamp: createdAt,
        invocation: failed,
        error: failed.error as AgentError,
        presentation: this.options.presentation,
      }),
    ];
    const committed = await this.commitAndNotify({
      sessionId: request.sessionId,
      invocation: failed,
      expectedRevision: null,
      observation,
      events,
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

  private async persistFailureMemoryBlock(
    request: ToolDispatchRequest,
    resolvedTool: ResolvedTool,
  ): Promise<ToolDispatcherOutcome> {
    const createdAt = this.options.clock.now();
    const invocation = createRequestedToolInvocation({
      id: this.options.invocationIdFactory.create(),
      runId: request.runId,
      stepId: request.stepId,
      toolName: request.toolName,
      externalCallId: request.externalCallId,
      args: request.args,
      riskLevel: resolvedTool.definition.riskLevel,
      createdAt,
    });
    const requestedEvent = createToolRequestedEvent({
      eventId: this.options.eventIdFactory.create(),
      sessionId: request.sessionId,
      timestamp: createdAt,
      invocation,
      presentation: this.options.presentation,
    });
    const requested = await this.commitAndNotify({
      sessionId: request.sessionId,
      invocation,
      expectedRevision: null,
      events: [requestedEvent],
    });
    return this.persistFailure(
      request.sessionId,
      requested.snapshot,
      "TOOL_EXECUTION_ERROR",
      "TOOL",
      FAILURE_MEMORY_CONTENT,
      {},
      { blockedBy: "TOOL_FAILURE_MEMORY" },
    );
  }

  private async persistFailure(
    sessionId: ToolDispatchRequest["sessionId"],
    snapshot: ToolExecutionSnapshot,
    code: AgentError["code"],
    phase: AgentError["phase"],
    content: string,
    details: JsonObject,
    errorDetails: JsonObject = {},
  ): Promise<ToolDispatcherOutcome> {
    const finishedAt = this.options.clock.now();
    const failed = failToolInvocation(
      snapshot.invocation,
      {
        code,
        message:
          code === "PERMISSION_DENIED" || code === "APPROVAL_REJECTED"
            ? content
            : "Tool execution returned an error result.",
        retryable: false,
        phase,
        ...(Object.keys(errorDetails).length === 0 ? {} : { details: errorDetails }),
      },
      finishedAt,
    );
    const observation = createToolObservation({
      id: this.options.observationIdFactory.create(),
      runId: failed.runId,
      stepId: failed.stepId,
      toolInvocationId: failed.id,
      content: boundToolModelContent(content, this.options.execution.outputPolicy),
      details,
      isError: true,
      createdAt: finishedAt,
    });
    const event = createToolFailedEvent({
      eventId: this.options.eventIdFactory.create(),
      sessionId,
      timestamp: finishedAt,
      invocation: failed,
      error: failed.error as AgentError,
      presentation: this.options.presentation,
      result: {
        content,
        details,
        isError: true,
      },
    });
    const committed = await this.commitAndNotify({
      sessionId,
      invocation: failed,
      expectedRevision: snapshot.revision,
      observation,
      events: [event],
    });
    if (committed.snapshot.observation === undefined) {
      throw new ToolDispatcherInvariantError("Tool failure committed without an observation.");
    }
    return {
      kind: "RESULT",
      invocation: committed.snapshot.invocation,
      observation: committed.snapshot.observation,
    };
  }

  private async persistFatalFailure(
    sessionId: ToolDispatchRequest["sessionId"],
    snapshot: ToolExecutionSnapshot,
    code: AgentError["code"],
    phase: AgentError["phase"],
    content: string,
  ): Promise<void> {
    await this.persistFailure(sessionId, snapshot, code, phase, content, {});
  }

  private async failInterrupted(snapshot: ToolExecutionSnapshot): Promise<ToolDispatcherOutcome> {
    return this.persistFailure(
      snapshot.sessionId,
      snapshot,
      "TOOL_EXECUTION_ERROR",
      "TOOL",
      INTERRUPTED_CONTENT,
      {},
      { executionDisposition: "UNCERTAIN_SIDE_EFFECT" },
    );
  }

  private async commitAndNotify(
    command: Parameters<ToolExecutionStorePort["commit"]>[0],
  ): Promise<ToolExecutionCommitResult> {
    try {
      const result = await this.options.store.commit(command);
      if (result.events.length > 0) this.options.notifier.notifyCommitted(result.events);
      return result;
    } catch (error) {
      if (error instanceof ToolExecutionConflictError) throw error;
      throw new ToolDispatcherInfrastructureError("Tool execution persistence failed.", {
        cause: error,
      });
    }
  }

  private assertCallIsNotActive(key: string, runId: ToolDispatchRequest["runId"]): void {
    if (this.activeCalls.has(key)) throw new ToolDispatcherBusyError(runId);
  }

  private assertSameCall(request: ToolDispatchRequest, snapshot: ToolExecutionSnapshot): void {
    if (
      snapshot.invocation.toolName !== request.toolName ||
      canonicalJsonString(snapshot.invocation.args) !== canonicalJsonString(request.args)
    ) {
      throw new ToolExecutionConflictError(
        "Tool call identity conflicts with existing durable data.",
      );
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Tool execution was cancelled.");
}

function callKey(
  request: Pick<ToolDispatchRequest, "runId" | "stepId" | "externalCallId">,
): string {
  return `${request.runId}:${request.stepId}:${request.externalCallId}`;
}

function formatArgumentFailureContent(toolName: string, reason: string): string {
  if (reason.startsWith(`Tool ${toolName} failed validation:`)) {
    return `${reason} ${ARGUMENT_ERROR_CONTENT}`;
  }
  return `Invalid arguments for tool "${toolName}". ${ARGUMENT_ERROR_CONTENT} ${reason}`;
}
