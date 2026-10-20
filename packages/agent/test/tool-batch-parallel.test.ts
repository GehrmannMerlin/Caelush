import {
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ToolInvocation,
  type ToolObservation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import {
  createToolBatchCoordinator,
  type DurableToolExecutionOutcome,
  type PreparedToolCall,
  type ToolBatchCoordinator,
  type ToolBatchOutcome,
  type ToolCallPreparationOutcome,
  type ToolCallRequest,
  type ToolExecutionMode,
} from "../src/index.js";
import { planToolBatchSegments, runBoundedByIndex } from "../src/tools/batch/parallel-scheduler.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

const runId = createRunId();
const sessionId = createSessionId();
const sourceStepId = createStepId();

function call(externalCallId: string, toolName: string): ToolCallRequest {
  return { externalCallId, toolName, args: {} };
}

function invocationOf(request: ToolCallRequest): ToolInvocation {
  return {
    id: createToolInvocationId(),
    runId,
    stepId: sourceStepId,
    toolName: request.toolName,
    externalCallId: request.externalCallId,
    args: {},
    riskLevel: "LOW",
    status: "COMPLETED",
    createdAt: createTimestampMs(1),
  } as ToolInvocation;
}

function observationOf(invocation: ToolInvocation): ToolObservation {
  return {
    id: createObservationId(),
    runId,
    stepId: invocation.stepId,
    kind: "TOOL",
    toolInvocationId: invocation.id,
    content: "ok",
    isError: false,
    createdAt: createTimestampMs(2),
  } as ToolObservation;
}

interface HarnessOptions {
  readonly modes: Readonly<Record<string, ToolExecutionMode>>;
  readonly approvalPolicy?: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK";
  readonly parallelism?: {
    readonly maxConcurrency: number;
    readonly admissionMayRequireApproval?: boolean;
  };
  readonly overrideOutcome?: (
    call: ToolCallRequest,
    signal: AbortSignal,
    settled: DurableToolExecutionOutcome,
  ) => Promise<DurableToolExecutionOutcome>;
  /** Milliseconds each tool call holds before settling. */
  readonly holdMs?: number;
}

interface Harness {
  readonly coordinator: ToolBatchCoordinator;
  readonly executed: string[];
  readonly maxInFlight: () => number;
  readonly approvalPolicy: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK";
}

function harness(options: HarnessOptions): Harness {
  const executed: string[] = [];
  let inFlight = 0;
  let peak = 0;

  const coordinator = createToolBatchCoordinator({
    ...(options.parallelism === undefined ? {} : { parallelism: options.parallelism }),
    preparer: {
      prepare(value: ToolCallRequest): ToolCallPreparationOutcome {
        return {
          kind: "READY",
          call: {
            request: value,
            resolved: {
              tool: {
                name: value.toolName,
                executionMode: options.modes[value.toolName] ?? "SEQUENTIAL",
              },
            },
            args: {},
          } as unknown as PreparedToolCall,
        };
      },
    },
    budget: { preflight: async () => null },
    durable: {
      async execute(input): Promise<DurableToolExecutionOutcome> {
        const externalCallId = input.call.request.externalCallId;
        executed.push(externalCallId);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, options.holdMs ?? 10));
        } finally {
          inFlight -= 1;
        }
        const invocation = invocationOf(input.call.request);
        const settled: DurableToolExecutionOutcome = {
          kind: "SETTLED",
          invocation,
          observation: observationOf(invocation),
        };
        return options.overrideOutcome === undefined
          ? settled
          : options.overrideOutcome(input.call.request, input.signal, settled);
      },
    },
  });

  return {
    coordinator,
    executed,
    maxInFlight: () => peak,
    approvalPolicy: options.approvalPolicy ?? "DANGEROUS_ONLY",
  };
}

function request(
  calls: readonly ToolCallRequest[],
  approvalPolicy: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK" = "DANGEROUS_ONLY",
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    runId,
    sessionId,
    sourceStepId,
    calls,
    environment,
    securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy },
    signal,
  } as const;
}

async function settle(outcome: ToolBatchOutcome): Promise<ToolBatchOutcome> {
  expect(outcome.kind).toBe("COMPLETED");
  return outcome;
}

describe("parallel batch scheduling", () => {
  it("runs a window of PARALLEL_SAFE calls together and reports them in order", async () => {
    const h = harness({
      modes: { read_file: "PARALLEL_SAFE", list_directory: "PARALLEL_SAFE" },
      parallelism: { maxConcurrency: 3, admissionMayRequireApproval: false },
    });
    const batch = [call("c1", "read_file"), call("c2", "list_directory"), call("c3", "read_file")];

    const outcome = await settle(await h.coordinator.execute(request(batch)));

    expect(h.maxInFlight()).toBe(3);
    expect(h.executed).toEqual(["c1", "c2", "c3"]);
    expect(
      outcome.kind === "COMPLETED" && outcome.items.map((item) => item.call.externalCallId),
    ).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps the historical sequential behaviour when parallelism is not configured", async () => {
    const h = harness({ modes: { read_file: "PARALLEL_SAFE" } });

    await settle(
      await h.coordinator.execute(request([call("c1", "read_file"), call("c2", "read_file")])),
    );

    expect(h.maxInFlight()).toBe(1);
    expect(h.executed).toEqual(["c1", "c2"]);
  });

  it("never lets a mutating call share a window", async () => {
    const h = harness({
      modes: { read_file: "PARALLEL_SAFE", apply_patch: "SEQUENTIAL" },
      parallelism: { maxConcurrency: 4, admissionMayRequireApproval: false },
    });

    await settle(
      await h.coordinator.execute(
        request([
          call("c1", "read_file"),
          call("c2", "read_file"),
          call("c3", "apply_patch"),
          call("c4", "read_file"),
        ]),
      ),
    );

    expect(h.maxInFlight()).toBe(2);
    expect(h.executed).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("forms no window under ALWAYS_ASK, because any call could park on an approval", async () => {
    const h = harness({
      modes: { read_file: "PARALLEL_SAFE" },
      parallelism: { maxConcurrency: 4, admissionMayRequireApproval: false },
      approvalPolicy: "ALWAYS_ASK",
    });

    await settle(
      await h.coordinator.execute(
        request([call("c1", "read_file"), call("c2", "read_file")], h.approvalPolicy),
      ),
    );

    expect(h.maxInFlight()).toBe(1);
  });

  it("serializes calls when admission may request an approval", async () => {
    const h = harness({
      modes: { read_file: "PARALLEL_SAFE" },
      parallelism: { maxConcurrency: 4, admissionMayRequireApproval: true },
    });

    await settle(
      await h.coordinator.execute(request([call("c1", "read_file"), call("c2", "read_file")])),
    );

    expect(h.maxInFlight()).toBe(1);
  });

  it("keeps later settled outcomes when an earlier parallel call waits for approval", async () => {
    const h = harness({
      modes: { read_file: "PARALLEL_SAFE" },
      parallelism: { maxConcurrency: 2, admissionMayRequireApproval: false },
      overrideOutcome: async (request, _signal, settled) =>
        request.externalCallId === "c1"
          ? { kind: "WAITING_APPROVAL", invocation: settled.invocation, approval: {} as never }
          : settled,
    });

    const outcome = await h.coordinator.execute(
      request([call("c1", "read_file"), call("c2", "read_file")]),
    );

    expect(outcome.kind).toBe("WAITING_APPROVAL");
    if (outcome.kind === "WAITING_APPROVAL") {
      expect(outcome.pendingCall.externalCallId).toBe("c1");
      expect(outcome.items.map((item) => item.call.externalCallId)).toEqual(["c2"]);
      expect(outcome.items[0]?.kind).toBe("OBSERVATION");
    }
  });

  it("does not report a committed sibling as skipped when cancellation races a window", async () => {
    const controller = new AbortController();
    const h = harness({
      modes: { read_file: "PARALLEL_SAFE" },
      parallelism: { maxConcurrency: 2, admissionMayRequireApproval: false },
      overrideOutcome: async (request, _signal, settled) => {
        if (request.externalCallId === "c1") {
          controller.abort();
          throw new Error("cancelled before durable execution");
        }
        return settled;
      },
    });

    const outcome = await h.coordinator.execute(
      request(
        [call("c1", "read_file"), call("c2", "read_file")],
        "DANGEROUS_ONLY",
        controller.signal,
      ),
    );

    expect(outcome.kind).toBe("CANCELLED");
    expect(outcome.items.map((item) => [item.call.externalCallId, item.kind])).toEqual([
      ["c1", "SKIPPED"],
      ["c2", "OBSERVATION"],
    ]);
  });
});

describe("planToolBatchSegments", () => {
  const reads = (count: number) =>
    Array.from({ length: count }, () => ({ executionMode: "PARALLEL_SAFE" as const }));

  it("splits a longer run by the concurrency bound", () => {
    const segments = planToolBatchSegments({
      calls: reads(5),
      maxConcurrency: 2,
      approvalPolicy: "DANGEROUS_ONLY",
      admissionMayRequireApproval: false,
    });

    expect(segments).toEqual([
      { kind: "PARALLEL", start: 0, count: 2 },
      { kind: "PARALLEL", start: 2, count: 2 },
      { kind: "SEQUENTIAL", start: 4, count: 1 },
    ]);
  });

  it("keeps a lone read sequential and never groups across a mutating call", () => {
    const segments = planToolBatchSegments({
      calls: [
        { executionMode: "PARALLEL_SAFE" },
        { executionMode: "SEQUENTIAL" },
        { executionMode: "PARALLEL_SAFE" },
      ],
      maxConcurrency: 4,
      approvalPolicy: "DANGEROUS_ONLY",
    });

    expect(segments.every((segment) => segment.kind === "SEQUENTIAL")).toBe(true);
  });

  it("refuses to plan any window under ALWAYS_ASK or when disabled", () => {
    for (const input of [
      { approvalPolicy: "ALWAYS_ASK" as const, enabled: undefined },
      { approvalPolicy: "DANGEROUS_ONLY" as const, enabled: false },
    ]) {
      const segments = planToolBatchSegments({
        calls: reads(3),
        maxConcurrency: 3,
        approvalPolicy: input.approvalPolicy,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      });
      expect(segments).toEqual([
        { kind: "SEQUENTIAL", start: 0, count: 1 },
        { kind: "SEQUENTIAL", start: 1, count: 1 },
        { kind: "SEQUENTIAL", start: 2, count: 1 },
      ]);
    }
  });
});

describe("runBoundedByIndex", () => {
  it("preserves index order while never exceeding the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;

    const results = await runBoundedByIndex(6, 2, async (index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5 + (5 - index) * 2));
      inFlight -= 1;
      return index * 10;
    });

    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("waits for started work to settle and stops dequeuing after a worker fails", async () => {
    let releaseSecond!: () => void;
    let resolveSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve;
    });
    let secondFinished = false;
    let thirdStarted = false;

    const execution = runBoundedByIndex(3, 2, async (index) => {
      if (index === 0) {
        await secondStarted;
        throw new Error("worker failed");
      }
      if (index === 1) {
        resolveSecondStarted();
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
        secondFinished = true;
        return index;
      }
      thirdStarted = true;
      return index;
    });
    const completion = execution.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );

    await secondStarted;
    const earlyState = await Promise.race([
      completion,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    releaseSecond();

    await expect(execution).rejects.toThrow("worker failed");
    expect(earlyState).toBe("pending");
    expect(secondFinished).toBe(true);
    expect(thirdStarted).toBe(false);
  });
});
