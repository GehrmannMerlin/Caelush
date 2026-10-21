import { createTaskPlanContextProvider } from "../src/context/task-plan-context-provider.js";
import { createRunId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

/**
 * The plan the model gets back on its next turn.
 *
 * ```text
 * no accepted plan      no item at all — not an empty plan that implies one is required
 * accepted v1 plan      the historical checklist, unchanged
 * accepted v2 plan      milestones with their acceptance and the bounded working record
 * very large plan       bounded in bytes, with the limit visible in the text
 * ```
 *
 * The provider is a projection: it reads the Run's messages and publishes what they prove. These tests
 * exercise it through its real `collect` input, so a change to the identity filter or the sort order
 * shows up here rather than in production.
 */

const RUN_ID = createRunId();

function sourceInput(
  messages: readonly { readonly message: unknown; readonly sequence: number }[],
) {
  return {
    identity: { runId: RUN_ID, sessionId: "ses_test", stepId: "stp_test", goal: "goal" },
    conversation: { turns: [{ messages }] },
    signal: new AbortController().signal,
  } as never;
}

function assistantCall(callId: string, args: unknown, runId = RUN_ID) {
  return {
    sequence: 1,
    message: {
      type: "ASSISTANT",
      runId,
      id: `msg_${callId}`,
      content: [{ type: "TOOL_CALL", toolCallId: callId, toolName: "update_plan", input: args }],
    },
  };
}

function acceptedResult(callId: string, runId = RUN_ID) {
  return {
    sequence: 2,
    message: {
      type: "TOOL_RESULT",
      runId,
      id: `msg_result_${callId}`,
      toolCallId: callId,
      toolName: "update_plan",
      isError: false,
    },
  };
}

function textOf(result: { items: readonly { payload?: { text?: string } }[] }): string {
  return result.items[0]?.payload?.text ?? "";
}

describe("task plan context", () => {
  it("contributes nothing when the Run has recorded no plan", async () => {
    const provider = createTaskPlanContextProvider();
    const result = (await provider.collect(sourceInput([]))) as never as {
      items: readonly unknown[];
    };
    expect(result.items).toHaveLength(0);
  });

  it("publishes an accepted v2 plan with its working record", async () => {
    const provider = createTaskPlanContextProvider();
    const result = (await provider.collect(
      sourceInput([
        assistantCall("call_1", {
          planVersion: 2,
          explanation: "the endpoint rejects empty patches",
          plan: [
            {
              id: "editor",
              step: "editor round-trip",
              status: "in_progress",
              acceptance: ["an edit round-trips"],
            },
          ],
          execution: {
            unresolved: ["preview is missing"],
            nextAction: "fix the validator",
          },
        }),
        acceptedResult("call_1"),
      ]),
    )) as never as {
      providerVersion: string;
      items: readonly { payload?: { text?: string }; tokenEstimate?: number }[];
    };
    const text = textOf(result);
    expect(result.providerVersion).toBe("task-plan-v3");
    expect(text).toContain("CURRENT PLAN v2");
    expect(text).toContain("Why it changed: the endpoint rejects empty patches");
    expect(text).toContain("UNRESOLVED");
    expect(text).toContain("fix the validator");
    // A step that cites nothing still says so, instead of looking silently unchecked.
    expect(text).toContain(
      "refs: none; reportedStatus=in_progress; independentEvidence=UNVERIFIED",
    );
    // The item's token estimate is derived from the text, not a constant.
    expect(result.items[0]?.tokenEstimate).toBeGreaterThan(1);
  });

  it("ignores a plan recorded by a different Run in the same conversation", async () => {
    const provider = createTaskPlanContextProvider();
    const other = createRunId();
    const result = (await provider.collect(
      sourceInput([
        assistantCall("call_1", { plan: [{ step: "other", status: "pending" }] }, other),
        acceptedResult("call_1", other),
      ]),
    )) as never as { items: readonly unknown[] };
    expect(result.items).toHaveLength(0);
  });

  it("keeps a large plan inside the projection budget", async () => {
    const provider = createTaskPlanContextProvider();
    const result = (await provider.collect(
      sourceInput([
        assistantCall("call_1", {
          planVersion: 2,
          explanation: "汉".repeat(700),
          plan: Array.from({ length: 20 }, (_u, index) => ({
            id: `s${String(index)}`,
            step: `里程碑 ${String(index)} ${"汉".repeat(150)}`,
            status: "pending" as const,
            acceptance: ["汉".repeat(200)],
          })),
          execution: { unresolved: Array.from({ length: 8 }, () => "汉".repeat(280)) },
        }),
        acceptedResult("call_1"),
      ]),
    )) as never as { items: readonly { payload?: { text?: string } }[] };
    const text = textOf(result);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(text).toContain("summarized/truncated");
  });
});
