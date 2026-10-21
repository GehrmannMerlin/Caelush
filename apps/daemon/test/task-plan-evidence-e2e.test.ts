import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import { afterEach, describe, expect, it } from "vitest";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

let disposeFixture: (() => Promise<void>) | undefined;

afterEach(async () => {
  await disposeFixture?.();
  disposeFixture = undefined;
});

class ProcessEvidenceAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly requests: ApiAdapterStreamInput[] = [];
  citedReference?: string;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input);
    return this.turn(this.requests.length, input);
  }

  private async *turn(index: number, input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      yield* toolCall("plan-1", "update_plan", {
        planVersion: 2,
        plan: [{ id: "check", step: "Run the scripted process check", status: "in_progress" }],
        execution: { nextAction: "run the check and inspect its actual outcome" },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index === 2) {
      yield* toolCall("process-1", "exec_command", { cmd: "exit 2" });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index === 3) {
      const serialized = JSON.stringify(input.request.messages);
      const references = [
        ...serialized.matchAll(/observation:([A-Za-z0-9._-]{1,128}) — Tool exec_command;/gu),
      ];
      const reference = references.at(-1)?.[0]?.split(" —", 1)[0];
      if (reference === undefined) {
        yield* answer("No durable observation reference was exposed.");
        return;
      }
      this.citedReference = reference;
      yield* toolCall("plan-2", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "check",
            step: "Run the scripted process check",
            status: "completed",
            acceptance: ["The process exits successfully."],
            evidenceRefs: [reference],
          },
        ],
        execution: {
          unresolved: ["The process outcome still needs repair."],
          nextAction: "fix it",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer("The current plan projection reports the process failure.");
  }
}

describe("task plan evidence through the daemon and durable stores", () => {
  it("shows a completed invocation with exit code 2 as FAILED in the next real model request", async () => {
    const adapter = new ProcessEvidenceAdapter();
    const fixture = await createReliabilityFixture({ adapter, permissionPreset: "FULL_ACCESS" });
    disposeFixture = () => fixture.dispose();

    const result = await fixture.composition.controller.start(fixture.run.id);
    const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
    const processInvocation = invocations.find((item) => item.toolName === "exec_command");
    const observation =
      processInvocation === undefined
        ? null
        : await fixture.storage.observations.findByToolInvocation(processInvocation.id);

    expect(result.run.status).toBe("COMPLETED");
    expect(processInvocation).toMatchObject({ toolName: "exec_command", status: "COMPLETED" });
    expect(observation).toMatchObject({
      kind: "TOOL",
      isError: false,
      details: { status: "EXITED", exitCode: 2 },
    });
    expect(adapter.requests).toHaveLength(4);
    const planText = JSON.stringify(adapter.requests[3]?.request.messages);
    expect(planText).toContain("reportedStatus=completed; independentEvidence=FAILED");
    // The same resolved fact the step line carries is the one the summary counts and the list shows.
    expect(planText).toContain("独立证据");
    expect(planText).toMatch(/FAILED 1/u);
    expect(adapter.citedReference).toBeDefined();
    expect(planText).toContain(`- ${adapter.citedReference} — `);
    expect(planText).toContain("[FAILED]");
    // No fixed footer claiming that nothing passed beside a resolved state.
    expect(planText).not.toContain("no check has been shown to pass");
    // Coverage only: the projection never concludes that the whole task is verified.
    expect(planText).toContain("不构成全部需求完成");
  }, 30_000);
});
