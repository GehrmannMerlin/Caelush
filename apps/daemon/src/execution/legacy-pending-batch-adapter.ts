import type {
  AgentMessageCodecRegistry,
  DurableToolExecutionCoordinator,
  ToolExecutionSnapshot,
} from "@caelush/agent";
import type { StepId } from "@caelush/protocol";
import type {
  LegacyPendingBatchDispatcherPort,
  LegacyPendingBatchInspectionPort,
  LegacyPendingToolCallInspection,
} from "@caelush/core";
import type { CaelushStorage } from "@caelush/storage";

/** The only daemon bridge used to classify and safely close an old pre-dispatch resource boundary. */
export function createLegacyPendingBatchAdapter(input: {
  readonly storage: Pick<CaelushStorage, "execution" | "toolExecution">;
  readonly codecs: AgentMessageCodecRegistry;
  readonly durable: Pick<DurableToolExecutionCoordinator, "cancelUnstarted">;
}): {
  readonly inspection: LegacyPendingBatchInspectionPort;
  readonly dispatcher: LegacyPendingBatchDispatcherPort;
} {
  const inspection: LegacyPendingBatchInspectionPort = {
    async inspect(request) {
      const run = await input.storage.execution.load(request.runId);
      if (run === null) {
        return request.calls.map((call) => ({
          ...call,
          kind: "INVALID" as const,
          reasonCode: "IDENTITY_MISMATCH" as const,
        }));
      }
      const results: LegacyPendingToolCallInspection[] = [];
      for (const call of request.calls) {
        const execution = await input.storage.toolExecution.findByExternalCall(
          request.runId,
          request.sourceStepId as StepId,
          call.externalCallId,
        );
        if (execution === null) {
          results.push({ ...call, kind: "NOT_DISPATCHED" });
          continue;
        }
        const invocation = execution.invocation;
        if (
          invocation.runId !== request.runId ||
          invocation.stepId !== request.sourceStepId ||
          invocation.externalCallId !== call.externalCallId ||
          invocation.toolName !== call.toolName
        ) {
          results.push({ ...call, kind: "INVALID", reasonCode: "IDENTITY_MISMATCH" });
          continue;
        }
        switch (invocation.status) {
          case "REQUESTED":
            results.push({ ...call, kind: "REQUESTED" });
            break;
          case "WAITING_APPROVAL":
            if (
              execution.approval === undefined ||
              execution.approval.runId !== request.runId ||
              execution.approval.toolInvocationId !== invocation.id
            ) {
              results.push({ ...call, kind: "INVALID", reasonCode: "IDENTITY_MISMATCH" });
              break;
            }
            results.push({
              ...call,
              kind: "WAITING_APPROVAL",
              invocationId: invocation.id,
              approvalId: execution.approval.id,
            });
            break;
          case "RUNNING":
            results.push({ ...call, kind: "RUNNING_UNKNOWN" });
            break;
          case "CANCELLED":
            if (invocation.startedAt === undefined) {
              results.push({ ...call, kind: "NOT_DISPATCHED" });
              break;
            }
            results.push({ ...call, kind: "RUNNING_UNKNOWN" });
            break;
          case "COMPLETED":
          case "FAILED": {
            const observation = execution.observation;
            if (
              observation === undefined ||
              observation.runId !== request.runId ||
              observation.stepId !== request.sourceStepId ||
              observation.toolInvocationId !== invocation.id
            ) {
              results.push({ ...call, kind: "INVALID", reasonCode: "MISSING_OBSERVATION" });
              break;
            }
            const matchingMessages = run.conversationRecords.flatMap((record) => {
              if (
                record.messageType !== "TOOL_RESULT" ||
                record.sourceStepId !== request.sourceStepId
              ) {
                return [];
              }
              const message = input.codecs.decode(record);
              if (
                message.type !== "TOOL_RESULT" ||
                message.toolCallId !== call.externalCallId ||
                message.toolName !== call.toolName ||
                message.observation.kind !== "OBSERVATION" ||
                message.observation.observationId !== observation.id
              ) {
                return [];
              }
              return [{ record, message }];
            });
            const accepted = matchingMessages[0];
            if (matchingMessages.length !== 1 || accepted === undefined) {
              results.push({ ...call, kind: "INVALID", reasonCode: "MISSING_OBSERVATION" });
              break;
            }
            results.push({
              ...call,
              kind: "SETTLED",
              observation: {
                runId: observation.runId,
                sourceStepId: observation.stepId,
                invocationId: observation.toolInvocationId,
                observationId: observation.id,
                content: observation.content,
                isError: observation.isError,
              },
              message: {
                messageId: accepted.record.messageId,
                content: accepted.message.projectedContent,
                isError: accepted.message.isError,
              },
            });
            break;
          }
        }
      }
      return results;
    },
  };

  const dispatcher: LegacyPendingBatchDispatcherPort = {
    async cancelUnstarted(request) {
      const execution = await input.storage.toolExecution.findByExternalCall(
        request.runId,
        request.sourceStepId as StepId,
        request.externalCallId,
      );
      if (execution === null) return;
      const invocation = execution.invocation;
      if (
        invocation.runId !== request.runId ||
        invocation.stepId !== request.sourceStepId ||
        invocation.externalCallId !== request.externalCallId ||
        invocation.toolName !== request.toolName
      ) {
        throw new TypeError(
          "Historical Tool invocation identity does not match its resource boundary.",
        );
      }
      if (invocation.status !== "REQUESTED") return;
      const outcome = await input.durable.cancelUnstarted(execution as ToolExecutionSnapshot);
      if (outcome.kind !== "CANCELLED" || outcome.invocation.status !== "CANCELLED") {
        throw new TypeError("The Tool lifecycle did not durably close the unstarted invocation.");
      }
    },
  };
  return Object.freeze({ inspection, dispatcher });
}
