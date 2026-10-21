import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

let disposeFixture: (() => Promise<void>) | undefined;

afterEach(async () => {
  await disposeFixture?.();
  disposeFixture = undefined;
});

class UpdatePlanAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly requests: ApiAdapterStreamInput[] = [];
  private call = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input);
    this.call += 1;
    return this.turn(this.call);
  }

  private async *turn(index: number): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      yield* toolCall("plan-call", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "inspect",
            step: "Inspect the reliability fixture",
            status: "in_progress",
            acceptance: ["The accepted plan appears in the following model request."],
          },
        ],
        execution: {
          goal: "Keep the latest accepted work state available.",
          constraints: [],
          discoveries: [],
          decisions: [],
          unresolved: [],
          nextAction: "RELIABILITY_PLAN_SENTINEL: inspect the next real model request.",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer("The accepted fixture plan was available.");
  }
}

class PatchAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  private call = 0;

  stream(): AsyncGenerator<AIAdapterEvent> {
    this.call += 1;
    return this.turn(this.call);
  }

  private async *turn(index: number): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      yield* toolCall("patch-call", "apply_patch", {
        patch:
          "*** Begin Patch\n*** Add File: note.txt\n+created by the real daemon tool pipeline\n*** End Patch",
      });
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer("The fixture file was created.");
  }
}

class ReadOnlyCommandAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  private call = 0;

  stream(): AsyncGenerator<AIAdapterEvent> {
    this.call += 1;
    return this.turn(this.call);
  }

  private async *turn(index: number): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      yield* toolCall("command-call", "exec_command", {
        cmd: "Set-Content -LiteralPath 'denied.txt' -Value 'should-not-exist'",
      });
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer("The denied command returned its actual result.");
  }
}

describe("reliability control end-to-end", () => {
  it("accepts update_plan through composeDaemon, SQLite and the real Tool pipeline", async () => {
    const adapter = new UpdatePlanAdapter();
    const fixture = await createReliabilityFixture({ adapter });
    disposeFixture = () => fixture.dispose();

    const result = await fixture.composition.controller.start(fixture.run.id);
    const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
    const observations = await fixture.storage.observations.listByRun(fixture.run.id);
    const records = await fixture.storage.messageRecords.listByRun(fixture.run.id);
    const toolResults = records.filter((record) => record.messageType === "TOOL_RESULT");
    const matchingObservation =
      invocations.length === 1 && invocations[0] !== undefined
        ? await fixture.storage.observations.findByToolInvocation(invocations[0].id)
        : null;

    expect(result.run.status).toBe("COMPLETED");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ toolName: "update_plan", status: "COMPLETED" });
    expect(observations.filter((item) => item.kind === "TOOL")).toHaveLength(1);
    expect(matchingObservation).toMatchObject({ kind: "TOOL", isError: false });
    expect(toolResults).toHaveLength(1);
    expect(adapter.requests).toHaveLength(2);
    expect(JSON.stringify(adapter.requests[1]?.request.messages)).toContain(
      "RELIABILITY_PLAN_SENTINEL",
    );
  }, 30_000);

  it("writes a real patch to the fixture workspace and observes it on disk", async () => {
    const fixture = await createReliabilityFixture({ adapter: new PatchAdapter() });
    disposeFixture = () => fixture.dispose();

    const result = await fixture.composition.controller.start(fixture.run.id);
    expect(result.run.status).toBe("COMPLETED");
    await expect(readFile(join(fixture.workspacePath, "note.txt"), "utf8")).resolves.toBe(
      "created by the real daemon tool pipeline\n",
    );
    await expect(fixture.storage.toolInvocations.listByRun(fixture.run.id)).resolves.toMatchObject([
      { toolName: "apply_patch", status: "COMPLETED" },
    ]);
  }, 30_000);

  it("does not run a workspace-writing command under the VIEW_ONLY security policy", async () => {
    const fixture = await createReliabilityFixture({
      adapter: new ReadOnlyCommandAdapter(),
      permissionPreset: "VIEW_ONLY",
    });
    disposeFixture = () => fixture.dispose();

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(result.run.status).toBe("COMPLETED");
    await expect(readFile(join(fixture.workspacePath, "denied.txt"), "utf8")).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    const invocation = (await fixture.storage.toolInvocations.listByRun(fixture.run.id))[0];
    expect(invocation).toMatchObject({ toolName: "exec_command" });
    const observation =
      invocation === undefined
        ? null
        : await fixture.storage.observations.findByToolInvocation(invocation.id);
    expect(observation).toMatchObject({ kind: "TOOL", isError: true });
  }, 30_000);
});
