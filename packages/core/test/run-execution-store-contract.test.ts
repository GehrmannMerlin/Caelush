import type { AgentMessageRecordDraft } from "@caelush/agent";
import type { StepId } from "@caelush/protocol";
import type {
  RunExecutionCommit,
  RunExecutionSnapshot,
  RunExecutionStorePort,
} from "../src/run-execution-store.js";
import { describe, expect, it } from "vitest";

describe("RunExecutionStorePort", () => {
  it("models a durable snapshot and one atomic execution boundary", async () => {
    const stepId = "stp_01a04963-5904-73ad-909e-2134fe57547e" as StepId;
    const draft = {} as AgentMessageRecordDraft;
    const store: RunExecutionStorePort = {
      load: async () =>
        ({ run: undefined as never, conversationRecords: [] }) satisfies RunExecutionSnapshot,
      commit: async (command: RunExecutionCommit) => {
        expect(command.expectedStateRevision).toBe(5);
        expect(command.expectedContinuationRevision).toBe(2);
        expect(command.messagesToAppend[0]?.draft).toBe(draft);
        expect(command.stepWrites[0]?.step.id).toBe(stepId);
        return { snapshot: undefined as never, events: [] };
      },
      requestCancellation: async (_runId, intent) => ({
        run: undefined as never,
        conversationRecords: [],
        cancellationIntent: intent,
      }),
    };
    const result = await store.commit({
      run: undefined as never,
      state: undefined as never,
      expectedStateRevision: 5,
      expectedContinuationRevision: 2,
      stepWrites: [{ operation: "UPDATE", step: { id: stepId } as never }],
      messagesToAppend: [{ draft }],
      continuation: { operation: "CLEAR" },
      events: [],
    });

    expect(result.events).toEqual([]);
  });
});
