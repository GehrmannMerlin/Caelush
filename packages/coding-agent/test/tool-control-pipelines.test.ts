import { createRunId, createSessionId, createStepId, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createControlHookId,
  createControlHookRegistryBuilder,
  createControlHookRunner,
  type ControlHookContext,
} from "@caelush/agent";
import {
  createToolFeedbackContributionPipeline,
  createToolGuardPipeline,
  type BeforeToolDispatchRegistration,
  type ToolFeedbackContributionHook,
} from "../src/hooks/index.js";

const context: ControlHookContext = {
  identity: { runId: createRunId(), sessionId: createSessionId() },
  stepId: createStepId(),
  mode: "RECOVER",
  signal: new AbortController().signal,
};

describe("Phase 6G Coding control pipelines", () => {
  it("runs BeforeToolDispatch hooks through the generic runner and keeps the strictest decision", async () => {
    const registrations: BeforeToolDispatchRegistration[] = [
      {
        id: createControlHookId("later"),
        priority: 20,
        criticality: "OPTIONAL",
        timeoutMs: 100,
        hook: {
          async evaluate() {
            return { kind: "REQUIRE_APPROVAL" as const, code: "review", reason: "Review" };
          },
        },
      },
      {
        id: createControlHookId("earlier"),
        priority: 10,
        criticality: "REQUIRED",
        timeoutMs: 100,
        hook: {
          async evaluate() {
            return { kind: "BLOCK" as const, code: "blocked", reason: "Blocked" };
          },
        },
      },
    ];

    const pipeline = createToolGuardPipeline({
      registrations,
      runner: createControlHookRunner({
        pipelineId: "tool-guard",
        clock: { now: () => createTimestampMs(10) },
      }),
      clock: { now: () => createTimestampMs(10) },
    });

    const result = await pipeline.evaluate(
      {
        runId: context.identity.runId,
        sessionId: context.identity.sessionId,
        sourceStepId: context.stepId!,
        externalCallId: "call-1",
        toolName: "exec_command",
        argsFingerprint: "args-fingerprint",
      },
      context,
    );

    expect(result.decision).toEqual({
      kind: "BLOCK",
      code: "blocked",
      reason: "Blocked",
    });
    expect(result.receipts.map((receipt) => receipt.hookId)).toEqual(["earlier", "later"]);
    expect(result.approvalFingerprint).toBeDefined();
  });

  it("validates guard output and fails closed even for an optional hook", async () => {
    const registrations: BeforeToolDispatchRegistration[] = [
      {
        id: createControlHookId("invalid"),
        priority: 1,
        criticality: "OPTIONAL",
        timeoutMs: 100,
        hook: {
          async evaluate() {
            return { kind: "ALLOW" } as never;
          },
        },
      },
    ];
    const pipeline = createToolGuardPipeline({ registrations });

    await expect(
      pipeline.evaluate(
        {
          runId: context.identity.runId,
          sessionId: context.identity.sessionId,
          sourceStepId: context.stepId!,
          externalCallId: "call-1",
          toolName: "exec_command",
          argsFingerprint: "args-fingerprint",
        },
        context,
      ),
    ).rejects.toThrow("Tool Guard pipeline failed safely.");
  });

  it("orders sanitized PREPEND and APPEND feedback without changing the built-in text authority", async () => {
    const registry = createControlHookRegistryBuilder<ToolFeedbackContributionHook>()
      .register({
        id: createControlHookId("append"),
        priority: 20,
        criticality: "OPTIONAL",
        timeoutMs: 100,
        hook: {
          async contribute() {
            return [{ id: "a", text: "API_KEY=SECRET", placement: "APPEND" as const }];
          },
        },
      })
      .register({
        id: createControlHookId("prepend"),
        priority: 10,
        criticality: "REQUIRED",
        timeoutMs: 100,
        hook: {
          async contribute() {
            return [{ id: "p", text: "before", placement: "PREPEND" as const }];
          },
        },
      })
      .build();
    const pipeline = createToolFeedbackContributionPipeline({
      registry,
      textSanitizer: (value) => value.replace("API_KEY=SECRET", "[REDACTED]"),
    });

    const result = await pipeline.contribute(
      {
        runId: context.identity.runId,
        sessionId: context.identity.sessionId,
        sourceStepId: context.stepId!,
        toolCallId: "call-1",
        toolName: "exec_command",
        observationId: "observation-1" as never,
        isError: false,
        builtInFeedback: "built-in",
      },
      context,
    );

    expect(result.content).toBe("before\n\nbuilt-in\n\n[REDACTED]");
    expect(result.receipts.map((receipt) => receipt.hookId)).toEqual(["prepend", "append"]);
  });
});
