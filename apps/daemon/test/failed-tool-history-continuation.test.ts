import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import {
  completeToolInvocation,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createRequestedToolInvocation,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  createToolObservation,
  modelMessageSource,
  startToolInvocation,
} from "@caelush/agent";
import type { AgentMessageRecord, AgentMessageRecordDraft } from "@caelush/agent";
import {
  AgentRunSchema,
  createObservationId,
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type AgentRun,
  type AgentStep,
} from "@caelush/protocol";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

/**
 * Continuing after a FAILED Run, without reviving it.
 *
 * A Run that fails in the Tool phase can leave an assistant message whose calls have no results.
 * That gap is a conversation-protocol fact, not an execution fact: the *next* Run in the Session
 * cannot be built until it is closed. Closing it must not execute anything, must not rewrite the
 * failed Run, and must distinguish "never started" from "outcome unknown" — a model told the wrong
 * one either repeats a side effect or gives up on work it never did.
 *
 * The gap is seeded as durable state rather than produced by a product bug, so this file keeps
 * testing the continuation contract no matter which bug happened to create the first failure.
 */

const fixtures: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of fixtures.splice(0)) await dispose();
});

const turns = createDeterministicConversationTurnIdFactory();
const projectors = createStandardAgentMessageProjectorRegistry();
const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));

interface SeededCall {
  readonly toolCallId: string;
  readonly run: "COMPLETED" | "RUNNING" | "NONE";
}

interface SeededFailure {
  readonly run: AgentRun;
  readonly step: AgentStep;
  readonly assistant: AgentMessageRecord;
}

type Fixture = Awaited<ReturnType<typeof createReliabilityFixture>>;

/**
 * A FAILED Run in the fixture Session whose assistant message has no Tool results.
 *
 * `COMPLETED` seeds a real invocation and observation (the handler already ran once). `RUNNING`
 * seeds an invocation with no observation (the side-effect boundary is unknown). `NONE` seeds no
 * invocation at all (the durable startup contract proves the handler was never entered).
 */
async function seedFailedHistory(
  fixture: Fixture,
  calls: readonly SeededCall[],
): Promise<SeededFailure> {
  const now = createTimestampMs(Date.now() - 60_000);
  const run = AgentRunSchema.parse({
    ...fixture.run,
    id: createRunId(),
    goal: "The run that failed before every requested Tool result was answered.",
    // Seeded as RUNNING because the Tool execution ledger only accepts facts while the Run is
    // running; it is then failed exactly as the RunController would have failed it.
    status: "RUNNING",
    createdAt: now,
    startedAt: createTimestampMs(now + 50),
  });
  await fixture.storage.runs.insert(run);

  const step: AgentStep = {
    id: createStepId(),
    runId: run.id,
    sequence: 1,
    // The model step completed; the failure happened while applying what it asked for.
    status: "COMPLETED",
    startedAt: now,
    finishedAt: createTimestampMs(now + 400),
  };
  await fixture.storage.steps.insert(step);

  const assistant = createAgentMessageFactory({
    ids: createAgentMessageIdFactory(),
    now: () => createTimestampMs(now + 100),
    turns,
  }).createAssistant({
    runId: run.id,
    sessionId: run.sessionId,
    conversationTurnId: turns.forRun(run.id),
    sourceStepId: step.id,
    source: modelMessageSource("llm_failed_history"),
    phase: "COMMENTARY",
    content: calls.map((call) => ({
      type: "TOOL_CALL" as const,
      toolCallId: call.toolCallId,
      toolName: "read_file" as const,
      input: { path: `${call.toolCallId}.txt` },
    })),
    model: {
      kind: "MODEL_TURN",
      callId: "llm_failed_history",
      model: { provider: "fixture", model: "fixture-model" },
      finishReason: "TOOL_CALLS",
    },
  });
  const encoded = codecs.encode(assistant);
  const draft: AgentMessageRecordDraft = {
    messageId: assistant.id,
    sessionId: run.sessionId,
    conversationTurnId: assistant.conversationTurnId,
    messageType: assistant.type,
    schemaVersion: encoded.schemaVersion,
    modelProjectionVersion: encoded.modelProjectionVersion,
    sourceStepId: step.id,
    createdAt: assistant.createdAt,
    source: assistant.source,
    audience: assistant.audience,
    data: encoded.data,
  };
  const [assistantRecord] = await fixture.storage.messageRecords.append(run.id, [draft]);
  if (assistantRecord === undefined) throw new Error("assistant fixture did not persist");

  for (const call of calls) {
    if (call.run === "NONE") continue;
    const invocation = createRequestedToolInvocation({
      id: createToolInvocationId(),
      runId: run.id,
      stepId: step.id,
      externalCallId: call.toolCallId,
      toolName: "read_file",
      args: { path: `${call.toolCallId}.txt` },
      riskLevel: "LOW",
      createdAt: createTimestampMs(now + 200),
    });
    await fixture.storage.toolExecution.commit({
      sessionId: run.sessionId,
      invocation,
      expectedRevision: null,
      events: [],
    });
    const running = startToolInvocation(invocation, createTimestampMs(now + 300));
    await fixture.storage.toolExecution.commit({
      sessionId: run.sessionId,
      invocation: running,
      expectedRevision: 1,
      events: [],
    });
    if (call.run !== "COMPLETED") continue;
    const completed = completeToolInvocation(running, createTimestampMs(now + 700));
    await fixture.storage.toolExecution.commit({
      sessionId: run.sessionId,
      invocation: completed,
      expectedRevision: 2,
      observation: createToolObservation({
        id: createObservationId(),
        runId: run.id,
        stepId: step.id,
        toolInvocationId: invocation.id,
        content: `observed content for ${call.toolCallId}`,
        details: {},
        isError: false,
        createdAt: createTimestampMs(now + 700),
      }),
      events: [],
    });
  }

  // The RunController's own settlement, replayed as durable fact: the Run is terminal and its
  // assistant message keeps an unanswered call.
  const failedRun: AgentRun = {
    ...run,
    status: "FAILED",
    finishedAt: createTimestampMs(now + 1_000),
  };
  await fixture.storage.runs.update(failedRun);

  return { run: failedRun, step, assistant: assistantRecord };
}

function toolResultsOf(input: ApiAdapterStreamInput): Array<{
  readonly toolCallId: string;
  readonly text: string;
  readonly isError: boolean;
}> {
  return input.request.messages
    .filter((message) => message.role === "tool")
    .map((message) => {
      const content = message.content;
      return {
        toolCallId: message.toolCallId,
        text:
          typeof content === "string"
            ? content
            : content.map((part) => (part.type === "text" ? part.text : "")).join(""),
        isError: message.isError,
      };
    });
}

class CountingAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly requests: ApiAdapterStreamInput[] = [];

  constructor(private readonly script: (index: number) => readonly AIAdapterEvent[]) {}

  async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input);
    yield* this.script(this.requests.length);
  }
}

it("closes a failed Run's unanswered calls so the next Run reaches the model", async () => {
  const adapter = new CountingAdapter(() => answer("Continuing from the repaired history."));
  const fixture = await createReliabilityFixture({ adapter });
  fixtures.push(() => fixture.dispose());

  const seeded = await seedFailedHistory(fixture, [
    { toolCallId: "call_observed", run: "COMPLETED" },
    { toolCallId: "call_missing", run: "NONE" },
  ]);
  const messagesBefore = (await fixture.storage.messageRecords.listByRun(seeded.run.id)).length;
  const eventsBefore = await fixture.storage.eventReader.latestSequence(seeded.run.id);

  const result = await fixture.composition.controller.start(fixture.run.id);

  // The whole point: the new Run asked a model, which it could not do while the gap was open.
  expect(adapter.requests).toHaveLength(1);
  expect(result.run.status).toBe("COMPLETED");
  const results = toolResultsOf(adapter.requests[0]!);
  expect(results.map((toolResult) => toolResult.toolCallId)).toEqual([
    "call_observed",
    "call_missing",
  ]);
  // A committed observation is projected, not re-executed.
  expect(results[0]?.isError).toBe(false);
  expect(results[0]?.text).toContain("observed content for call_observed");
  // A call with no invocation is reported as never started, under the verified startup contract.
  expect(results[1]?.text).toContain("was not started");

  // The failed Run is not revived and its execution facts are untouched.
  expect((await fixture.storage.runs.get(seeded.run.id))?.status).toBe("FAILED");
  expect(await fixture.storage.toolInvocations.listByRun(seeded.run.id)).toHaveLength(1);
  expect(await fixture.storage.observations.listByRun(seeded.run.id)).toHaveLength(1);
  // Exactly the two appended results and their metadata-only commit facts.
  expect((await fixture.storage.messageRecords.listByRun(seeded.run.id)).length).toBe(
    messagesBefore + 2,
  );
  expect(await fixture.storage.eventReader.latestSequence(seeded.run.id)).toBe(eventsBefore + 2);
  // Repair executed nothing on behalf of the continuing Run either.
  expect(await fixture.storage.toolInvocations.listByRun(fixture.run.id)).toEqual([]);

  // A further Run after a restart finds nothing left to repair: no duplicate messages or events.
  const restarted = await fixture.restartComposition();
  const third = AgentRunSchema.parse({
    ...fixture.run,
    id: createRunId(),
    goal: "Continue again after a restart.",
    createdAt: createTimestampMs(Date.now()),
  });
  await fixture.storage.runs.insert(third);
  const thirdResult = await restarted.controller.start(third.id);
  expect(thirdResult.run.status).toBe("COMPLETED");
  expect(adapter.requests).toHaveLength(2);
  expect((await fixture.storage.messageRecords.listByRun(seeded.run.id)).length).toBe(
    messagesBefore + 2,
  );
  expect(await fixture.storage.eventReader.latestSequence(seeded.run.id)).toBe(eventsBefore + 2);
}, 60_000);

it("reports an unknown outcome instead of guessing it and never replays the call", async () => {
  const adapter = new CountingAdapter(() => answer("The unknown outcome was inspected first."));
  const fixture = await createReliabilityFixture({ adapter });
  fixtures.push(() => fixture.dispose());

  const seeded = await seedFailedHistory(fixture, [{ toolCallId: "call_running", run: "RUNNING" }]);
  const result = await fixture.composition.controller.start(fixture.run.id);

  expect(result.run.status).toBe("COMPLETED");
  expect(adapter.requests).toHaveLength(1);
  const results = toolResultsOf(adapter.requests[0]!);
  expect(results.map((toolResult) => toolResult.toolCallId)).toEqual(["call_running"]);
  expect(results[0]?.text).toContain("outcome is unknown");
  expect(results[0]?.isError).toBe(true);

  // Nothing was re-executed and nothing was invented: the invocation is still RUNNING with no
  // observation, which is the fact the model was told to verify before retrying.
  const invocations = await fixture.storage.toolInvocations.listByRun(seeded.run.id);
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.status).toBe("RUNNING");
  expect(await fixture.storage.observations.listByRun(seeded.run.id)).toEqual([]);
}, 60_000);

it("still refuses to repair history from a different workspace", async () => {
  const adapter = new CountingAdapter(() => answer("This answer must not be reached."));
  const fixture = await createReliabilityFixture({ adapter });
  fixtures.push(() => fixture.dispose());

  const seeded = await seedFailedHistory(fixture, [{ toolCallId: "call_cross", run: "NONE" }]);
  // A Run record whose workspace disagrees with the Session it belongs to.
  await fixture.storage.runs.update({
    ...seeded.run,
    workspace: { ...seeded.run.workspace, path: join(fixture.workspacePath, "elsewhere") },
  });

  const result = await fixture.composition.controller.start(fixture.run.id);

  expect(result.run.status).toBe("FAILED");
  expect(adapter.requests).toEqual([]);
  expect(await fixture.storage.messageRecords.listByRun(seeded.run.id)).toHaveLength(1);
}, 60_000);

it("lets the continuing Run request its own Tool after the repair", async () => {
  const adapter = new CountingAdapter((index) =>
    index === 1
      ? [...toolCall("read-after-repair", "read_file", { path: "seed.txt" }), finish("TOOL_CALLS")]
      : answer("Read it."),
  );
  const fixture = await createReliabilityFixture({ adapter });
  fixtures.push(() => fixture.dispose());
  await seedFailedHistory(fixture, [{ toolCallId: "call_missing", run: "NONE" }]);

  const result = await fixture.composition.controller.start(fixture.run.id);

  expect(result.run.status).toBe("COMPLETED");
  expect(
    (await fixture.storage.toolInvocations.listByRun(fixture.run.id)).map(
      (invocation) => invocation.externalCallId,
    ),
  ).toEqual(["read-after-repair"]);
}, 60_000);
