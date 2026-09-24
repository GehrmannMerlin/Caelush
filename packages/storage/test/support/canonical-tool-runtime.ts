import type { JsonObject } from "@caelush/ai";
import type { RiskLevel, TimestampMs, ToolInvocation, ToolName } from "@caelush/protocol";
import {
  createEventId,
  createObservationId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import {
  createDurableToolExecutionCoordinator,
  createToolAdmissionCoordinator,
  createToolBatchCoordinator,
  createToolCallPreparer,
  createToolFailureSettlement,
  createToolInvocationExecutor,
  createToolResultPipeline,
  DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER,
  UNBOUNDED_TOOL_BUDGET_ADMISSION,
  type AgentToolRegistry,
  type DurableResultPipelineFactory,
  type DurableToolExecutionCoordinator,
  type RunEventNotifierPort,
  type PreparedToolCall,
  type ToolAdmissionCoordinator,
  type ToolAdmissionPort,
  type ToolApprovalLookupPort,
  type ToolApprovalRequestFactory,
  type ToolBatchCoordinator,
  type ToolDurableMetadataPort,
  type ToolExecutionUpdateSanitizerPort,
} from "@caelush/agent";
import type { CaelushStorage } from "../../src/index.js";

/**
 * The canonical Tool execution pipeline, composed the way the daemon composition root composes it.
 *
 * ```text
 * ToolCallPreparer                     resolve, normalize and validate a model call    @caelush/agent
 * ToolAdmissionCoordinator             policy → approval → budget                      @caelush/agent
 * DurableToolExecutionCoordinator      REQUESTED → RUNNING → execute → settle           @caelush/agent
 *    ↑ ToolInvocationExecutor          the one execution authority                      @caelush/agent
 *    ↑ ToolResultPipeline              validate → sanitize → bound → extension          @caelush/agent
 *    ↑ ToolFailureSettlement           the one bounded failure path                     @caelush/agent
 * ```
 *
 * Phase 4F retired the legacy `ToolDispatcher` facade, so the storage suites that used to build one now
 * build this. Everything here is a *construction* dependency of the real canonical coordinator — no
 * lifecycle algorithm is reimplemented, and no port is a stub for a canonical one:
 *
 * ```text
 * the durable store            @caelush/storage's own SqliteToolExecutionStore
 * the admission coordinator    the canonical one, over a host policy port
 * the executor / pipeline      the canonical factories, bound per invocation
 * the failure settlement       the canonical bounded failure path
 * ```
 *
 * A host that has no security subsystem supplies the default allow-all policy; a Coding host supplies
 * its own admission coordinator (the Coding/Security adapter over the real gate).
 */
export interface CanonicalToolRuntime {
  readonly coordinator: DurableToolExecutionCoordinator;
  /** The canonical scheduler over that coordinator: preflight, preparation and the rejection barrier. */
  readonly batch: ToolBatchCoordinator;
  /** Resolve, normalize and validate one model Tool call, exactly as the batch coordinator does. */
  prepare(input: {
    readonly externalCallId: string;
    readonly toolName: ToolName;
    readonly args: JsonObject;
  }): PreparedToolCall;
}

export interface CanonicalToolRuntimeOptions {
  readonly storage: CaelushStorage;
  readonly registry: AgentToolRegistry;
  /** The committed-event notifier, when the test also asserts live publication. */
  readonly notifier?: RunEventNotifierPort | undefined;
  /** The whole admission coordinator, for a host that composes Coding/Security admission itself. */
  readonly admission?: ToolAdmissionCoordinator | undefined;
  /** The policy half of admission, for a host that only needs a policy port. */
  readonly policy?: ToolAdmissionPort | undefined;
  readonly approvals?: ToolApprovalLookupPort | undefined;
  readonly approvalRequests?: ToolApprovalRequestFactory | undefined;
  readonly metadata?: ToolDurableMetadataPort | undefined;
  /** The durable metadata answer for a Tool with no Coding overlay. */
  readonly riskLevel?: RiskLevel | undefined;
  readonly resultPipelineFactory?: DurableResultPipelineFactory | undefined;
  readonly updateSanitizer?: ToolExecutionUpdateSanitizerPort | undefined;
  readonly boundContent?: ((content: string) => string) | undefined;
  /** The Tool-layer clock, when the host shares one clock across admission and settlement. */
  readonly clock?: { now(): TimestampMs } | undefined;
  /** The first timestamp the injected clock answers with; it advances by one per read. */
  readonly startTimestamp?: number | undefined;
}

/** Project durable invocation state back onto the canonical prepared call, as the recovery path does. */
export function preparedCallFromDurableState(
  registry: AgentToolRegistry,
  invocation: ToolInvocation,
  externalCallId: string,
): PreparedToolCall {
  const resolved = registry.resolve(invocation.toolName);
  if (resolved === undefined) {
    throw new Error(`The canonical Tool entry "${invocation.toolName}" is unavailable.`);
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

export function createCanonicalToolRuntime(
  options: CanonicalToolRuntimeOptions,
): CanonicalToolRuntime {
  let timestamp = options.startTimestamp ?? 200;
  const clock = options.clock ?? { now: () => createTimestampMs(++timestamp) };
  const notifier = options.notifier;
  const approvalRequests = options.approvalRequests ?? (() => null);
  const updateSanitizer: ToolExecutionUpdateSanitizerPort = options.updateSanitizer ?? {
    sanitize: () => null,
  };
  const admission =
    options.admission ??
    createToolAdmissionCoordinator({
      policy: options.policy ?? { evaluate: async () => ({ kind: "ALLOW" as const }) },
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
      ...(options.approvalRequests === undefined
        ? {}
        : { approvalRequests: options.approvalRequests }),
      budget: UNBOUNDED_TOOL_BUDGET_ADMISSION,
      clock,
      eventIdFactory: { create: createEventId },
    });
  const metadata: ToolDurableMetadataPort = options.metadata ?? {
    get: () => ({ riskLevel: options.riskLevel ?? "LOW" }),
  };
  const coordinator = createDurableToolExecutionCoordinator({
    store: options.storage.toolExecution,
    admission,
    metadata,
    approvalRequests,
    ...(options.approvals === undefined ? {} : { approvalLookup: options.approvals }),
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    clock,
    invocationExecutorFactory: ({ invocation, updateSanitizer: bound }) =>
      createToolInvocationExecutor({
        invocation,
        updateSanitizer: bound,
        transientUpdates: DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER,
      }),
    updateSanitizer,
    resultPipelineFactory: options.resultPipelineFactory ?? (() => createToolResultPipeline()),
    preparedCallFactory: ({ invocation, externalCallId }) =>
      preparedCallFromDurableState(options.registry, invocation, externalCallId),
    failureSettlement: createToolFailureSettlement({
      store: options.storage.toolExecution,
      clock,
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
      boundContent: options.boundContent ?? ((content) => content),
      ...(notifier === undefined ? {} : { notifier }),
    }),
    ...(notifier === undefined ? {} : { notifier }),
  });
  const preparer = createToolCallPreparer(options.registry);
  return {
    coordinator,
    batch: createToolBatchCoordinator({
      preparer,
      budget: UNBOUNDED_TOOL_BUDGET_ADMISSION,
      durable: coordinator,
      registry: options.registry,
    }),
    prepare(input) {
      const outcome = preparer.prepare(input);
      if (outcome.kind !== "READY") {
        throw new Error(`Tool call "${input.externalCallId}" was rejected before execution.`);
      }
      return outcome.call;
    },
  };
}
