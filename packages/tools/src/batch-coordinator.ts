import {
  JsonObjectSchema,
  RunIdSchema,
  SessionIdSchema,
  StepIdSchema,
  ToolNameSchema,
  type ToolDefinition,
} from "@caelush/protocol";
import { DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES } from "./dispatcher-types.js";
import {
  ToolDispatcherBusyError,
  ToolDispatcherInfrastructureError,
  ToolDispatcherInvariantError,
} from "./dispatcher-errors.js";
import type {
  ToolDispatchRequest,
  ToolDispatcherOutcome,
  ToolResultOutcome,
} from "./dispatcher-types.js";
import { isUncertainToolExecution } from "./execution-disposition.js";
import { ToolExecutionConflictError } from "./execution-store.js";
import { ToolBatchInputError, ToolBatchInfrastructureError } from "./batch-errors.js";
import type {
  ToolBatchCompletedOutcome,
  ToolBatchItem,
  ToolBatchItemResult,
  ToolBatchOutcome,
  ToolBatchRequest,
  ToolBatchWaitingApprovalOutcome,
  ToolBatchCoordinatorPort,
} from "./batch-types.js";
import type { ToolDispatcher } from "./dispatcher.js";
import { assertToolExecutionEnvironment } from "./execution-environment.js";
import { assertToolSecurityContext } from "./security-context.js";

const UNCERTAIN_SKIP_CONTENT =
  "This tool call was skipped because an earlier tool execution may have partially or fully completed before the runtime was interrupted. Re-evaluate the current project state before issuing dependent or repeated tool calls.";

export class ToolBatchCoordinator implements ToolBatchCoordinatorPort {
  constructor(private readonly dispatcher: ToolDispatcher) {}

  modelDefinitions(): readonly ToolDefinition[] {
    return this.dispatcher.modelDefinitions();
  }

  async execute(request: ToolBatchRequest): Promise<ToolBatchOutcome> {
    const valid = assertToolBatchRequest(request);
    return this.executeItems(valid, "dispatch");
  }

  async recover(request: ToolBatchRequest): Promise<ToolBatchOutcome> {
    const valid = assertToolBatchRequest(request);
    return this.executeItems(valid, "recoverOrDispatch");
  }

  private async executeItems(
    request: ToolBatchRequest,
    mode: "dispatch" | "recoverOrDispatch",
  ): Promise<ToolBatchOutcome> {
    const results: ToolBatchItemResult[] = [];
    let uncertain = false;
    for (const [index, item] of request.items.entries()) {
      if (request.signal?.aborted) return { kind: "COMPLETED", results };
      if (uncertain) {
        results.push(skippedResult(item));
        continue;
      }
      let outcome: ToolDispatcherOutcome;
      try {
        outcome = await this.dispatcher[mode](toDispatchRequest(request, item));
      } catch (error) {
        if (
          error instanceof ToolDispatcherBusyError ||
          error instanceof ToolDispatcherInfrastructureError ||
          error instanceof ToolDispatcherInvariantError ||
          error instanceof ToolExecutionConflictError
        ) {
          throw new ToolBatchInfrastructureError(undefined, { cause: error });
        }
        throw error;
      }
      if (outcome.kind === "WAITING_APPROVAL") {
        const waiting: ToolBatchWaitingApprovalOutcome = {
          kind: "WAITING_APPROVAL",
          completedResults: results,
          waiting: {
            index,
            invocationId: outcome.invocation.id,
            ...(outcome.approvalId === undefined ? {} : { approvalId: outcome.approvalId }),
            externalCallId: item.externalCallId,
            toolName: item.toolName,
          },
        };
        return waiting;
      }
      const result = toItemResult(item, outcome);
      results.push(result);
      uncertain = outcome.kind === "RESULT" && isUncertainToolExecution(outcome.invocation);
    }
    const complete: ToolBatchCompletedOutcome = { kind: "COMPLETED", results };
    return complete;
  }
}

export function assertToolBatchRequest(value: unknown): ToolBatchRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolBatchInputError();
  }
  const request = value as Record<string, unknown>;
  if (
    (Object.keys(request).length !== 6 && Object.keys(request).length !== 7) ||
    !Object.hasOwn(request, "sessionId") ||
    !Object.hasOwn(request, "runId") ||
    !Object.hasOwn(request, "stepId") ||
    !Object.hasOwn(request, "environment") ||
    !Object.hasOwn(request, "securityContext") ||
    !Object.hasOwn(request, "items") ||
    !SessionIdSchema.safeParse(request.sessionId).success ||
    !RunIdSchema.safeParse(request.runId).success ||
    !StepIdSchema.safeParse(request.stepId).success ||
    !Array.isArray(request.items) ||
    request.items.length === 0 ||
    (Object.hasOwn(request, "signal") && !(request.signal instanceof AbortSignal))
  ) {
    throw new ToolBatchInputError();
  }
  try {
    assertToolExecutionEnvironment(request.environment);
    assertToolSecurityContext(request.securityContext);
  } catch {
    throw new ToolBatchInputError();
  }
  const ids = new Set<string>();
  const items: ToolBatchItem[] = [];
  for (const value of request.items) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ToolBatchInputError();
    }
    const item = value as Record<string, unknown>;
    const externalCallId =
      typeof item.externalCallId === "string" ? item.externalCallId : undefined;
    const parsedToolName = ToolNameSchema.safeParse(item.toolName);
    const parsedArgs = JsonObjectSchema.safeParse(item.args);
    if (
      Object.keys(item).length !== 3 ||
      externalCallId === undefined ||
      externalCallId.length === 0 ||
      Buffer.byteLength(externalCallId, "utf8") > DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES ||
      ids.has(externalCallId) ||
      !parsedToolName.success ||
      !parsedArgs.success
    ) {
      throw new ToolBatchInputError();
    }
    ids.add(externalCallId);
    items.push({
      externalCallId,
      toolName: parsedToolName.data,
      args: parsedArgs.data,
    });
  }
  const parsedSessionId = SessionIdSchema.parse(request.sessionId);
  const parsedRunId = RunIdSchema.parse(request.runId);
  const parsedStepId = StepIdSchema.parse(request.stepId);
  return {
    ...(request.signal === undefined ? {} : { signal: request.signal as AbortSignal }),
    sessionId: parsedSessionId,
    runId: parsedRunId,
    stepId: parsedStepId,
    environment: request.environment,
    securityContext: request.securityContext,
    items,
  };
}

function toDispatchRequest(request: ToolBatchRequest, item: ToolBatchItem): ToolDispatchRequest {
  return {
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    sessionId: request.sessionId,
    runId: request.runId,
    stepId: request.stepId,
    environment: request.environment,
    securityContext: request.securityContext,
    externalCallId: item.externalCallId,
    toolName: item.toolName,
    args: item.args,
  };
}

function toItemResult(
  item: ToolBatchItem,
  outcome: Exclude<ToolDispatcherOutcome, { kind: "WAITING_APPROVAL" }>,
): ToolBatchItemResult {
  if (outcome.kind === "UNAVAILABLE_TOOL") {
    return {
      kind: "UNAVAILABLE_TOOL",
      externalCallId: item.externalCallId,
      toolName: item.toolName,
      content: outcome.content,
      isError: true,
    };
  }
  const result: ToolResultOutcome = outcome;
  return {
    kind: "TOOL_RESULT",
    externalCallId: item.externalCallId,
    toolName: item.toolName,
    content: result.observation.content,
    isError: result.observation.isError,
    invocationId: result.invocation.id,
    observationId: result.observation.id,
  };
}

function skippedResult(item: ToolBatchItem): ToolBatchItemResult {
  return {
    kind: "SKIPPED_AFTER_UNCERTAIN_EXECUTION",
    externalCallId: item.externalCallId,
    toolName: item.toolName,
    content: UNCERTAIN_SKIP_CONTENT,
    isError: true,
  };
}
