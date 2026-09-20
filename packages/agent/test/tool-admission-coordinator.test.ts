import {
  createApprovalRequestId,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ApprovalRequest,
  type ToolInvocation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createToolAdmissionCoordinator,
  createRequestedToolInvocation,
  ToolExecutionInfrastructureError,
  type AgentBudgetBlock,
  type ToolAdmissionOutcome,
  type ToolAdmissionPort,
  type ToolAdmissionRequest,
  type ToolApprovalLookupPort,
  type ToolFailureFeedback,
  type PreparedToolCall,
  type ToolPolicyDecision,
} from "@caelush/agent";

/**
 * `ToolAdmissionCoordinator` — policy, approval and budget admission.
 *
 * ```text
 * pre-check → policy → approval handling → budget admission
 * ```
 *
 * The coordinator owns *whether* a Tool may run. It never runs one, never settles one and never writes
 * Run status, and these tests assert that as much as they assert the four outcomes.
 */

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

const securityContext = {
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
} as const;

function invocation(): ToolInvocation {
  return createRequestedToolInvocation({
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    toolName: "echo_value",
    externalCallId: "call-1",
    args: { value: "hello" },
    riskLevel: "LOW",
    createdAt: createTimestampMs(100),
  });
}

function preparedCall(toolName: string): PreparedToolCall {
  return {
    request: Object.freeze({
      externalCallId: "call-1",
      toolName: toolName as never,
      args: { value: "hello" } as never,
    }),
    resolved: { tool: { name: toolName } } as never,
    args: { value: "hello" } as never,
  };
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

const SAFE_FEEDBACK: ToolFailureFeedback = Object.freeze({
  code: "PERMISSION_DENIED",
  content: "Denied by policy.",
  details: Object.freeze({ reasonCode: "NO_CAPABILITY" }),
  disposition: "SAFE_FAILURE",
});

function build(options: {
  readonly decision: ToolPolicyDecision;
  readonly preCheck?: (request: ToolAdmissionRequest) => ToolPolicyDecision | undefined;
  readonly approvals?: ToolApprovalLookupPort;
  readonly approvalRequest?: (input: {
    readonly requirement: { readonly key: string; readonly reason: string };
  }) => ApprovalRequest | null;
  readonly budget?: {
    admit(): Promise<AgentBudgetBlock | null>;
  };
  readonly seen?: { request?: ToolAdmissionRequest; budgetCalls: number };
}) {
  const seen = options.seen ?? { budgetCalls: 0 };
  const policy: ToolAdmissionPort = {
    async evaluate(request: ToolAdmissionRequest): Promise<ToolPolicyDecision> {
      seen.request = request;
      return options.decision;
    },
  };
  return {
    seen,
    coordinator: createToolAdmissionCoordinator({
      policy,
      ...(options.preCheck === undefined ? {} : { preCheck: { check: options.preCheck } }),
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
      ...(options.approvalRequest === undefined
        ? {}
        : {
            approvalRequests: (input: { requirement: { key: string; reason: string } }) =>
              options.approvalRequest!(input),
          }),
      ...(options.budget === undefined
        ? {}
        : {
            budget: {
              async admit(): Promise<AgentBudgetBlock | null> {
                seen.budgetCalls += 1;
                return await options.budget!.admit();
              },
            },
          }),
      clock: { now: () => createTimestampMs(500) },
      eventIdFactory: { create: createEventId },
    }),
  };
}

function admitInput(toolName = "echo_value") {
  const requested = invocation();
  return {
    sessionId: createSessionId(),
    invocation: requested,
    call: preparedCall(toolName),
    environment,
    securityContext,
  };
}

describe("ToolAdmissionCoordinator", () => {
  it("allows a call with no approval requirement and room in the budget", async () => {
    const { coordinator } = build({ decision: { kind: "ALLOW" } });
    const outcome: ToolAdmissionOutcome = await coordinator.admit(admitInput());
    expect(outcome.kind).toBe("ALLOW");
  });

  it("turns a policy denial into safe model-facing feedback", async () => {
    const { coordinator } = build({ decision: { kind: "DENY", feedback: SAFE_FEEDBACK } });
    const outcome = await coordinator.admit(admitInput());
    expect(outcome.kind).toBe("DENY");
    if (outcome.kind !== "DENY") throw new Error("expected a denial");
    expect(outcome.feedback.code).toBe("PERMISSION_DENIED");
    expect(outcome.feedback.content).toBe("Denied by policy.");
    expect(outcome.feedback.disposition).toBe("SAFE_FAILURE");
    // The denial is safe: no raw argument value appears anywhere in what the model would read.
    expect(JSON.stringify(outcome.feedback)).not.toContain("hello");
  });

  it("creates a durable approval when policy requires approval and no grant exists", async () => {
    const created: ApprovalRequest[] = [];
    const { coordinator } = build({
      decision: {
        kind: "REQUIRE_APPROVAL",
        requirement: { key: "opaque-key", reason: "Review required." },
      },
      approvals: {
        async getByInvocation() {
          return null;
        },
        async getStoredApprovalKey() {
          return null;
        },
        async findApplicableRunGrant() {
          return null;
        },
      },
      approvalRequest: ({ requirement }) => {
        const request = approval({ reason: requirement.reason });
        created.push(request);
        return request;
      },
    });

    const outcome = await coordinator.admit(admitInput());

    expect(outcome.kind).toBe("WAITING_APPROVAL");
    if (outcome.kind !== "WAITING_APPROVAL") throw new Error("expected a wait");
    expect(outcome.approvalKey).toBe("opaque-key");
    expect(outcome.approval.reason).toBe("Review required.");
    expect(created).toHaveLength(1);
  });

  it("continues to budget when a matching RUN grant already covers the exact key", async () => {
    const { coordinator, seen } = build({
      decision: {
        kind: "REQUIRE_APPROVAL",
        requirement: { key: "opaque-key", reason: "Review required." },
      },
      approvals: {
        async getByInvocation() {
          return null;
        },
        async getStoredApprovalKey() {
          return null;
        },
        async findApplicableRunGrant({ approvalKey }) {
          return approvalKey === "opaque-key"
            ? approval({ status: "APPROVED", grantedScope: "RUN" })
            : null;
        },
      },
      approvalRequest: () => {
        throw new Error("a grant must not create a second approval request");
      },
      budget: { admit: async () => null },
    });

    const outcome = await coordinator.admit(admitInput());

    expect(outcome.kind).toBe("ALLOW");
    expect(seen.budgetCalls).toBe(1);
  });

  it("does not accept a grant that was resolved under a different identity", async () => {
    const queries: string[] = [];
    const { coordinator } = build({
      decision: {
        kind: "REQUIRE_APPROVAL",
        requirement: { key: "current-key", reason: "Review required." },
      },
      approvals: {
        async getByInvocation() {
          return null;
        },
        async getStoredApprovalKey() {
          return null;
        },
        async findApplicableRunGrant({ approvalKey }) {
          queries.push(approvalKey);
          // The host holds a real APPROVED RUN grant — but under the identity it was *actually*
          // resolved for. An exact-key lookup is therefore the whole of the guarantee.
          return approvalKey === "stale-key"
            ? approval({ status: "APPROVED", grantedScope: "RUN" })
            : null;
        },
      },
      approvalRequest: () => approval(),
    });

    const outcome = await coordinator.admit(admitInput());

    // The lookup used the requirement's own key, and the stale grant did not cover the call.
    expect(queries).toEqual(["current-key"]);
    expect(outcome.kind).toBe("WAITING_APPROVAL");
  });

  it("answers BUDGET_EXCEEDED when the budget refuses the call", async () => {
    const block: AgentBudgetBlock = {
      kind: "EXCEEDED",
      dimension: "TOOL_CALLS",
      accounted: 8,
      limit: 8,
    };
    const { coordinator } = build({
      decision: { kind: "ALLOW" },
      budget: { admit: async () => block },
    });

    const outcome = await coordinator.admit(admitInput());

    expect(outcome.kind).toBe("BUDGET_EXCEEDED");
    if (outcome.kind !== "BUDGET_EXCEEDED") throw new Error("expected a block");
    expect(outcome.block).toEqual(block);
  });

  it("refuses a call before any budget side effect", async () => {
    const { coordinator, seen } = build({
      decision: { kind: "DENY", feedback: SAFE_FEEDBACK },
      budget: { admit: async () => null },
    });

    await coordinator.admit(admitInput());

    // Policy runs first, and the denial short-circuits: a denied call consumes no budget.
    expect(seen.budgetCalls).toBe(0);
  });

  it("consults the host pre-check before the policy port", async () => {
    const order: string[] = [];
    const { coordinator } = build({
      decision: { kind: "ALLOW" },
      preCheck: () => {
        order.push("pre-check");
        return { kind: "DENY", feedback: SAFE_FEEDBACK };
      },
      seen: { budgetCalls: 0 },
    });
    void order;

    const outcome = await coordinator.admit(admitInput());

    expect(outcome.kind).toBe("DENY");
  });

  it("keeps the approval key opaque to the coordinator", async () => {
    const opaque = "9f2c-this-is-not-a-hash-this-layer-computes";
    const { coordinator } = build({
      decision: {
        kind: "REQUIRE_APPROVAL",
        requirement: { key: opaque, reason: "Review required." },
      },
      approvals: {
        async getByInvocation() {
          return null;
        },
        async getStoredApprovalKey() {
          return null;
        },
        async findApplicableRunGrant() {
          return null;
        },
      },
      approvalRequest: () => approval(),
    });

    const outcome = await coordinator.admit(admitInput());

    if (outcome.kind !== "WAITING_APPROVAL") throw new Error("expected a wait");
    // Forwarded unchanged, with no interpretation at all.
    expect(outcome.approvalKey).toBe(opaque);
  });

  it("fails closed when approval is required but the host has no approval infrastructure", async () => {
    const { coordinator } = build({
      decision: {
        kind: "REQUIRE_APPROVAL",
        requirement: { key: "opaque-key", reason: "Review required." },
      },
    });

    await expect(coordinator.admit(admitInput())).rejects.toBeInstanceOf(
      ToolExecutionInfrastructureError,
    );
    await expect(coordinator.admit(admitInput())).rejects.toMatchObject({ phase: "ADMISSION" });
  });

  it("classifies a broken policy port as an ADMISSION infrastructure failure", async () => {
    const coordinator = createToolAdmissionCoordinator({
      policy: {
        async evaluate() {
          throw new Error("the projector is broken");
        },
      },
      clock: { now: () => createTimestampMs(500) },
      eventIdFactory: { create: createEventId },
    });

    await expect(coordinator.admit(admitInput())).rejects.toMatchObject({
      name: "ToolExecutionInfrastructureError",
      phase: "ADMISSION",
    });
  });

  it("never defaults to ALLOW when the policy port cannot be reached", async () => {
    const coordinator = createToolAdmissionCoordinator({
      policy: {
        evaluate() {
          throw new TypeError("missing method");
        },
      },
      clock: { now: () => createTimestampMs(500) },
      eventIdFactory: { create: createEventId },
    });

    const failure = await coordinator.admit(admitInput()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolExecutionInfrastructureError);
    expect((failure as ToolExecutionInfrastructureError).phase).toBe("ADMISSION");
  });

  it("never executes a Tool", async () => {
    // The coordinator has no executor, no store and no pipeline: there is nothing it *could* execute
    // with. This asserts the shape rather than a call count, which is the stronger statement.
    const { coordinator } = build({ decision: { kind: "ALLOW" } });
    const outcome = await coordinator.admit(admitInput());
    expect(Object.keys(coordinator)).toEqual(["admit"]);
    expect(outcome).toEqual({ kind: "ALLOW" });
  });
});
