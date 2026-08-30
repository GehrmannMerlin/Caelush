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
  createToolRequestedEvent,
  createToolStartedEvent,
  createApprovalRequestedEvent,
} from "./event-factory.js";
import {
  ToolExecutionResultValidationError,
  validateToolExecutionResult,
} from "./result-validation.js";
import {
  assertToolExecutionEnvironment,
  type ToolExecutionEnvironment,
} from "./execution-environment.js";
import { assertToolSecurityContext, type ToolSecurityContext } from "./security-context.js";
import { ToolExecutionUncertainError } from "./errors.js";
import { toolEffectsToEvents, type ToolEffect } from "./tool-effects.js";
import { ToolSecurityFactsProjectionError, type ToolSecurityFacts } from "./security-facts.js";
import type { ToolExecutionResult } from "./execution-result.js";
import type { ToolResultSanitizerPort } from "./result-sanitizer.js";

export interface ToolDispatcherOptions {
  readonly registry: ToolRegistry;
  readonly store: ToolExecutionStorePort;
  readonly gate: ToolExecutionGatePort;
  readonly notifier: ToolCommittedEventNotifier;
  readonly clock: ToolClock;
  readonly invocationIdFactory: ToolInvocationIdFactory;
  readonly observationIdFactory: ToolObservationIdFactory;
  readonly eventIdFactory: ToolEventIdFactory;
  readonly resultSanitizer: ToolResultSanitizerPort;
  readonly approvalStore?: ToolApprovalStorePort;
  readonly approvalIdFactory?: ToolApprovalRequestIdFactory;
  readonly outputPolicy?: ToolOutputPolicy;
  readonly maxExternalCallIdBytes?: number;
  readonly maxInvocationArgsBytes?: number;
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

export class ToolDispatcher {
  private readonly activeCalls = new Set<string>();
  private readonly outputPolicy: ToolOutputPolicy;

  constructor(private readonly options: ToolDispatcherOptions) {
    this.outputPolicy = options.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY;
  }

  modelDefinitions(): readonly import("@caelush/protocol").ToolDefinition[] {
    return this.options.registry.modelDefinitions();
  }

  async dispatch(value: unknown): Promise<ToolDispatcherOutcome> {
    assertToolDispatchRequest(value, {
      maxExternalCallIdBytes:
        this.options.maxExternalCallIdBytes ?? DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
    });
    const request = {
      ...value,
      args: cloneJsonValue(value.args) as JsonObject,
    } satisfies ToolDispatchRequest;
    const key = callKey(request);
    this.assertCallIsNotActive(key, request.runId);
    this.activeCalls.add(key);
    try {
      return await this.dispatchLocked(request);
    } finally {
      this.activeCalls.delete(key);
    }
  }

  async recoverOrDispatch(value: unknown): Promise<ToolDispatcherOutcome> {
    assertToolDispatchRequest(value, {
      maxExternalCallIdBytes:
        this.options.maxExternalCallIdBytes ?? DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
    });
    const existing = await this.options.store.findByExternalCall(
      value.runId,
      value.stepId,
      value.externalCallId,
    );
    if (existing === null) return this.dispatch(value);
    this.assertSameCall(value, existing);
    return this.recover(existing.invocation.id, value.environment, value.securityContext);
  }

  async recover(
    invocationId: ToolInvocation["id"],
    environment: ToolExecutionEnvironment,
    securityContext: ToolSecurityContext,
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
      return await this.recoverLocked(existing, environment, securityContext);
    } finally {
      this.activeCalls.delete(key);
    }
  }

  private async dispatchLocked(request: ToolDispatchRequest): Promise<ToolDispatcherOutcome> {
    const existing = await this.options.store.findByExternalCall(
      request.runId,
      request.stepId,
      request.externalCallId,
    );
    if (existing !== null) {
      this.assertSameCall(request, existing);
      if (existing.invocation.status === "RUNNING")
        throw new ToolDispatcherBusyError(request.runId);
      return this.recoverLocked(existing, request.environment, request.securityContext);
    }
    const resolvedTool = this.options.registry.resolve(request.toolName);
    if (resolvedTool === undefined) {
      return {
        kind: "UNAVAILABLE_TOOL",
        toolName: request.toolName,
        content: `Tool "${request.toolName}" is not available.`,
        isError: true,
      };
    }
    if (
      jsonUtf8ByteLength(canonicalJsonString(request.args)) >
      (this.options.maxInvocationArgsBytes ?? DEFAULT_MAX_INVOCATION_ARGS_BYTES)
    ) {
      return this.persistArgumentFailure(
        request,
        resolvedTool,
        "Tool arguments exceed their byte budget.",
      );
    }
    const validation = resolvedTool.inputValidator.validate(request.args);
    if (!validation.valid) {
      return this.persistArgumentFailure(
        request,
        resolvedTool,
        "Tool arguments failed validation.",
        validation.issues,
      );
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
        },
        resolvedTool,
        snapshot,
      );
    }
    if (snapshot.invocation.status === "WAITING_APPROVAL") {
      return this.recoverWaitingApproval(snapshot, environment, securityContext);
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
      const grant = await this.options.approvalStore.findApplicableRunGrant({
        runId: snapshot.invocation.runId,
        approvalKey,
      });
      if (grant !== null) return this.startAndExecute(request, resolvedTool, snapshot);
      const waiting = markToolInvocationWaitingApproval(snapshot.invocation);
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
    const running = startToolInvocation(snapshot.invocation, this.options.clock.now());
    const startedEvent = createToolStartedEvent({
      eventId: this.options.eventIdFactory.create(),
      sessionId: request.sessionId,
      timestamp: running.startedAt ?? running.createdAt,
      invocation: running,
    });
    const committed = await this.commitAndNotify({
      sessionId: request.sessionId,
      invocation: running,
      expectedRevision: snapshot.revision,
      events: [startedEvent],
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

  private async executeHandler(
    request: ToolDispatchRequest,
    resolvedTool: ResolvedTool,
    snapshot: ToolExecutionSnapshot,
  ): Promise<ToolDispatcherOutcome> {
    let rawResult: unknown;
    try {
      rawResult = await resolvedTool.handler.execute({
        runId: snapshot.invocation.runId,
        stepId: snapshot.invocation.stepId,
        invocationId: snapshot.invocation.id,
        externalCallId: request.externalCallId,
        args: snapshot.invocation.args,
        environment: request.environment,
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
      throw new ToolDispatcherInfrastructureError("Tool handler execution failed.", {
        cause: error,
      });
    }
    let result;
    try {
      result = validateToolExecutionResult(rawResult, resolvedTool, this.outputPolicy);
    } catch (error) {
      if (!(error instanceof ToolExecutionResultValidationError)) {
        throw new ToolDispatcherInfrastructureError("Tool result validation failed.", {
          cause: error,
        });
      }
      await this.persistFatalFailure(
        request.sessionId,
        snapshot,
        "TOOL_OUTPUT_ERROR",
        "TOOL",
        OUTPUT_CONTENT,
      );
      throw new ToolDispatcherInfrastructureError("Tool result violated its registered contract.", {
        cause: error,
      });
    }
    let sanitizedResult: ToolExecutionResult;
    try {
      sanitizedResult = this.options.resultSanitizer.sanitize({
        toolName: resolvedTool.definition.name,
        result,
        invocation: snapshot.invocation,
      });
      result = validateToolExecutionResult(sanitizedResult, resolvedTool, this.outputPolicy);
    } catch (error) {
      throw new ToolDispatcherInfrastructureError("Tool result sanitization failed.", {
        cause: error,
      });
    }
    const finishedAt = this.options.clock.now();
    let effects: readonly ToolEffect[];
    try {
      effects =
        resolvedTool.effectProjector?.({
          request: {
            ...request,
            invocationId: snapshot.invocation.id,
            args: snapshot.invocation.args,
          },
          result,
          now: finishedAt,
        }) ?? [];
    } catch (error) {
      throw new ToolDispatcherInfrastructureError("Tool effect projection failed.", {
        cause: error,
      });
    }
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
      details: result.details,
      isError: result.isError,
      createdAt: finishedAt,
    });
    const event: DurableToolEventDraft = result.isError
      ? createToolFailedEvent({
          eventId: this.options.eventIdFactory.create(),
          sessionId: request.sessionId,
          timestamp: finishedAt,
          invocation: terminal,
          error: terminal.error as AgentError,
        })
      : createToolCompletedEvent({
          eventId: this.options.eventIdFactory.create(),
          sessionId: request.sessionId,
          timestamp: finishedAt,
          invocation: terminal,
          observationId: observation.id,
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
        }),
        event,
      ],
      effects,
      effectTimestamp: finishedAt,
    });
    if (committed.snapshot.observation === undefined) {
      throw new ToolDispatcherInvariantError("Tool settlement committed without an observation.");
    }
    return {
      kind: "RESULT",
      invocation: committed.snapshot.invocation,
      observation: committed.snapshot.observation,
    };
  }

  private projectSecurityFacts(
    resolvedTool: ResolvedTool,
    args: JsonObject,
  ): ToolSecurityFacts | undefined {
    if (resolvedTool.securityFactsProjector === undefined) return undefined;
    try {
      return resolvedTool.securityFactsProjector(args);
    } catch (error) {
      if (error instanceof ToolSecurityFactsProjectionError) {
        return { resourceAccesses: [], secretScanInputs: [], opaqueInput: true };
      }
      return { resourceAccesses: [], secretScanInputs: [], opaqueInput: true };
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
        `Invalid arguments for tool "${request.toolName}". ${ARGUMENT_ERROR_CONTENT} ${reason}`,
        this.outputPolicy,
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
      }),
      createToolFailedEvent({
        eventId: this.options.eventIdFactory.create(),
        sessionId: request.sessionId,
        timestamp: createdAt,
        invocation: failed,
        error: failed.error as AgentError,
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
      content: boundToolModelContent(content, this.outputPolicy),
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

function callKey(
  request: Pick<ToolDispatchRequest, "runId" | "stepId" | "externalCallId">,
): string {
  return `${request.runId}:${request.stepId}:${request.externalCallId}`;
}
