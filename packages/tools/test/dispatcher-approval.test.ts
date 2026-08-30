import {
  ApprovalRequestSchema,
  createApprovalRequestId,
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ApprovalRequest,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  ToolDispatcher,
  ToolRegistryBuilder,
  type DurableToolAgentEvent,
  type ToolApprovalStorePort,
  type ToolExecutionCommit,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
  type ToolExecutionResult,
} from "../src/index.js";

class Store implements ToolExecutionStorePort {
  readonly snapshots = new Map<string, ToolExecutionSnapshot>();
  readonly events: DurableToolAgentEvent[] = [];
  async load(id: string) {
    return this.snapshots.get(id) ?? null;
  }
  async findByExternalCall(runId: string, stepId: string, externalCallId: string) {
    return (
      [...this.snapshots.values()].find(
        ({ invocation }) =>
          invocation.runId === runId &&
          invocation.stepId === stepId &&
          invocation.externalCallId === externalCallId,
      ) ?? null
    );
  }
  async commit(command: ToolExecutionCommit) {
    const existing = this.snapshots.get(command.invocation.id);
    if ((existing?.revision ?? null) !== command.expectedRevision)
      throw new Error("revision conflict");
    const snapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (existing?.revision ?? 0) + 1,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
      ...(command.approval === undefined ? {} : { approval: command.approval }),
    } satisfies ToolExecutionSnapshot;
    this.snapshots.set(command.invocation.id, snapshot);
    const events = command.events.map((event, index) => ({
      ...event,
      durability: { ...event.durability, sequence: this.events.length + index + 1 },
    })) as DurableToolAgentEvent[];
    this.events.push(...events);
    return { snapshot, events };
  }
}

class Approvals implements ToolApprovalStorePort {
  approval: ApprovalRequest | null = null;
  async getByInvocation() {
    return this.approval;
  }
  async findApplicableRunGrant() {
    return this.approval?.status === "APPROVED" && this.approval.grantedScope === "RUN"
      ? this.approval
      : null;
  }
}

const request = {
  sessionId: createSessionId(),
  runId: createRunId(),
  stepId: createStepId(),
  externalCallId: "call-1",
  toolName: "echo_value" as const,
  args: { value: "hello" },
  environment: {
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    runtime: { id: "local", kind: "local" },
  },
  securityContext: {
    permissionProfile: "FULL_ACCESS" as const,
    approvalPolicy: "ALWAYS_ASK" as const,
  },
};

function makeDispatcher(
  store: Store,
  approvals: Approvals,
  execute: () => Promise<ToolExecutionResult>,
) {
  const definition = {
    name: "echo_value" as const,
    description: "Echo",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { echoed: { type: "string" } },
      required: ["echoed"],
      additionalProperties: false,
    },
    riskLevel: "HIGH" as const,
    requiredCapabilities: [],
    runtimeRequirements: {},
  };
  const builder = new ToolRegistryBuilder();
  builder.register({ definition, handler: { execute: async () => execute() } });
  return new ToolDispatcher({
    registry: builder.build(),
    store,
    gate: {
      decide: async () => ({ kind: "REQUIRE_APPROVAL" as const, safeReason: "Review required." }),
    },
    notifier: { notifyCommitted() {} },
    clock: { now: () => createTimestampMs(Date.now()) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    approvalStore: approvals,
    approvalIdFactory: { create: createApprovalRequestId },
  });
}

describe("Dispatcher durable approvals", () => {
  it("creates one safe pending approval and later resumes the exact invocation", async () => {
    const store = new Store();
    const approvals = new Approvals();
    let executions = 0;
    const dispatcher = makeDispatcher(store, approvals, async () => {
      executions += 1;
      return { content: "ok", details: { echoed: "hello" }, isError: false };
    });
    const first = await dispatcher.dispatch(request);
    expect(first.kind).toBe("WAITING_APPROVAL");
    expect(executions).toBe(0);
    expect(store.events.map(({ type }) => type)).toEqual(["tool.requested", "approval.requested"]);
    const snapshot = [...store.snapshots.values()][0]!;
    approvals.approval = ApprovalRequestSchema.parse({
      ...snapshot.approval!,
      status: "APPROVED",
      grantedScope: "ONCE",
      resolvedAt: createTimestampMs(Date.now()),
    });
    const resumed = await dispatcher.recover(
      snapshot.invocation.id,
      request.environment,
      request.securityContext,
    );
    expect(resumed.kind).toBe("RESULT");
    expect(executions).toBe(1);
    expect(store.events.map(({ type }) => type)).toEqual([
      "tool.requested",
      "approval.requested",
      "tool.started",
      "tool.completed",
    ]);
  });
});
