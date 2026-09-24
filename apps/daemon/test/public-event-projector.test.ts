import {
  ApprovalRequestSchema,
  RUN_EVENT_TYPE_CATALOG,
  RunEventSchema,
  createApprovalRequestId,
  createEventId,
  createPlanItemId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  createVerificationCheckId,
  createVerificationPlanId,
  createVerificationResultId,
  PublicRunEventSchema,
  type RunEvent,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { DefaultPublicEventProjector } from "../src/events/public-event-projector.js";

const projector = new DefaultPublicEventProjector();

function makeEvent(
  type: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): RunEvent {
  return RunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId: createRunId(),
    sessionId: createSessionId(),
    type,
    timestamp: 1_700_000_000_000,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    payload,
    ...overrides,
  });
}

function errorPayload(message = "safe error") {
  return { error: { code: "INTERNAL_ERROR", message, retryable: false, phase: "TOOL" } };
}

function commonIds() {
  return {
    invocationId: createToolInvocationId(),
    planId: createVerificationPlanId(),
    checkId: createVerificationCheckId(),
  };
}

describe("DefaultPublicEventProjector", () => {
  it("projects visible terminal output without mutating the internal event", () => {
    const event = makeEvent("shell.output", {
      invocationId: createToolInvocationId(),
      stream: "stdout",
      chunk: "ok\u001b]0;do-not-leak\u0007 Authorization: Bearer abc123",
    });
    const before = structuredClone(event);

    const projected = projector.project(event);

    expect(projected).not.toBeNull();
    expect(projected?.payload).toEqual({
      invocationId: event.payload.invocationId,
      stream: "stdout",
      chunk: "ok Authorization: Bearer [REDACTED]",
    });
    expect(event).toEqual(before);
    expect(PublicRunEventSchema.safeParse(projected).success).toBe(true);
  });

  it.each([
    ["DEBUG", "shell.output"],
    ["SYSTEM", "shell.output"],
    ["USER_VISIBLE", "error"],
  ] as const)("filters %s/%s before ordinary public transport", (visibility, type) => {
    const payload =
      type === "error"
        ? errorPayload()
        : { invocationId: createToolInvocationId(), stream: "stdout", chunk: "hidden" };
    expect(projector.project(makeEvent(type, payload, { visibility }))).toBeNull();
  });

  it("projects errors without details, causes, provider responses, or credential-bearing text", () => {
    const event = makeEvent("run.failed", {
      error: {
        code: "MODEL_ERROR",
        message: "provider failed Authorization: Bearer raw-token",
        retryable: true,
        phase: "LLM",
        details: {
          endpoint: "https://secret.example.test/v1",
          authorization: "Bearer raw-token",
          providerResponse: { apiKey: "raw-api-key" },
          cause: "private cause",
        },
      },
    });

    const projected = projector.project(event);

    expect(projected?.payload).toEqual({
      error: {
        code: "MODEL_ERROR",
        message: "provider failed Authorization: Bearer [REDACTED]",
        retryable: true,
        phase: "LLM",
      },
    });
    expect(JSON.stringify(projected)).not.toContain("raw-token");
    expect(JSON.stringify(projected)).not.toContain("secret.example.test");
    expect(JSON.stringify(projected)).not.toContain("private cause");
  });

  it("projects approval actions with safe bounded fields instead of raw JSON", () => {
    const approval = ApprovalRequestSchema.parse({
      id: createApprovalRequestId(),
      runId: createRunId(),
      toolInvocationId: createToolInvocationId(),
      riskLevel: "HIGH",
      title: "Approve Authorization: Bearer raw-token",
      reason: "run D:\\private\\repo\\secret.txt",
      action: {
        command: "curl -H 'Authorization: Bearer raw-token' https://example.test",
        password: "raw-password",
        path: "D:\\private\\repo\\secret.txt",
        nested: { note: "safe" },
      },
      status: "PENDING",
      scope: "ONCE",
      createdAt: 1_700_000_000_000,
    });
    const event = makeEvent("approval.requested", { approval });

    const projected = projector.project(event);
    const publicApproval = projected?.payload.approval;

    expect(publicApproval).toMatchObject({
      id: approval.id,
      toolInvocationId: approval.toolInvocationId,
      riskLevel: "HIGH",
      status: "PENDING",
      scope: "ONCE",
    });
    expect(JSON.stringify(publicApproval)).not.toContain("raw-token");
    expect(JSON.stringify(publicApproval)).not.toContain("raw-password");
    expect(JSON.stringify(publicApproval)).not.toContain("D:\\private\\repo");
  });

  it("replaces host and traversal paths while preserving workspace-relative identity", () => {
    const relative = projector.project(
      makeEvent("file.moved", {
        fromPath: "src/old.ts",
        toPath: "D:\\secret\\repo\\new.ts",
      }),
    );
    const unix = projector.project(makeEvent("file.read", { path: "/home/user/private.ts" }));
    const traversal = projector.project(makeEvent("file.read", { path: "../outside.txt" }));

    expect(relative?.payload).toEqual({
      fromPath: "src/old.ts",
      toPath: "[path omitted]",
    });
    expect(unix?.payload).toEqual({ path: "[path omitted]" });
    expect(traversal?.payload).toEqual({ path: "[path omitted]" });
  });

  it("drops hidden reasoning fields from arbitrary completion results and bounds UTF-8 text", () => {
    const result = {
      answer: "可见结果".repeat(10_000),
      reasoning: "private chain of thought",
      providerResponse: { secret: "private" },
      nested: { safe: "保留" },
    };
    const projected = projector.project(makeEvent("run.completed", { result }));

    expect(projected).not.toBeNull();
    expect(JSON.stringify(projected)).not.toContain("private chain of thought");
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThan(128 * 1024);
    expect(projected?.payload.result).toMatchObject({ nested: { safe: "保留" } });
  });

  it("has an explicit projection for every catalog USER_VISIBLE event type", () => {
    const ids = commonIds();
    const payloads: Record<string, unknown> = {
      "run.started": { goal: "goal" },
      "run.timed_out": { deadlineAt: 1_700_000_000_001 },
      "run.completed": { result: { answer: "done" } },
      "run.failed": errorPayload(),
      "run.cancelled": { reason: "cancelled" },
      "status.changed": { from: "PENDING", to: "RUNNING" },
      "reasoning.summary": { summary: "safe summary" },
      "model.text.delta": { text: "partial answer" },
      "model.reasoning_summary.delta": { text: "safe summary" },
      "model.tool_call.delta": { toolCallId: "call-1", delta: '{"path":' },
      "plan.updated": {
        plan: [{ id: createPlanItemId(), title: "step", status: "PENDING" }],
      },
      "tool.requested": {
        invocationId: ids.invocationId,
        toolName: "read_file",
        riskLevel: "LOW",
      },
      "tool.started": { invocationId: ids.invocationId },
      "tool.output": { invocationId: ids.invocationId, stream: "stdout", chunk: "out" },
      "tool.completed": {
        invocationId: ids.invocationId,
        observationId: "obs_00000000-0000-7000-8000-000000000000",
      },
      "tool.failed": { invocationId: ids.invocationId, ...errorPayload() },
      "file.read": { path: "src/file.ts" },
      "file.created": { summary: { path: "src/file.ts", changeType: "CREATED" } },
      "file.modified": { summary: { path: "src/file.ts", changeType: "MODIFIED" } },
      "file.moved": { fromPath: "src/old.ts", toPath: "src/new.ts" },
      "file.deleted": { summary: { path: "src/file.ts", changeType: "DELETED" } },
      "shell.started": { invocationId: ids.invocationId, command: "echo hi" },
      "shell.output": { invocationId: ids.invocationId, stream: "stdout", chunk: "out" },
      "shell.completed": { invocationId: ids.invocationId, exitCode: 0 },
      "process.started": { process: { id: "proc-1", command: "node app.js", status: "RUNNING" } },
      "process.output": { processId: "proc-1", stream: "stdout", chunk: "out" },
      "process.stopped": { processId: "proc-1", status: "EXITED" },
      "verification.started": { type: "TEST", command: "pnpm test" },
      "verification.completed": {
        result: {
          id: createVerificationResultId(),
          runId: createRunId(),
          type: "TEST",
          status: "PASSED",
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_000_001,
        },
      },
      "verification.planned": {
        planId: ids.planId,
        sourceStepId: "stp_00000000-0000-7000-8000-000000000000",
        checkCount: 1,
        plannerVersion: "v1",
        counts: { required: 1, ifAvailable: 0, advisory: 0 },
      },
      "verification.check.started": {
        planId: ids.planId,
        checkId: ids.checkId,
        ordinal: 0,
        kind: "PROJECT",
        purpose: "TEST",
        stage: "FAST_STATIC",
      },
      "verification.check.completed": {
        planId: ids.planId,
        checkId: ids.checkId,
        status: "PASSED",
        evidenceIds: [],
      },
      "verification.repair.started": {
        failedPlanId: ids.planId,
        failedCheckIds: [ids.checkId],
        repairCycle: 0,
      },
      "verification.repair.limit_reached": {
        planId: ids.planId,
        attemptedRepairs: 1,
        maxAutoRepairs: 1,
      },
      "verification.finalized": {
        planId: ids.planId,
        outcome: "PASSED",
        failedCheckIds: [],
        errorCheckIds: [],
      },
      "approval.requested": {
        approval: {
          id: createApprovalRequestId(),
          runId: createRunId(),
          toolInvocationId: ids.invocationId,
          riskLevel: "LOW",
          title: "Approve",
          reason: "Reason",
          action: {},
          status: "PENDING",
          scope: "ONCE",
          createdAt: 1_700_000_000_000,
        },
      },
      "approval.resolved": { approvalId: createApprovalRequestId(), status: "REJECTED" },
      "llm.started": { model: { provider: "fixture", model: "model" } },
      "llm.completed": {
        model: { provider: "fixture", model: "model" },
        usage: { steps: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1 },
      },
      "llm.failed": { model: { provider: "fixture", model: "model" }, ...errorPayload() },
      "retry.scheduled": {
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1,
        nextAttemptAt: 1_700_000_000_001,
        errorCode: "LLM_NETWORK",
      },
      "retry.started": { attempt: 1, maxAttempts: 2 },
      "budget.exceeded": { dimension: "TOKENS", limit: 10, accounted: 11 },
      "resource.guard": { reason: "NO_PROGRESS", replanCount: 1, requestedToolCalls: 1 },
      "conversation.message.committed": {
        messageId: "msg_fixture",
        conversationTurnId: "turn_fixture",
        messageType: "USER",
      },
    };

    for (const definition of RUN_EVENT_TYPE_CATALOG.filter(
      (item) => item.visibility === "USER_VISIBLE",
    )) {
      const payload = payloads[definition.type];
      expect(payload, `fixture missing for ${definition.type}`).toBeDefined();
      const projected = projector.project(
        makeEvent(definition.type, payload, {
          schemaVersion: definition.schemaVersion,
          durability:
            definition.delivery.kind === "DURABLE"
              ? { kind: "DURABLE", version: 1, sequence: 1 }
              : {
                  kind: "EPHEMERAL",
                  version: 1,
                  deliveryClass: definition.delivery.class,
                  streamKey: `${definition.type}:fixture`,
                  ...(definition.delivery.class === "ORDERED" ? { streamSequence: 1 } : {}),
                },
        }),
      );
      expect(projected, `projection missing for ${definition.type}`).not.toBeNull();
    }
  });
});
