import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import { createRunId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskPlanContextProvider } from "../src/context/task-plan-context-provider.js";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

/**
 * What a model gets back after a plan call is refused.
 *
 * ```text
 * the refusal          a correction it can act on, and the fact that nothing was recorded
 * the correction       a resend the parser accepts, read from the actual refusal text
 * the next Context     the accepted plan, and no reminder that an update is still open
 * durable derivation   a later refusal and a stale plan are re-derived, never remembered
 * ```
 *
 * The first two are one scripted Run: the adapter does not know the refusal text, it *reads* it out of
 * the Tool result it was given and resends accordingly. A test that asserted a hardcoded sentence back
 * at itself would pass while a real model still had nothing to act on.
 */

let disposeFixture: (() => Promise<void>) | undefined;

afterEach(async () => {
  await disposeFixture?.();
  disposeFixture = undefined;
});

const V2_PLAN = {
  plan: [
    {
      id: "editor",
      step: "Repair the editor round trip",
      status: "in_progress",
      acceptance: ["an edit survives a reload"],
      evidenceRefs: ["verification:editor-round-trip"],
    },
  ],
  execution: { nextAction: "run the round-trip check" },
};

class PlanCorrectionAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly requests: ApiAdapterStreamInput[] = [];
  /** What the refusal actually said, so the assertions read the same text the model did. */
  refusalText?: string;
  resentWithVersion?: boolean;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input);
    return this.turn(this.requests.length, input);
  }

  private async *turn(index: number, input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      // The v2-only fields, without the version that authorises them.
      yield* toolCall("plan-1", "update_plan", V2_PLAN);
      yield finish("TOOL_CALLS");
      return;
    }
    if (index === 2) {
      const refusal = input.request.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content)
        .find((content) => content.includes("PLAN_VERSION_REQUIRED"));
      this.refusalText = refusal;
      if (refusal === undefined) {
        yield* answer("No refusal reached the model.");
        return;
      }
      // The correction the refusal asked for, not a guess: same plan, plus the version.
      yield* toolCall("plan-2", "update_plan", { planVersion: 2, ...V2_PLAN });
      this.resentWithVersion = true;
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer("The plan is recorded.");
  }
}

describe("plan rejection feedback through the daemon", () => {
  it("turns a refusal into a correction the model can act on, and records the corrected plan", async () => {
    const adapter = new PlanCorrectionAdapter();
    const fixture = await createReliabilityFixture({ adapter, permissionPreset: "FULL_ACCESS" });
    disposeFixture = () => fixture.dispose();

    const result = await fixture.composition.controller.start(fixture.run.id);
    expect(result.run.status).toBe("COMPLETED");

    // The refusal the model received: the code, the correction, and the fact it wrote nothing.
    expect(adapter.refusalText).toBeDefined();
    expect(adapter.refusalText).toContain("Tool operation failed: PLAN_VERSION_REQUIRED.");
    expect(adapter.refusalText).toContain("Fix:");
    expect(adapter.refusalText).toContain("`planVersion: 2`");
    expect(adapter.refusalText).toContain("Nothing was recorded");
    // Nothing of the rejected payload is repeated back to the model.
    expect(adapter.refusalText).not.toContain("Repair the editor round trip");
    expect(adapter.refusalText).not.toContain("an edit survives a reload");

    // The correction was accepted, and it is the record the Run keeps.
    expect(adapter.resentWithVersion).toBe(true);
    const planText = JSON.stringify(adapter.requests.at(-1)?.request.messages);
    expect(planText).toContain("CURRENT PLAN v2");
    expect(planText).toContain("Repair the editor round trip");
    // A corrected plan is not an open refusal: the next Context carries no reminder about one.
    expect(planText).not.toContain("UPDATE_REJECTED");
    // Reported status is never independent evidence, whatever the plan says.
    expect(planText).toContain("reportedStatus=in_progress");
    expect(planText).not.toContain("independentEvidence=PASSED");
  }, 30_000);
});

/**
 * The reminders are re-derived from durable messages on every Step.
 *
 * A provider that remembered them in memory would lose them on the next restart, and a provider that
 * wrote them into the plan would make a refusal look like a recorded state. Both are projections, so
 * both are recomputed — and two independent providers over the same messages must agree byte for byte.
 */
describe("plan reminders derived from durable messages", () => {
  const RUN = createRunId();

  function sourceInput(messages: readonly { readonly message: unknown; readonly sequence: number }[]) {
    return {
      identity: { runId: RUN, sessionId: "ses_test", stepId: "stp_test", goal: "goal" },
      conversation: { turns: [{ messages }] },
      signal: new AbortController().signal,
    } as never;
  }

  function acceptedPlan() {
    return [
      {
        sequence: 1,
        message: {
          type: "ASSISTANT",
          runId: RUN,
          id: "msg_plan",
          content: [
            {
              type: "TOOL_CALL",
              toolCallId: "call_plan",
              toolName: "update_plan",
              input: { planVersion: 2, ...V2_PLAN },
            },
          ],
        },
      },
      {
        sequence: 2,
        message: {
          type: "TOOL_RESULT",
          runId: RUN,
          id: "msg_plan_result",
          toolCallId: "call_plan",
          toolName: "update_plan",
          isError: false,
        },
      },
    ];
  }

  function refusedUpdate(sequence: number) {
    return [
      {
        sequence,
        message: {
          type: "ASSISTANT",
          runId: RUN,
          id: `msg_refused_${String(sequence)}`,
          content: [
            {
              type: "TOOL_CALL",
              toolCallId: `call_refused_${String(sequence)}`,
              toolName: "update_plan",
              input: V2_PLAN,
            },
          ],
        },
      },
      {
        sequence: sequence + 1,
        message: {
          type: "TOOL_RESULT",
          runId: RUN,
          id: `msg_refused_result_${String(sequence)}`,
          toolCallId: `call_refused_${String(sequence)}`,
          toolName: "update_plan",
          isError: true,
          projectedContent:
            "Tool operation failed: PLAN_VERSION_REQUIRED.\nFix: resend with `planVersion: 2`.",
        },
      },
    ];
  }

  function workResults(count: number, from = 10) {
    return Array.from({ length: count }, (_unused, index) => ({
      sequence: from + index,
      message: {
        type: "TOOL_RESULT",
        runId: RUN,
        id: `msg_work_${String(index)}`,
        toolCallId: `call_work_${String(index)}`,
        toolName: "bash",
        isError: false,
      },
    }));
  }

  async function noticeOf(messages: readonly { readonly message: unknown; readonly sequence: number }[]) {
    const provider = createTaskPlanContextProvider();
    const result = (await provider.collect(sourceInput(messages))) as never as {
      items: readonly { id: string; payload: { text: string } }[];
    };
    return result.items.find((item) => String(item.id).endsWith("notice"))?.payload.text ?? "";
  }

  it("shows a refused update and a stale plan, and clears both on a new revision", async () => {
    const base = [...acceptedPlan(), ...refusedUpdate(3)];

    // A refusal after the accepted revision is visible while it is still open.
    expect(await noticeOf(base)).toContain("UPDATE_REJECTED PLAN_VERSION_REQUIRED");
    expect(await noticeOf(base)).not.toContain("STALE");

    // A plan that the work has outgrown says so, once the count is high enough to mean it.
    const stale = [...base, ...workResults(24)];
    expect(await noticeOf(stale)).toContain("STALE");
    expect(await noticeOf([...base, ...workResults(23)])).not.toContain("STALE");

    // A new accepted revision is what clears both: the refusal was answered and the count restarts.
    const corrected = [
      ...acceptedPlan(),
      ...refusedUpdate(3),
      ...workResults(24),
      { sequence: 40, message: { ...acceptedPlan()[0]!.message, id: "msg_plan_2" } },
      {
        sequence: 41,
        message: {
          type: "TOOL_RESULT",
          runId: RUN,
          id: "msg_plan_result_2",
          toolCallId: "call_plan",
          toolName: "update_plan",
          isError: false,
        },
      },
    ];
    const correctedNotice = await noticeOf(corrected);
    expect(correctedNotice).not.toContain("UPDATE_REJECTED");
    expect(correctedNotice).not.toContain("STALE");
    expect(correctedNotice).toContain("accepted Tool results since plan: 0");
  });

  it("renders the same reminders for the same durable messages, twice over", async () => {
    const messages = [...acceptedPlan(), ...refusedUpdate(3), ...workResults(24)];
    // Two independent providers: a reminder that lived in memory would not survive the second one.
    expect(await noticeOf(messages)).toBe(await noticeOf(structuredClone(messages)));
  });

  it("never turns a reported completion into verified evidence", async () => {
    const provider = createTaskPlanContextProvider();
    const completed = [
      {
        sequence: 1,
        message: {
          type: "ASSISTANT",
          runId: RUN,
          id: "msg_plan",
          content: [
            {
              type: "TOOL_CALL",
              toolCallId: "call_plan",
              toolName: "update_plan",
              input: {
                planVersion: 2,
                plan: [
                  { id: "editor", step: "Repair the editor", status: "completed" },
                  { id: "tests", step: "Run the suite", status: "completed" },
                ],
              },
            },
          ],
        },
      },
      {
        sequence: 2,
        message: {
          type: "TOOL_RESULT",
          runId: RUN,
          id: "msg_plan_result",
          toolCallId: "call_plan",
          toolName: "update_plan",
          isError: false,
        },
      },
    ];
    const result = (await provider.collect(sourceInput(completed))) as never as {
      items: readonly { payload: { text: string } }[];
    };
    const text = result.items.map((item) => item.payload.text).join("\n");
    expect(text).toContain("reportedStatus=completed; independentEvidence=UNVERIFIED");
    // No step is rendered as independently passing, and the summary counts zero passes.
    expect(text).not.toContain("independentEvidence=PASSED");
    expect(text).toContain("PASSED 0");
    // A plan that reports everything done still says a completed mark is a report, not proof.
    expect(text).toContain("a completed mark is a report, not proof");
  });
});
