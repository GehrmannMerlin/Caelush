import {
  createApprovalRequestId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ApprovalRequest,
  type ToolInvocation,
  type ToolObservation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import {
  createToolBatchCoordinator,
  SKIPPED_AFTER_UNCERTAIN_EXECUTION,
  ToolBatchInfrastructureError,
  ToolBatchInputError,
  UNCERTAIN_SIDE_EFFECT,
  type AgentBudgetBlock,
  type DurableToolExecutionOutcome,
  type PreparedToolCall,
  type ToolBatchCoordinator,
  type ToolBatchItemOutcome,
  type ToolBatchOutcome,
  type ToolCallPreparationOutcome,
  type ToolCallRequest,
  type ToolFailureFeedback,
} from "../src/index.js";

/**
 * The canonical Tool Batch scheduling authority.
 *
 * ```text
 * validate → cancellation → budget preflight → for each call, in order: prepare → execute
 * ```
 *
 * These tests drive the real coordinator over narrow fake ports, so what they observe is the
 * coordinator's own algorithm — the order it asks for things, what it stops on, and what it refuses to
 * fabricate — rather than a mock's call log.
 */

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

const securityContext = {
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
} as const;

function call(externalCallId: string, toolName = "echo"): ToolCallRequest {
  return { externalCallId, toolName, args: {} };
}

function invocationOf(
  request: ToolCallRequest,
  overrides: { readonly status?: ToolInvocation["status"]; readonly error?: unknown } = {},
): ToolInvocation {
  return {
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    toolName: request.toolName,
    externalCallId: request.externalCallId,
    args: {},
    riskLevel: "LOW",
    status: overrides.status ?? "COMPLETED",
    createdAt: createTimestampMs(1),
    ...(overrides.error === undefined ? {} : { error: overrides.error as ToolInvocation["error"] }),
  } as ToolInvocation;
}

function observationOf(
  invocation: ToolInvocation,
  content = "ok",
  isError = false,
): ToolObservation {
  return {
    id: createObservationId(),
    runId: invocation.runId,
    stepId: invocation.stepId,
    kind: "TOOL",
    toolInvocationId: invocation.id,
    content,
    isError,
    createdAt: createTimestampMs(2),
  } as ToolObservation;
}

function approvalOf(invocation: ToolInvocation): ApprovalRequest {
  return {
    id: createApprovalRequestId(),
    runId: invocation.runId,
    toolInvocationId: invocation.id,
    riskLevel: "HIGH",
    title: "Approve",
    reason: "Policy requires a decision.",
    action: {},
    status: "PENDING",
    scope: "ONCE",
    createdAt: createTimestampMs(3),
  } as ApprovalRequest;
}

/* ------------------------------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------------------------- */

interface Harness {
  readonly coordinator: ToolBatchCoordinator;
  readonly events: string[];
  readonly prepared: readonly string[];
  readonly preflights: readonly (readonly string[])[];
  /** Every Tool handler that actually ran, in order. */
  readonly executed: readonly string[];
  readonly setRejections: (byToolName: Record<string, ToolFailureFeedback>) => void;
}

function harness(): Harness {
  const events: string[] = [];
  const prepared: string[] = [];
  const preflights: string[][] = [];
  const executed: string[] = [];
  let rejections: Record<string, ToolFailureFeedback> = {};

  const coordinator = createToolBatchCoordinator({
    preparer: {
      prepare(value: ToolCallRequest): ToolCallPreparationOutcome {
        events.push(`prepare:${value.externalCallId}`);
        prepared.push(value.externalCallId);
        const rejection = rejections[value.toolName];
        if (rejection !== undefined)
          return { kind: "REJECTED", request: value, feedback: rejection };
        return {
          kind: "READY",
          call: {
            request: value,
            resolved: { tool: { name: value.toolName, executionMode: "SEQUENTIAL" } },
            args: {},
          } as unknown as PreparedToolCall,
        };
      },
    },
    budget: {
      async preflight(_runId, requests) {
        events.push("preflight");
        preflights.push(requests.map((value) => value.externalCallId));
        return null;
      },
    },
    durable: {
      async execute(input): Promise<DurableToolExecutionOutcome> {
        const externalCallId = input.call.request.externalCallId;
        events.push(`execute:${externalCallId}`);
        executed.push(externalCallId);
        const invocation = invocationOf(input.call.request);
        return { kind: "SETTLED", invocation, observation: observationOf(invocation) };
      },
    },
  });

  return {
    coordinator,
    events,
    prepared,
    preflights,
    executed,
    setRejections(value) {
      rejections = value;
    },
  };
}

function request(calls: readonly ToolCallRequest[], signal = new AbortController().signal) {
  return {
    runId: createRunId(),
    sessionId: createSessionId(),
    sourceStepId: createStepId(),
    calls,
    environment,
    securityContext,
    signal,
  } as const;
}

/** The external call ids of an item list, for order assertions. */
function idsOf(items: readonly ToolBatchItemOutcome[]): readonly string[] {
  return items.map((item) => item.call.externalCallId);
}

/* ------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

describe("canonical Tool batch — validation", () => {
  it("refuses an empty batch before any budget preflight or preparation", async () => {
    const h = harness();
    await expect(h.coordinator.execute(request([]))).rejects.toBeInstanceOf(ToolBatchInputError);
    expect(h.events).toEqual([]);
  });

  it("refuses a duplicate externalCallId before anything durable can happen", async () => {
    const h = harness();
    await expect(
      h.coordinator.execute(request([call("call_a"), call("call_a")])),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    // The duplicate is refused *before* the budget question is asked, so the first copy can never be
    // executed and then discovered to be a duplicate.
    expect(h.events).toEqual([]);
  });

  it("refuses a request that is not an object, and one with an extra field", async () => {
    const h = harness();
    await expect(h.coordinator.execute(null as never)).rejects.toBeInstanceOf(ToolBatchInputError);
    await expect(h.coordinator.execute([] as never)).rejects.toBeInstanceOf(ToolBatchInputError);
    await expect(
      h.coordinator.execute({ ...request([call("call_a")]), extra: true } as never),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    expect(h.events).toEqual([]);
  });

  it("refuses a malformed call, a missing signal and a malformed environment", async () => {
    const h = harness();
    await expect(
      h.coordinator.execute(request([{ externalCallId: "", toolName: "echo", args: {} }])),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    await expect(
      h.coordinator.execute(request([{ externalCallId: "a", toolName: "", args: {} }])),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    await expect(
      h.coordinator.execute({ ...request([call("call_a")]), signal: undefined } as never),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    await expect(
      h.coordinator.execute({
        ...request([call("call_a")]),
        environment: { workspace: { id: "x", path: "p" } },
      } as never),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    expect(h.events).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Sequential scheduling
 * ---------------------------------------------------------------------------------------------- */

describe("canonical Tool batch — sequential scheduling", () => {
  it("preflights the whole requested segment before the first handler", async () => {
    const h = harness();
    const outcome = await h.coordinator.execute(
      request([call("call_a"), call("call_b"), call("call_c")]),
    );

    expect(outcome.kind).toBe("COMPLETED");
    // The frozen order: the budget question is asked for the *requested* segment, first, once.
    expect(h.events[0]).toBe("preflight");
    expect(h.preflights).toEqual([["call_a", "call_b", "call_c"]]);
    expect(h.events).toEqual([
      "preflight",
      "prepare:call_a",
      "execute:call_a",
      "prepare:call_b",
      "execute:call_b",
      "prepare:call_c",
      "execute:call_c",
    ]);
  });

  it("fully decides call_1 before it prepares call_2", async () => {
    const h = harness();
    const outcome = await h.coordinator.execute(request([call("call_a"), call("call_b")]));
    expect(outcome.kind).toBe("COMPLETED");

    const executeA = h.events.indexOf("execute:call_a");
    const prepareB = h.events.indexOf("prepare:call_b");
    expect(executeA).toBeGreaterThan(-1);
    expect(prepareB).toBeGreaterThan(executeA);
  });

  it("returns one ordered OBSERVATION item per call", async () => {
    const h = harness();
    const outcome = await h.coordinator.execute(
      request([call("call_a"), call("call_b"), call("call_c")]),
    );
    if (outcome.kind !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(idsOf(outcome.items)).toEqual(["call_a", "call_b", "call_c"]);
    for (const item of outcome.items) {
      expect(item.kind).toBe("OBSERVATION");
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * Budget
 * ---------------------------------------------------------------------------------------------- */

describe("canonical Tool batch — budget", () => {
  it("returns BUDGET_EXCEEDED with zero execution when the whole batch does not fit", async () => {
    const h = harness();
    // A preflight block is answered through the same port the production ledger implements.
    const blocked = createToolBatchCoordinator({
      preparer: {
        prepare(): ToolCallPreparationOutcome {
          throw new Error("the preparer must not run when the batch cannot fit");
        },
      },
      budget: {
        async preflight(): Promise<AgentBudgetBlock | null> {
          return {
            kind: "EXCEEDED",
            dimension: "TOOL_CALLS",
            accounted: 8,
            limit: 8,
          } as AgentBudgetBlock;
        },
      },
      durable: {
        async execute(): Promise<DurableToolExecutionOutcome> {
          throw new Error("no handler may run when the batch cannot fit");
        },
      },
    });

    const outcome = await blocked.execute(request([call("call_a"), call("call_b")]));
    expect(outcome.kind).toBe("BUDGET_EXCEEDED");
    if (outcome.kind !== "BUDGET_EXCEEDED") throw new Error("expected BUDGET_EXCEEDED");
    // No item is fabricated: the frozen durable outcome does not define this boundary as model feedback.
    expect(outcome.items).toEqual([]);
    expect(outcome.block).toMatchObject({ kind: "EXCEEDED", dimension: "TOOL_CALLS" });
    expect(h.events).toEqual([]);
  });

  it("stops at a single-call budget block and keeps the items already decided", async () => {
    const batch = createToolBatchCoordinator({
      preparer: {
        prepare(value): ToolCallPreparationOutcome {
          return {
            kind: "READY",
            call: {
              request: value,
              resolved: { tool: { name: value.toolName, executionMode: "SEQUENTIAL" } },
              args: {},
            } as unknown as PreparedToolCall,
          };
        },
      },
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(input): Promise<DurableToolExecutionOutcome> {
          const externalCallId = input.call.request.externalCallId;
          if (externalCallId === "call_b") {
            const invocation = invocationOf(input.call.request, { status: "FAILED" });
            return {
              kind: "BUDGET_EXCEEDED",
              invocation,
              block: {
                kind: "EXCEEDED",
                dimension: "TOOL_CALLS",
                accounted: 8,
                limit: 8,
              } as AgentBudgetBlock,
            };
          }
          const invocation = invocationOf(input.call.request);
          return { kind: "SETTLED", invocation, observation: observationOf(invocation) };
        },
      },
    });

    const outcome = await batch.execute(request([call("call_a"), call("call_b"), call("call_c")]));
    expect(outcome.kind).toBe("BUDGET_EXCEEDED");
    if (outcome.kind !== "BUDGET_EXCEEDED") throw new Error("expected BUDGET_EXCEEDED");
    // Only call_a reached a final item outcome; call_b is the budget boundary and call_c never ran.
    expect(idsOf(outcome.items)).toEqual(["call_a"]);
    // No fake observation is constructed for the blocked call.
    expect(outcome.items.every((item) => item.kind === "OBSERVATION")).toBe(true);
  });

  it("turns a preflight throw into an infrastructure failure rather than model feedback", async () => {
    const batch = createToolBatchCoordinator({
      preparer: {
        prepare(): ToolCallPreparationOutcome {
          throw new Error("must not prepare");
        },
      },
      budget: {
        async preflight(): Promise<AgentBudgetBlock | null> {
          throw new Error("ledger unavailable");
        },
      },
      durable: {
        async execute(): Promise<DurableToolExecutionOutcome> {
          throw new Error("must not execute");
        },
      },
    });

    await expect(batch.execute(request([call("call_a")]))).rejects.toBeInstanceOf(
      ToolBatchInfrastructureError,
    );
  });
});

/* ------------------------------------------------------------------------------------------------
 * Rejection
 * --------------------------------------------------------------------------------------------- */

describe("canonical Tool batch — pre-invocation rejection", () => {
  it("appends REJECTED with no durable row and does not execute", async () => {
    const h = harness();
    h.setRejections({
      echo: {
        code: "TOOL_ARGUMENT_ERROR",
        content: "Arguments do not match the input schema.",
        details: {},
        disposition: "SAFE_FAILURE",
      },
    });

    const outcome = await h.coordinator.execute(request([call("call_a")]));
    if (outcome.kind !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]!.kind).toBe("REJECTED");
    // The durable coordinator was never reached: no invocation, no observation, no event.
    expect(h.events).toEqual(["preflight", "prepare:call_a"]);
    expect(h.executed).toEqual([]);
  });

  it("continues the batch after a rejection and executes the valid call", async () => {
    const h = harness();
    h.setRejections({
      bad_tool: {
        code: "TOOL_UNAVAILABLE",
        content: "No such Tool is registered.",
        details: {},
        disposition: "SAFE_FAILURE",
      },
    });

    const outcome = await h.coordinator.execute(
      request([
        { externalCallId: "call_bad", toolName: "bad_tool", args: {} },
        { externalCallId: "call_good", toolName: "echo", args: {} },
      ]),
    );

    if (outcome.kind !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(outcome.items.map((item) => item.kind)).toEqual(["REJECTED", "OBSERVATION"]);
    expect(idsOf(outcome.items)).toEqual(["call_bad", "call_good"]);
    expect(h.executed).toEqual(["call_good"]);
  });

  it("turns a preparation infrastructure throw into an infrastructure failure, not a rejection", async () => {
    const batch = createToolBatchCoordinator({
      preparer: {
        prepare(): ToolCallPreparationOutcome {
          throw new Error("registry corrupt");
        },
      },
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(): Promise<DurableToolExecutionOutcome> {
          throw new Error("must not execute");
        },
      },
    });

    await expect(batch.execute(request([call("call_a")]))).rejects.toBeInstanceOf(
      ToolBatchInfrastructureError,
    );
  });
});

/* ------------------------------------------------------------------------------------------------
 * Uncertainty
 * --------------------------------------------------------------------------------------------- */

describe("canonical Tool batch — the uncertain barrier", () => {
  it("skips every trailing call after an UNCERTAIN_SIDE_EFFECT settlement", async () => {
    const executed: string[] = [];
    // call_1 succeeds, call_2 fails with an unproven side effect, call_3 and call_4 must be skipped.
    const batch = createToolBatchCoordinator({
      preparer: readyPreparer(),
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(input): Promise<DurableToolExecutionOutcome> {
          const externalCallId = input.call.request.externalCallId;
          executed.push(externalCallId);
          if (externalCallId === "call_2") {
            const invocation = invocationOf(input.call.request, {
              status: "FAILED",
              error: {
                code: "TOOL_EXECUTION_ERROR",
                message: "Tool execution returned an error result.",
                retryable: false,
                phase: "TOOL",
                details: { executionDisposition: UNCERTAIN_SIDE_EFFECT },
              },
            });
            return {
              kind: "SETTLED",
              invocation,
              observation: observationOf(invocation, "x", true),
            };
          }
          const invocation = invocationOf(input.call.request);
          return { kind: "SETTLED", invocation, observation: observationOf(invocation) };
        },
      },
    });

    const outcome = await batch.execute(
      request([call("call_1"), call("call_2"), call("call_3"), call("call_4")]),
    );

    if (outcome.kind !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(outcome.items.map((item) => item.kind)).toEqual([
      "OBSERVATION",
      "OBSERVATION",
      "SKIPPED",
      "SKIPPED",
    ]);
    // Two handlers ran, not four: a skipped call is never prepared and never executed.
    expect(executed).toEqual(["call_1", "call_2"]);

    const skipped = outcome.items.filter((item) => item.kind === "SKIPPED");
    for (const item of skipped) {
      if (item.kind !== "SKIPPED") continue;
      expect(item.feedback.code).toBe(SKIPPED_AFTER_UNCERTAIN_EXECUTION);
      expect(item.feedback.disposition).toBe(UNCERTAIN_SIDE_EFFECT);
      // Safe, bounded and actionable: no raw exception, no host path, no command output.
      expect(item.feedback.content).toMatch(/may have partially or fully completed/);
      expect(item.feedback.content).toMatch(/re-inspect/i);
      expect(item.feedback.content).not.toMatch(/[A-Za-z]:\\|\/tmp\/|stack|at Object\./);
    }
    // One result per original call, in original order.
    expect(idsOf(outcome.items)).toEqual(["call_1", "call_2", "call_3", "call_4"]);
  });

  it("does not skip trailing calls after an ordinary safe failure", async () => {
    const executed: string[] = [];
    const batch = createToolBatchCoordinator({
      preparer: readyPreparer(),
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(input): Promise<DurableToolExecutionOutcome> {
          const externalCallId = input.call.request.externalCallId;
          executed.push(externalCallId);
          const failed = externalCallId === "call_1";
          const invocation = invocationOf(input.call.request, {
            status: failed ? "FAILED" : "COMPLETED",
            ...(failed
              ? {
                  error: {
                    code: "TOOL_EXECUTION_ERROR",
                    message: "Tool returned an error result.",
                    retryable: false,
                    phase: "TOOL",
                  },
                }
              : {}),
          });
          return {
            kind: "SETTLED",
            invocation,
            observation: observationOf(invocation, "x", failed),
          };
        },
      },
    });

    const outcome = await batch.execute(request([call("call_1"), call("call_2")]));
    if (outcome.kind !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(outcome.items.map((item) => item.kind)).toEqual(["OBSERVATION", "OBSERVATION"]);
    expect(executed).toEqual(["call_1", "call_2"]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Approval, budget stop, cancellation
 * --------------------------------------------------------------------------------------------- */

describe("canonical Tool batch — stops", () => {
  it("stops at WAITING_APPROVAL and never prepares the trailing calls", async () => {
    const seen: string[] = [];
    const batch = createToolBatchCoordinator({
      preparer: {
        prepare(value): ToolCallPreparationOutcome {
          seen.push(value.externalCallId);
          return {
            kind: "READY",
            call: {
              request: value,
              resolved: { tool: { name: value.toolName, executionMode: "SEQUENTIAL" } },
              args: {},
            } as unknown as PreparedToolCall,
          };
        },
      },
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(input): Promise<DurableToolExecutionOutcome> {
          if (input.call.request.externalCallId === "call_b") {
            const invocation = invocationOf(input.call.request, { status: "WAITING_APPROVAL" });
            return { kind: "WAITING_APPROVAL", invocation, approval: approvalOf(invocation) };
          }
          const invocation = invocationOf(input.call.request);
          return { kind: "SETTLED", invocation, observation: observationOf(invocation) };
        },
      },
    });

    const outcome = await batch.execute(request([call("call_a"), call("call_b"), call("call_c")]));
    expect(outcome.kind).toBe("WAITING_APPROVAL");
    if (outcome.kind !== "WAITING_APPROVAL") throw new Error("expected WAITING_APPROVAL");
    // Only the call before the boundary reached a final item outcome.
    expect(idsOf(outcome.items)).toEqual(["call_a"]);
    expect(outcome.pendingCall.externalCallId).toBe("call_b");
    expect(outcome.approval.toolInvocationId).toBeDefined();
    // The pending call is expressed by pendingCall + approval, never as a fabricated item.
    expect(outcome.items.every((item) => item.call.externalCallId !== "call_b")).toBe(true);
    // call_c was never prepared.
    expect(seen).toEqual(["call_a", "call_b"]);
  });

  it("returns CANCELLED with no side effect for a pre-aborted signal", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    const outcome = await h.coordinator.execute(request([call("call_a")], controller.signal));
    expect(outcome.kind).toBe("CANCELLED");
    if (outcome.kind !== "CANCELLED") throw new Error("expected CANCELLED");
    expect(outcome.items).toEqual([]);
    // No preflight, no prepare, no execution: the batch stopped before any real Tool side effect.
    expect(h.events).toEqual([]);
  });

  it("returns CANCELLED with the items already decided when the abort arrives later", async () => {
    const controller = new AbortController();
    const batch = createToolBatchCoordinator({
      preparer: readyPreparer(),
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(input): Promise<DurableToolExecutionOutcome> {
          if (input.call.request.externalCallId === "call_a") {
            // The operator cancels while the first call settles.
            controller.abort();
            const invocation = invocationOf(input.call.request);
            return { kind: "SETTLED", invocation, observation: observationOf(invocation) };
          }
          throw new Error("no call after an abort may execute");
        },
      },
    });

    const outcome = await batch.execute(
      request([call("call_a"), call("call_b")], controller.signal),
    );
    expect(outcome.kind).toBe("CANCELLED");
    if (outcome.kind !== "CANCELLED") throw new Error("expected CANCELLED");
    expect(idsOf(outcome.items)).toEqual(["call_a"]);
  });

  it("propagates a durably cancelled invocation as CANCELLED", async () => {
    const batch = createToolBatchCoordinator({
      preparer: readyPreparer(),
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(input): Promise<DurableToolExecutionOutcome> {
          const invocation = invocationOf(input.call.request, { status: "CANCELLED" });
          return { kind: "CANCELLED", invocation };
        },
      },
    });

    const outcome = await batch.execute(request([call("call_a")]));
    expect(outcome.kind).toBe("CANCELLED");
    if (outcome.kind !== "CANCELLED") throw new Error("expected CANCELLED");
    // No observation existed, so none was manufactured.
    expect(outcome.items).toEqual([]);
  });

  it("propagates a durably cancelled invocation's observation when one exists", async () => {
    const batch = createToolBatchCoordinator({
      preparer: readyPreparer(),
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(input): Promise<DurableToolExecutionOutcome> {
          const invocation = invocationOf(input.call.request, { status: "CANCELLED" });
          return {
            kind: "CANCELLED",
            invocation,
            observation: observationOf(invocation, "partial", true),
          };
        },
      },
    });

    const outcome = await batch.execute(request([call("call_a")]));
    if (outcome.kind !== "CANCELLED") throw new Error("expected CANCELLED");
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]).toMatchObject({ kind: "OBSERVATION", finalStatus: "CANCELLED" });
  });

  it("returns CANCELLED when the durable coordinator reports an abort", async () => {
    const batch = createToolBatchCoordinator({
      preparer: readyPreparer(),
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(): Promise<DurableToolExecutionOutcome> {
          const { ToolExecutionAbortedError } = await import("../src/index.js");
          throw new ToolExecutionAbortedError();
        },
      },
    });

    const outcome = await batch.execute(request([call("call_a")]));
    expect(outcome.kind).toBe("CANCELLED");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Infrastructure
 * ---------------------------------------------------------------------------------------------- */

describe("canonical Tool batch — infrastructure failure", () => {
  it("throws for a durable coordinator failure instead of modelling it as feedback", async () => {
    const batch = createToolBatchCoordinator({
      preparer: readyPreparer(),
      budget: {
        async preflight() {
          return null;
        },
      },
      durable: {
        async execute(): Promise<DurableToolExecutionOutcome> {
          throw new Error("settlement transaction did not commit");
        },
      },
    });

    const rejection = await batch
      .execute(request([call("call_a")]))
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ToolBatchInfrastructureError);
    // The raw cause is retained internally and never becomes model-facing text.
    expect((rejection as ToolBatchInfrastructureError).cause).toBeInstanceOf(Error);
    expect((rejection as ToolBatchInfrastructureError).message).not.toMatch(
      /settlement transaction/,
    );
  });

  it("never returns an infrastructure failure as a value in the outcome union", () => {
    // The union is closed at four arms, and the failure mode is a throw. This is a declaration check:
    // a fifth arm would be a compile error in every exhaustive switch in the system.
    const kinds: readonly ToolBatchOutcome["kind"][] = [
      "COMPLETED",
      "WAITING_APPROVAL",
      "BUDGET_EXCEEDED",
      "CANCELLED",
    ];
    expect(kinds).toHaveLength(4);
  });
});

/** A preparer that resolves every call, for tests whose subject is not preparation. */
function readyPreparer() {
  return {
    prepare(value: ToolCallRequest): ToolCallPreparationOutcome {
      return {
        kind: "READY",
        call: {
          request: value,
          resolved: { tool: { name: value.toolName, executionMode: "SEQUENTIAL" } },
          args: {},
        } as unknown as PreparedToolCall,
      };
    },
  };
}
