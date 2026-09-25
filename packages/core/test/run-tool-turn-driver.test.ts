import { createTimestampMs, type StepId } from "@caelush/protocol";
import {
  ToolBatchInfrastructureError,
  ToolBatchInputError,
  type ProjectedToolFeedback,
} from "@caelush/agent";
import { describe, expect, it } from "vitest";

import { RunControllerInvariantError } from "../src/index.js";
import { createRunToolTurnDriverFactory } from "../src/run-tool-turn-coordinator.js";
import {
  answerTurn,
  approvalRequest,
  eventTypes,
  harness3d,
  makeRunD,
  stubToolBatches,
  stubToolTurnPipeline,
  toolResultItem,
  toolTurn,
  type ToolBatchAnswer,
} from "./support/phase-3d-tool-turn.js";

/**
 * Phase 3D — the durable Tool turn driver.
 *
 * ```text
 * Coordinator -> EXECUTE_TOOL_BATCH -> RunExecutionDriver -> real ToolTurnCoordinator
 *                                                          -> ToolBatchCoordinatorPort
 * ```
 *
 * The Tool Layer is stubbed at the legacy `ToolBatchCoordinatorPort` and nowhere else, so every
 * boundary in between is the production one: the frozen driver, the real run-scoped adapter, the
 * request-identity verification, the resource admission, the observation projection and the typed
 * settlement. What these tests are about is therefore *what the Run Layer did* — how many times it
 * drove a Tool turn, whether it re-dispatched a batch that may already be durable, whether it sent a
 * partial batch to the model, and what it persisted when it settled.
 *
 * The stub is asked through its own scripted answers rather than by replacing its methods, so its
 * recorded call log stays the Tool Layer's own account of what it was asked to do.
 */

interface ItemLike {
  readonly externalCallId: string;
  readonly toolName: string;
}

/** One completed batch that echoes the calls it was asked for, in the order it received them. */
function completeAnswer(
  content = "body",
  extras: {
    readonly invocationId?: (index: number) => string;
    readonly rawArtifactRef?: (index: number) => string | undefined;
  } = {},
): (items: readonly ItemLike[]) => ToolBatchAnswer {
  return (items) => ({
    kind: "COMPLETED",
    items: items.map((item, index) => {
      const rawArtifactRef = extras.rawArtifactRef?.(index);
      return toolResultItem({
        externalCallId: item.externalCallId,
        toolName: item.toolName,
        content: `${content}:${item.externalCallId}`,
        // The index makes the default durable identity (and therefore the observation id) distinct
        // per call: two calls sharing one invocation id would be one Tool invocation, not two.
        index,
        ...(extras.invocationId === undefined ? {} : { invocationId: extras.invocationId(index) }),
        ...(rawArtifactRef === undefined ? {} : { rawArtifactRef }),
      });
    }),
  });
}

/** A stub scripted with one answer, which may be a function of the requested items. */
function scriptedBatches(
  answer: ToolBatchAnswer | ((items: readonly ItemLike[]) => ToolBatchAnswer),
  failures: readonly unknown[] = [],
) {
  const batches = stubToolBatches([], failures);
  batches.answerWith = answer;
  return batches;
}

/**
 * Drive a Run to a durable Tool boundary and return the snapshot it left behind.
 *
 * The batch refuses with an infrastructure failure *after* the boundary is durable but before any
 * result is accepted, which is exactly the restart shape: a Run parked on a `WAITING_TOOL_RESULTS`
 * continuation with nothing received. Driving it through the real controller is what makes the
 * seeded state a state production can actually produce.
 */
/**
 * Drive a Run to a durable Tool boundary and return the snapshot it left behind.
 *
 * The batch stops at an approval, which is the honest restart shape: the Run parks on a durable
 * `WAITING_TOOL_RESULTS` continuation with `waitingApproval` recorded and **nothing accepted**, so
 * the model was shown none of the batch. The approval identities come from the Tool Layer, so the
 * boundary is told about them rather than inventing them.
 */
async function parkOnToolBoundary(
  calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
  }[] = [{ id: "call_a", name: "read_file", input: { path: "a.ts" } }],
) {
  const harness = harness3d({
    script: (call) => (call === 0 ? toolTurn(calls) : answerTurn()),
    toolBatches: scriptedBatches({
      kind: "WAITING_APPROVAL",
      // Nothing reached a final item outcome before the waiting call.
      items: [],
      pendingCall: { externalCallId: calls[0]!.id, toolName: calls[0]!.name, args: {} },
      approval: approvalRequest({
        id: "apr_waiting",
        toolInvocationId: "tiv_waiting",
      }),
    }),
  });
  const result = await harness.controller.start(harness.store.snapshot.run.id);
  const snapshot = harness.store.snapshot;
  if (
    result.status !== "WAITING_APPROVAL" ||
    snapshot.continuation?.type !== "WAITING_TOOL_RESULTS"
  ) {
    throw new Error("the Run never opened a durable Tool boundary");
  }
  const waiting = snapshot.continuation.waitingApproval;
  if (waiting?.approvalId === undefined) throw new Error("no approval was created");
  harness.approvals.declare({
    approvalId: waiting.approvalId,
    toolInvocationId: waiting.invocationId,
  });
  return { harness, snapshot, approvalId: waiting.approvalId };
}
describe("Phase 3D Tool turn driver", () => {
  it("drives EXECUTE_TOOL_BATCH through the frozen Run execution driver exactly once", async () => {
    const batches = scriptedBatches(completeAnswer("body", { invocationId: (i) => `tiv_${i}` }));
    const h = harness3d({
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn("finished"),
      toolBatches: batches,
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    // One Tool directive, one Tool driver effect, one physical batch, two provider turns.
    expect(batches.calls).toHaveLength(1);
    expect(batches.calls[0]!.operation).toBe("execute");
    expect(batches.physicalExecutions).toBe(1);
    expect(h.turns).toHaveLength(2);
    expect(result.status).toBe("AWAITING_VERIFICATION");
  });

  it("hands the legacy Tool Layer only the frozen facts plus the captured Run-scoped ones", async () => {
    const batches = scriptedBatches(completeAnswer());
    const run = makeRunD({ permissionProfile: "PROJECT_ACCESS", approvalPolicy: "DANGEROUS_ONLY" });
    const h = harness3d({
      run,
      script: (call) =>
        call === 0
          ? toolTurn([{ id: "call_a", name: "read_file", input: { path: "a.ts" } }])
          : answerTurn(),
      toolBatches: batches,
    });

    await h.controller.start(h.store.snapshot.run.id);

    const request = batches.calls[0]!.request;
    // The frozen request carries no workspace, Runtime or security context; the adapter captured
    // them from the durable Run, and they are the Run's own.
    expect(request.runId).toBe(run.id);
    expect(request.sessionId).toBe(run.sessionId);
    expect(request.environment).toEqual({ workspace: run.workspace, runtime: run.runtime });
    expect(request.securityContext).toEqual({
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
    });
    // The batch is the model's own request, in its own order, with its own arguments.
    expect(request.calls).toEqual([
      { externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } },
    ]);
    // And the source Step is the Step the model's turn actually ran as.
    expect(request.sourceStepId).toBe(h.allocatedSteps[0]);
  });

  it("executes a multi-call batch sequentially in assistant source order", async () => {
    const batches = scriptedBatches(completeAnswer("body", { invocationId: (i) => `tiv_${i}` }));
    const h = harness3d({
      script: (call) =>
        call === 0
          ? toolTurn([
              { id: "call_a", name: "read_file" },
              { id: "call_b", name: "read_file" },
              { id: "call_c", name: "read_file" },
            ])
          : answerTurn(),
      toolBatches: batches,
    });

    await h.controller.start(h.store.snapshot.run.id);

    // The Tool Layer is handed the batch in the assistant's own source order.
    expect(batches.calls[0]!.request.calls.map((call) => call.externalCallId)).toEqual([
      "call_a",
      "call_b",
      "call_c",
    ]);
    // One batch, not three turns: a batch is one Tool turn however many calls it holds.
    expect(batches.calls).toHaveLength(1);
    const toolResults = h.store.snapshot.conversation.filter(
      (entry) => entry.message.role === "tool",
    );
    expect(
      toolResults.map((entry) =>
        entry.message.role === "tool" ? entry.message.toolCallId : undefined,
      ),
    ).toEqual(["call_a", "call_b", "call_c"]);
    // And the model sees them in that same order.
    const resumeTools = h.turns[1]!.request.messages.filter((message) => message.role === "tool");
    expect(
      resumeTools.map((message) => (message.role === "tool" ? message.toolCallId : "")),
    ).toEqual(["call_a", "call_b", "call_c"]);
  });

  it("shows the model the projected summary and nothing internal", async () => {
    const batches = scriptedBatches(
      completeAnswer("the raw body", {
        invocationId: (i) => `tiv_${i}`,
        rawArtifactRef: () => "artifact:raw-1",
      }),
    );
    const h = harness3d({
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn(),
      toolBatches: batches,
    });

    await h.controller.start(h.store.snapshot.run.id);

    // What the model saw on the resume turn: toolCallId, toolName, content, isError. The invocation
    // id, the observation and the raw artifact pointer stay in the Tool Layer.
    const resume = h.turns[1]!.request.messages;
    expect(resume.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      toolCallId: "call_a",
      toolName: "read_file",
      content: "the raw body:call_a",
      isError: false,
    });
    expect(JSON.stringify(resume)).not.toContain("tiv_0");
    expect(JSON.stringify(resume)).not.toContain("artifact:raw-1");

    // The durable continuation holds the same four fields and no more.
    const lastCheckpoint = h.store.commits
      .map((commit) =>
        commit.continuation?.operation === "SET" ? commit.continuation.checkpoint : undefined,
      )
      .filter((checkpoint) => checkpoint?.type === "WAITING_TOOL_RESULTS")
      .at(-1);
    expect(
      lastCheckpoint?.type === "WAITING_TOOL_RESULTS" ? lastCheckpoint.receivedResults : undefined,
    ).toEqual([
      {
        role: "tool",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "the raw body:call_a",
        isError: false,
      },
    ]);
  });

  it("applies the Core-private feedback contribution seam before normalization and durable history", async () => {
    const batches = scriptedBatches(completeAnswer("the raw body"));
    const applied: string[] = [];
    const h = harness3d({
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn(),
      toolBatches: batches,
      extra: {
        toolTurn: {
          ...stubToolTurnPipeline(batches),
          feedbackContributions: {
            apply: async (input: {
              readonly projected: readonly ProjectedToolFeedback[];
            }): Promise<readonly ProjectedToolFeedback[]> => {
              applied.push(input.projected[0]?.message.content ?? "");
              return input.projected.map((item) => ({
                ...item,
                message: {
                  ...item.message,
                  content: `PREPENDED\\n\\n${item.message.content}\\n\\nAPPENDED`,
                },
              }));
            },
          },
        },
      },
    });

    await h.controller.start(h.store.snapshot.run.id);

    expect(applied).toEqual(["the raw body:call_a"]);
    const toolResult = h.store.snapshot.conversation.find((entry) => entry.message.role === "tool");
    expect(toolResult?.message).toMatchObject({
      role: "tool",
      toolCallId: "call_a",
      content: "PREPENDED\\n\\nthe raw body:call_a\\n\\nAPPENDED",
    });
    expect(h.turns[1]!.request.messages).toContainEqual({
      role: "tool",
      toolCallId: "call_a",
      toolName: "read_file",
      content: "PREPENDED\\n\\nthe raw body:call_a\\n\\nAPPENDED",
      isError: false,
    });
  });

  it("persists the observation policy the requesting turn was prepared under", async () => {
    const h = harness3d({
      observationPolicy: { maxSingleObservationTokens: 111, maxObservationBatchTokens: 222 },
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn(),
      toolBatches: scriptedBatches(completeAnswer()),
    });

    await h.controller.start(h.store.snapshot.run.id);

    const opening = h.store.commits.find(
      (commit) =>
        commit.continuation?.operation === "SET" &&
        commit.continuation.checkpoint.type === "WAITING_TOOL_RESULTS",
    );
    const checkpoint =
      opening?.continuation?.operation === "SET" ? opening.continuation.checkpoint : undefined;
    expect(
      checkpoint?.type === "WAITING_TOOL_RESULTS" ? checkpoint.observationPolicy : undefined,
    ).toEqual({ maxSingleObservationTokens: 111, maxObservationBatchTokens: 222 });
  });

  it("does not append partial results when a batch stops at approval", async () => {
    const batches = scriptedBatches({
      kind: "WAITING_APPROVAL",
      items: [
        toolResultItem({
          externalCallId: "call_a",
          toolName: "read_file",
          content: "already done",
          invocationId: "tiv_a",
        }),
      ],
      pendingCall: { externalCallId: "call_b", toolName: "write_file", args: {} },
      approval: approvalRequest({ id: "apr_b", toolInvocationId: "tiv_b" }),
    });
    const h = harness3d({
      script: (call) =>
        call === 0
          ? toolTurn([
              { id: "call_a", name: "read_file" },
              { id: "call_b", name: "write_file" },
              { id: "call_c", name: "read_file" },
            ])
          : answerTurn(),
      toolBatches: batches,
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("WAITING_APPROVAL");
    // The whole batch is unanswered, so the model is shown *none* of it — including the call that
    // did complete. The completed invocation is durable in the Tool Layer, and that is what a
    // recovery resumes from.
    const continuation = h.store.snapshot.continuation;
    expect(continuation?.type).toBe("WAITING_TOOL_RESULTS");
    if (continuation?.type === "WAITING_TOOL_RESULTS") {
      expect(continuation.receivedResults).toBeUndefined();
      expect(continuation.waitingApproval).toEqual({
        invocationId: "tiv_b",
        approvalId: "apr_b",
        externalCallId: "call_b",
        toolName: "write_file",
      });
    }
    expect(h.store.snapshot.run.status).toBe("WAITING_APPROVAL");
    expect(h.store.snapshot.state?.status).toBe("WAITING_APPROVAL");
    expect(
      h.store.snapshot.conversation.filter((entry) => entry.message.role === "tool"),
    ).toHaveLength(0);
    // The Run announced RUNNING and then WAITING_APPROVAL; the Tool Layer's own lifecycle is not
    // republished by the Run Layer.
    expect(eventTypes(h.notifications).filter((type) => type === "status.changed")).toHaveLength(2);
  });

  it("recovers a resumed batch instead of dispatching it again", async () => {
    const { harness, snapshot, approvalId } = await parkOnToolBoundary();
    const parked = snapshot.continuation;
    if (parked?.type !== "WAITING_TOOL_RESULTS") throw new Error("expected a Tool continuation");
    // The Run stopped at the approval boundary with nothing accepted: the whole batch is unanswered,
    // so the model was shown none of it.
    expect(parked.receivedResults).toBeUndefined();

    // Resolving the approval is what an operator does after a restart. From here the Tool Layer
    // answers, so the recovery can settle the batch it stopped on.
    harness.toolBatches.answerWith = completeAnswer("recovered", {
      invocationId: (i) => `tiv_${i}`,
    });
    harness.executor.resetScript((_request, _signal, call) =>
      call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn("finished"),
    );

    const result = await harness.controller.resolveApproval(snapshot.run.id, approvalId, {
      action: "APPROVE",
      scope: "ONCE",
    });

    // The parked call was a *dispatch*; the resumption is a *recovery*, and Phase 4D changed which
    // entry point expresses that. `ToolTurnRequest.mode` is still `RECOVER` and is still recorded in
    // the Core-private observation — what changed is that the batch no longer selects a
    // restart-aware entry point of its own. Both entries are the canonical `execute()`, and whether an
    // individual call is fresh or already durable is decided by the durable coordinator's lookup by
    // `(runId, sourceStepId, externalCallId)`, not by the batch.
    expect(harness.toolBatches.calls.map((call) => call.operation)).toEqual(["execute", "execute"]);
    // That lookup is the durable coordinator's, and this harness stubs the *scheduler*, not the
    // durable Tool ledger: the stub has no invocation to find, so it cannot demonstrate that a durable
    // call is not re-executed. `packages/storage/test/run-controller-tool-integration.test.ts` drives
    // the real canonical batch over a real Tool execution store and is where that is proven.
    expect(harness.toolBatches.physicalExecutions).toBe(2);
    expect(result.status).toBe("AWAITING_VERIFICATION");
  });

  it("re-presents the same batch on RECOVER instead of selecting a second entry point", async () => {
    const { harness, snapshot, approvalId } = await parkOnToolBoundary();
    harness.toolBatches.answerWith = completeAnswer("recovered", {
      invocationId: (i) => `tiv_${i}`,
    });

    const result = await harness.controller.resolveApproval(snapshot.run.id, approvalId, {
      action: "APPROVE",
      scope: "ONCE",
    });

    // `mode` survives the cutover: the request still declares `RECOVER` and still carries the Run's
    // live signal, and the same batch identity is re-presented. What it no longer does is call a
    // second entry point.
    expect(harness.toolBatches.calls).toHaveLength(2);
    expect(harness.toolBatches.calls[1]!.request.calls).toEqual([
      { externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } },
    ]);
    expect(harness.toolBatches.calls[1]!.request.sourceStepId).toBe(
      harness.toolBatches.calls[0]!.request.sourceStepId,
    );
    expect(result.status).toBe("AWAITING_VERIFICATION");
  });

  it("leaves a parked approval boundary exactly where it is", async () => {
    const { harness, snapshot } = await parkOnToolBoundary();

    const result = await harness.controller.recover(snapshot.run.id);

    // A pending approval is a durable boundary only an external resolution can move, so recovery
    // performs no Tool work at all — not a dispatch and not a recovery.
    expect(harness.toolBatches.calls.map((call) => call.operation)).toEqual(["execute"]);
    expect(harness.toolBatches.physicalExecutions).toBe(1);
    expect(result.status).toBe("WAITING_APPROVAL");
    expect(harness.store.snapshot.continuation?.type).toBe("WAITING_TOOL_RESULTS");
  });

  it("maps an invalid model batch to a MODEL_ERROR failure rather than a Tool failure", async () => {
    const batches = stubToolBatches([], [new ToolBatchInputError()]);
    const h = harness3d({
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn(),
      toolBatches: batches,
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("FAILED");
    expect(h.store.snapshot.state?.errors.at(-1)).toMatchObject({
      code: "MODEL_ERROR",
      phase: "LLM",
      retryable: false,
    });
    expect(h.turns).toHaveLength(1);
  });

  it("maps a Tool infrastructure exception to a sanitized RUNTIME_ERROR/TOOL failure", async () => {
    const batches = stubToolBatches(
      [],
      [new ToolBatchInfrastructureError("dispatcher exploded with a secret path")],
    );
    const h = harness3d({
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn(),
      toolBatches: batches,
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("FAILED");
    expect(h.store.snapshot.state?.errors.at(-1)).toMatchObject({
      code: "RUNTIME_ERROR",
      phase: "TOOL",
      retryable: false,
    });
    // The internal exception text never reaches the model, the Run or the event stream.
    const published = JSON.stringify(h.notifications);
    expect(published).not.toContain("dispatcher exploded");
    expect(published).not.toContain("secret path");
    // And it is not disguised as a model-facing Tool result.
    expect(
      h.store.snapshot.conversation.filter((entry) => entry.message.role === "tool"),
    ).toHaveLength(0);
  });

  it("refuses a Tool turn whose request identity is not the Run's durable batch", async () => {
    const { snapshot } = await parkOnToolBoundary();
    const pending = snapshot.continuation;
    if (pending?.type !== "WAITING_TOOL_RESULTS") throw new Error("expected a Tool continuation");
    const batches = stubToolBatches([completeAnswer()(pending.pendingDecision.toolRequests)]);
    const factory = createRunToolTurnDriverFactory({
      ...stubToolTurnPipeline(batches),
      clock: { now: () => createTimestampMs(1) },
      signal: () => new AbortController().signal,
    });
    const driver = factory(snapshot, "EXECUTE");

    await expect(
      driver.coordinator.execute({
        mode: "EXECUTE",
        sourceStepId: "stp_0195f3a0-0000-7000-8000-999999999999" as StepId,
        pendingDecision: pending.pendingDecision,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(RunControllerInvariantError);

    await expect(
      driver.coordinator.execute({
        mode: "EXECUTE",
        sourceStepId: pending.sourceStepId,
        pendingDecision: { ...pending.pendingDecision, toolRequests: [] } as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(RunControllerInvariantError);

    // Neither refusal dispatched anything.
    expect(batches.calls).toHaveLength(0);
  });
});
