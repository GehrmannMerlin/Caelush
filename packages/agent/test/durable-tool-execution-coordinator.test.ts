import {
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
  type ToolInvocation,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@caelush/ai";
import {
  createDurableToolExecutionCoordinator,
  createRequestedToolInvocation,
  createToolAdmissionCoordinator,
  createToolFailureSettlement,
  createToolSettlementCoordinator,
  ToolExecutionConflictError,
  ToolExecutionUncertainError,
  type AgentBudgetBlock,
  type DurableToolExecutionCoordinator,
  type ToolAdmissionPort,
  type ToolExecutionCommit,
  type ToolExecutionCommitResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
  type ToolPolicyDecision,
} from "@caelush/agent";

/**
 * `DurableToolExecutionCoordinator` — the Tool Invocation Lifecycle Authority.
 *
 * ```text
 * idempotency lookup → REQUESTED → admission → RUNNING → execute → pipeline → settle
 * ```
 *
 * These tests drive the real coordinator over a fake durable store, so what they observe is the
 * sequence of durable states it commits and the outcomes it returns — not a mock's call log.
 */

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

const securityContext = {
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
} as const;

/** A durable store that behaves like the real one: revision-checked, ordered, and honest. */
class FakeStore implements ToolExecutionStorePort {
  readonly snapshots = new Map<string, ToolExecutionSnapshot>();
  readonly commits: ToolExecutionCommit[] = [];
  conflictOnCommit: number | undefined;

  async load(invocationId: string): Promise<ToolExecutionSnapshot | null> {
    return this.snapshots.get(invocationId) ?? null;
  }

  async findByExternalCall(
    runId: string,
    stepId: string,
    externalCallId: string,
  ): Promise<ToolExecutionSnapshot | null> {
    return (
      [...this.snapshots.values()].find(
        ({ invocation }) =>
          invocation.runId === runId &&
          invocation.stepId === stepId &&
          invocation.externalCallId === externalCallId,
      ) ?? null
    );
  }

  async commit(command: ToolExecutionCommit): Promise<ToolExecutionCommitResult> {
    if (this.snapshots.size === this.conflictOnCommit) {
      throw new ToolExecutionConflictError("revision conflict");
    }
    const current = this.snapshots.get(command.invocation.id);
    if ((current?.revision ?? null) !== command.expectedRevision) {
      throw new ToolExecutionConflictError("revision conflict");
    }
    this.commits.push(command);
    const snapshot: ToolExecutionSnapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (current?.revision ?? 0) + 1,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
      ...(command.approval === undefined ? {} : { approval: command.approval }),
    };
    this.snapshots.set(command.invocation.id, snapshot);
    return { snapshot, events: [] as never };
  }

  seed(snapshot: ToolExecutionSnapshot): void {
    this.snapshots.set(snapshot.invocation.id, snapshot);
  }
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: createApprovalRequestId(),
    runId: createRunId(),
    toolInvocationId: createToolInvocationId(),
    riskLevel: "LOW",
    title: "Approve Tool execution",
    reason: "Review required.",
    action: { kind: "TOOL_EXECUTION" },
    status: "PENDING",
    scope: "RUN",
    expiresAt: createTimestampMs(900_000),
    createdAt: createTimestampMs(200),
    ...overrides,
  } as ApprovalRequest;
}

interface Harness {
  readonly coordinator: DurableToolExecutionCoordinator;
  readonly store: FakeStore;
  readonly executions: () => number;
  readonly admissionCalls: () => number;
  readonly approvals: ApprovalRequest[];
  readonly setDecision: (decision: ToolPolicyDecision) => void;
  readonly setGrant: (grant: ApprovalRequest | null) => void;
  readonly storedApprovalKey: () => string | null | undefined;
  readonly setStoredApprovalKey: (value: string | null | undefined) => void;
  readonly setBudgetBlock: (block: AgentBudgetBlock | null) => void;
}

function harness(options: {
  readonly execute?: () => Promise<{
    content: string;
    details: Record<string, unknown>;
    isError: boolean;
  }>;
  readonly decision?: ToolPolicyDecision;
  readonly approvalLookup?: boolean;
}): Harness {
  const store = new FakeStore();
  let executions = 0;
  let admissionCalls = 0;
  let decision: ToolPolicyDecision = options.decision ?? { kind: "ALLOW" };
  let grant: ApprovalRequest | null = null;
  let storedApprovalKey: string | null | undefined = null;
  let budgetBlock: AgentBudgetBlock | null = null;
  const approvals: ApprovalRequest[] = [];
  let now = 100;

  const policy: ToolAdmissionPort = {
    async evaluate() {
      admissionCalls += 1;
      return decision;
    },
  };
  const admission = createToolAdmissionCoordinator({
    policy,
    ...(options.approvalLookup === true
      ? {
          approvals: {
            async getByInvocation() {
              return approvals[0] ?? null;
            },
            async getStoredApprovalKey() {
              return storedApprovalKey;
            },
            async findApplicableRunGrant() {
              return grant;
            },
          },
          approvalRequests: ({ identity }) => {
            const request = approval({
              toolInvocationId: identity.invocationId,
              runId: identity.runId,
            });
            approvals.push(request);
            return request;
          },
        }
      : {}),
    budget: {
      async admit() {
        return budgetBlock;
      },
    },
    clock: { now: () => createTimestampMs(++now) },
    eventIdFactory: { create: createEventId },
  });

  const coordinator = createDurableToolExecutionCoordinator({
    store,
    admission,
    metadata: { get: () => ({ riskLevel: "LOW" as const }) },
    approvalRequests: () => {
      const request = approval();
      approvals.push(request);
      return request;
    },
    ...(options.approvalLookup === true
      ? {
          approvalLookup: {
            async getByInvocation() {
              return approvals[0] ?? null;
            },
            async getStoredApprovalKey() {
              return storedApprovalKey;
            },
            async findApplicableRunGrant() {
              return grant;
            },
          },
        }
      : {}),
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    clock: { now: () => createTimestampMs(++now) },
    invocationExecutorFactory: () => ({
      async execute(): Promise<{ content: string; details: JsonObject; isError: boolean }> {
        executions += 1;
        const produced = await (options.execute?.() ??
          Promise.resolve({ content: "ok", details: {}, isError: false }));
        // The harness may declare its result with a looser `Record<string, unknown>`, because a test
        // that throws before returning never builds one. The frozen shape is asserted here, once, at
        // the single place the harness turns a test's value into a Tool result.
        return { ...produced, details: produced.details as JsonObject };
      },
    }),
    updateSanitizer: { sanitize: () => null },
    resultPipelineFactory: () => ({
      process: ({ rawResult }) => ({ result: rawResult }),
    }),
    preparedCallFactory: ({ invocation, externalCallId }) => ({
      request: Object.freeze({
        externalCallId,
        toolName: invocation.toolName,
        args: invocation.args,
      }),
      resolved: { tool: { name: invocation.toolName } } as never,
      args: invocation.args,
    }),
    failureSettlement: createToolFailureSettlement({
      store,
      clock: { now: () => createTimestampMs(++now) },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
      boundContent: (content) => content,
    }),
  });

  return {
    coordinator,
    store,
    executions: () => executions,
    admissionCalls: () => admissionCalls,
    approvals,
    setDecision: (value) => {
      decision = value;
    },
    setGrant: (value) => {
      grant = value;
    },
    storedApprovalKey(): string | null | undefined {
      return storedApprovalKey;
    },
    setStoredApprovalKey: (value) => {
      storedApprovalKey = value;
    },
    setBudgetBlock: (value) => {
      budgetBlock = value;
    },
  };
}

function request(overrides: { args?: Record<string, unknown>; toolName?: string } = {}) {
  return {
    runId: createRunId(),
    sessionId: createSessionId(),
    sourceStepId: createStepId(),
    call: {
      request: Object.freeze({
        externalCallId: "call-1",
        toolName: (overrides.toolName ?? "echo_value") as never,
        args: (overrides.args ?? { value: "hello" }) as never,
      }),
      resolved: { tool: { name: overrides.toolName ?? "echo_value" } } as never,
      args: (overrides.args ?? { value: "hello" }) as never,
    },
    environment,
    securityContext,
    signal: new AbortController().signal,
  };
}

function seeded(status: ToolInvocation["status"], overrides: Partial<ToolInvocation> = {}) {
  const base = createRequestedToolInvocation({
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    toolName: "echo_value",
    externalCallId: "call-1",
    args: { value: "hello" },
    riskLevel: "LOW",
    // Well before the harness clock's first read, so a settlement's own timestamp is necessarily
    // later than the lifecycle start regardless of how many clock reads preceded it.
    createdAt: createTimestampMs(10),
  });
  return { ...base, status, ...overrides } as ToolInvocation;
}

describe("DurableToolExecutionCoordinator", () => {
  it("settles a new READY call with a durable observation", async () => {
    const h = harness({});
    const outcome = await h.coordinator.execute(request());

    expect(outcome.kind).toBe("SETTLED");
    if (outcome.kind !== "SETTLED") throw new Error("expected settlement");
    expect(outcome.invocation.status).toBe("COMPLETED");
    expect(outcome.observation.isError).toBe(false);
    expect(h.executions()).toBe(1);
    // REQUESTED, RUNNING, COMPLETED — one durable commit each, in that order.
    expect(h.store.commits.map(({ invocation }) => invocation.status)).toEqual([
      "REQUESTED",
      "RUNNING",
      "COMPLETED",
    ]);
  });

  it("durably commits RUNNING before the executor runs", async () => {
    const order: string[] = [];
    const h = harness({
      execute: async () => {
        order.push("execute");
        return { content: "ok", details: {} as JsonObject, isError: false };
      },
    });
    const original = h.store.commit.bind(h.store);
    h.store.commit = async (command: ToolExecutionCommit) => {
      order.push(`commit:${command.invocation.status}`);
      return await original(command);
    };

    await h.coordinator.execute(request());

    expect(order).toEqual(["commit:REQUESTED", "commit:RUNNING", "execute", "commit:COMPLETED"]);
  });

  it("returns the durable result for an exact duplicate without executing twice", async () => {
    const h = harness({});
    const call = request();
    const first = await h.coordinator.execute(call);
    const second = await h.coordinator.execute(call);

    expect(second.kind).toBe("SETTLED");
    expect(h.executions()).toBe(1);
    if (first.kind !== "SETTLED" || second.kind !== "SETTLED")
      throw new Error("expected settlement");
    expect(second.invocation.status).toBe("COMPLETED");
    expect(second.observation.isError).toBe(false);
  });

  it("refuses an existing call whose identity differs", async () => {
    const h = harness({});
    const call = request();
    await h.coordinator.execute(call);

    await expect(
      h.coordinator.execute({
        ...call,
        call: { ...call.call, args: { value: "different" } } as never,
      }),
    ).rejects.toBeInstanceOf(ToolExecutionConflictError);
    expect(h.executions()).toBe(1);
  });

  it("re-enters admission for a durable REQUESTED invocation", async () => {
    const h = harness({});
    const pending = seeded("REQUESTED");
    h.store.seed({ sessionId: createSessionId(), invocation: pending, revision: 1 });

    const outcome = await h.coordinator.recover(
      { sessionId: createSessionId(), invocation: pending, revision: 1 },
      { environment, securityContext, signal: new AbortController().signal },
    );

    expect(outcome.kind).toBe("SETTLED");
    expect(h.admissionCalls()).toBeGreaterThan(0);
    expect(h.executions()).toBe(1);
  });

  it("never re-executes a durable RUNNING invocation and records uncertainty instead", async () => {
    const h = harness({});
    const running = seeded("RUNNING", {
      // After `createdAt` (10) and before the harness clock's first read (100), so the uncertainty
      // settlement's own timestamp is necessarily later than the lifecycle start.
      startedAt: createTimestampMs(20) as never,
    });
    // The store holds no row for a seeded invocation unless a test seeds one, and the revision of a
    // snapshot the store has not written yet is null.
    const snapshot = { sessionId: createSessionId(), invocation: running, revision: null as never };

    const outcome = await h.coordinator.recover(snapshot, {
      environment,
      securityContext,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("SETTLED");
    // The proof the requirement turns on: the executor was never reached.
    expect(h.executions()).toBe(0);
    if (outcome.kind !== "SETTLED") throw new Error("expected settlement");
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.invocation.error?.details?.executionDisposition).toBe("UNCERTAIN_SIDE_EFFECT");
    expect(outcome.observation.isError).toBe(true);
  });

  it("returns the existing observation for a COMPLETED invocation without a second event", async () => {
    const h = harness({});
    const completed = seeded("COMPLETED", {
      startedAt: createTimestampMs(110) as never,
      finishedAt: createTimestampMs(120) as never,
    });
    const observation = {
      id: createObservationId(),
      runId: completed.runId,
      stepId: completed.stepId,
      kind: "TOOL" as const,
      toolInvocationId: completed.id,
      content: "already done",
      details: {},
      isError: false,
      createdAt: createTimestampMs(120) as never,
    };
    const snapshot = {
      sessionId: createSessionId(),
      invocation: completed,
      revision: 3,
      observation,
    };

    const outcome = await h.coordinator.recover(snapshot as never, {
      environment,
      securityContext,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("SETTLED");
    if (outcome.kind !== "SETTLED") throw new Error("expected settlement");
    expect(outcome.observation.content).toBe("already done");
    expect(h.executions()).toBe(0);
    expect(h.store.commits).toHaveLength(0);
  });

  it("returns the existing observation for a FAILED invocation", async () => {
    const h = harness({});
    const failed = seeded("FAILED", {
      startedAt: createTimestampMs(110) as never,
      finishedAt: createTimestampMs(120) as never,
      error: {
        code: "TOOL_EXECUTION_ERROR",
        message: "Tool execution returned an error result.",
        retryable: false,
        phase: "TOOL",
      },
    });
    const observation = {
      id: createObservationId(),
      runId: failed.runId,
      stepId: failed.stepId,
      kind: "TOOL" as const,
      toolInvocationId: failed.id,
      content: "it failed",
      details: {},
      isError: true,
      createdAt: createTimestampMs(120) as never,
    };

    const outcome = await h.coordinator.recover(
      {
        sessionId: createSessionId(),
        invocation: failed,
        revision: 3,
        observation,
      } as never,
      { environment, securityContext, signal: new AbortController().signal },
    );

    expect(outcome.kind).toBe("SETTLED");
    if (outcome.kind !== "SETTLED") throw new Error("expected settlement");
    expect(outcome.observation.isError).toBe(true);
    expect(h.executions()).toBe(0);
  });

  it("returns CANCELLED for a durably cancelled invocation and executes nothing", async () => {
    const h = harness({});
    const cancelled = seeded("CANCELLED", { finishedAt: createTimestampMs(120) as never });

    const outcome = await h.coordinator.recover(
      { sessionId: createSessionId(), invocation: cancelled, revision: 3 },
      { environment, securityContext, signal: new AbortController().signal },
    );

    expect(outcome.kind).toBe("CANCELLED");
    if (outcome.kind !== "CANCELLED") throw new Error("expected cancellation");
    expect(outcome.invocation.status).toBe("CANCELLED");
    expect(outcome.observation).toBeUndefined();
    expect(h.executions()).toBe(0);
  });

  it("classifies an uncertain execution as FAILED with UNCERTAIN_SIDE_EFFECT", async () => {
    const h = harness({
      execute: async () => {
        throw new ToolExecutionUncertainError();
      },
    });

    const outcome = await h.coordinator.execute(request());

    expect(outcome.kind).toBe("SETTLED");
    if (outcome.kind !== "SETTLED") throw new Error("expected settlement");
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.invocation.error?.details?.executionDisposition).toBe("UNCERTAIN_SIDE_EFFECT");
    expect(outcome.observation.isError).toBe(true);
  });

  it("settles a durable RUNTIME_ERROR and then throws infrastructure failure", async () => {
    const h = harness({
      execute: async () => {
        throw new TypeError("internal bug");
      },
    });

    await expect(h.coordinator.execute(request())).rejects.toMatchObject({ phase: "EXECUTION" });
    // The durable evidence was written first: a restart finds the failure, not a stale RUNNING row.
    expect(h.store.commits.map(({ invocation }) => invocation.status)).toEqual([
      "REQUESTED",
      "RUNNING",
      "FAILED",
    ]);
  });

  it("settles a policy denial as a safe failed Tool result", async () => {
    const h = harness({
      decision: {
        kind: "DENY",
        feedback: {
          code: "PERMISSION_DENIED",
          content: "Denied by policy.",
          details: {},
          disposition: "SAFE_FAILURE",
        },
      },
    });

    const outcome = await h.coordinator.execute(request());

    expect(outcome.kind).toBe("SETTLED");
    if (outcome.kind !== "SETTLED") throw new Error("expected settlement");
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.invocation.error?.code).toBe("PERMISSION_DENIED");
    expect(outcome.observation.isError).toBe(true);
    expect(h.executions()).toBe(0);
  });

  it("parks the invocation on approval with the approval in the same commit", async () => {
    const h = harness({
      decision: { kind: "REQUIRE_APPROVAL", requirement: { key: "k", reason: "Review." } },
      approvalLookup: true,
    });

    const outcome = await h.coordinator.execute(request());

    expect(outcome.kind).toBe("WAITING_APPROVAL");
    if (outcome.kind !== "WAITING_APPROVAL") throw new Error("expected a wait");
    expect(outcome.invocation.status).toBe("WAITING_APPROVAL");
    expect(h.executions()).toBe(0);
    const waiting = h.store.commits.at(-1)!;
    // Invocation, approval and the approval key settle in one command.
    expect(waiting.invocation.status).toBe("WAITING_APPROVAL");
    expect(waiting.approval).toBeDefined();
    expect(waiting.approvalKey).toBe("k");
  });

  it("continues to execution when a same-Run grant already covers the key", async () => {
    const h = harness({
      decision: { kind: "REQUIRE_APPROVAL", requirement: { key: "k", reason: "Review." } },
      approvalLookup: true,
    });
    h.setGrant(approval({ status: "APPROVED", grantedScope: "RUN" }));

    const outcome = await h.coordinator.execute(request());

    expect(outcome.kind).toBe("SETTLED");
    expect(h.executions()).toBe(1);
    expect(h.approvals).toHaveLength(0);
  });

  it("fails closed at RECOVERY when the stored approval identity differs", async () => {
    const h = harness({
      decision: { kind: "REQUIRE_APPROVAL", requirement: { key: "k", reason: "Review." } },
      approvalLookup: true,
    });
    // A durable approval exists, resolved APPROVED — but under a different identity.
    h.approvals.push(
      approval({ status: "APPROVED", grantedScope: "RUN", resolvedAt: createTimestampMs(300) }),
    );
    h.setStoredApprovalKey("a-different-key");
    const waiting = seeded("WAITING_APPROVAL");
    const snapshot = { sessionId: createSessionId(), invocation: waiting, revision: 1 };

    await expect(
      h.coordinator.recover(snapshot, {
        environment,
        securityContext,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ phase: "RECOVERY" });
    expect(h.executions()).toBe(0);
  });

  it("keeps a PENDING approval waiting during recovery", async () => {
    const h = harness({ approvalLookup: true });
    h.approvals.push(approval({ status: "PENDING" }));
    const waiting = seeded("WAITING_APPROVAL");

    const outcome = await h.coordinator.recover(
      { sessionId: createSessionId(), invocation: waiting, revision: 1 },
      { environment, securityContext, signal: new AbortController().signal },
    );

    expect(outcome.kind).toBe("WAITING_APPROVAL");
    expect(h.executions()).toBe(0);
  });

  it("settles a rejected approval as a safe failed Tool result", async () => {
    const h = harness({ approvalLookup: true });
    h.approvals.push(approval({ status: "REJECTED", resolvedAt: createTimestampMs(300) }));
    const waiting = seeded("WAITING_APPROVAL");

    const outcome = await h.coordinator.recover(
      { sessionId: createSessionId(), invocation: waiting, revision: null as never },
      { environment, securityContext, signal: new AbortController().signal },
    );

    expect(outcome.kind).toBe("SETTLED");
    if (outcome.kind !== "SETTLED") throw new Error("expected settlement");
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.invocation.error?.code).toBe("APPROVAL_REJECTED");
    expect(h.executions()).toBe(0);
  });

  it("returns the budget block and leaves no REQUESTED invocation behind", async () => {
    const block: AgentBudgetBlock = {
      kind: "EXCEEDED",
      dimension: "TOOL_CALLS",
      accounted: 8,
      limit: 8,
    };
    const h = harness({});
    h.setBudgetBlock(block);

    const outcome = await h.coordinator.execute(request());

    expect(outcome.kind).toBe("BUDGET_EXCEEDED");
    if (outcome.kind !== "BUDGET_EXCEEDED") throw new Error("expected a block");
    expect(outcome.block).toEqual(block);
    expect(outcome.invocation.status).toBe("FAILED");
    expect(h.executions()).toBe(0);
  });

  it("names the phase of a settlement commit failure", async () => {
    const h = harness({});
    const original = h.store.commit.bind(h.store);
    h.store.commit = async (command: ToolExecutionCommit) => {
      if (command.invocation.status === "COMPLETED") throw new Error("disk went away");
      return await original(command);
    };

    await expect(h.coordinator.execute(request())).rejects.toMatchObject({
      name: "ToolExecutionInfrastructureError",
    });
    // The invocation stays RUNNING: the durable answer was never written.
    expect([...h.store.snapshots.values()][0]?.invocation.status).toBe("RUNNING");
  });

  it("refuses an aborted call before any durable boundary", async () => {
    const h = harness({});
    const controller = new AbortController();
    controller.abort();

    await expect(
      h.coordinator.execute({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "ToolExecutionAbortedError" });
    expect(h.store.commits).toHaveLength(0);
  });

  it("blocks a concurrent duplicate in the same process", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      execute: async () => {
        await blocked;
        return { content: "ok", details: {} as JsonObject, isError: false };
      },
    });
    const call = request();
    const first = h.coordinator.execute(call);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(h.coordinator.execute(call)).rejects.toMatchObject({
      name: "ToolCallBusyError",
    });
    release();
    await first;
    expect(h.executions()).toBe(1);
  });

  it("exposes exactly the two frozen methods", async () => {
    const h = harness({});
    expect(Object.keys(h.coordinator).sort()).toEqual(["execute", "recover"]);
  });

  it("does not settle a second time when the observation is already durable", async () => {
    const h = harness({});
    const call = request();
    await h.coordinator.execute(call);
    const commitsAfterFirst = h.store.commits.length;

    const second = await h.coordinator.execute(call);

    expect(second.kind).toBe("SETTLED");
    expect(h.store.commits.length).toBe(commitsAfterFirst);
    expect(h.executions()).toBe(1);
  });

  it("keeps the settlement coordinator's three-field input frozen", async () => {
    const store = new FakeStore();
    let now = 100;
    const settlement = createToolSettlementCoordinator({
      store,
      clock: { now: () => createTimestampMs(++now) },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
    });
    expect(Object.keys(settlement)).toEqual(["settle"]);
    // The frozen signature has three parameters, and adding a fourth for a host archive locator,
    // a budget handle or a Run reference would be a contract expansion this round refuses.
    expect(settlement.settle.length).toBe(1);
    expect(vi.isMockFunction(settlement.settle)).toBe(false);
  });
});
