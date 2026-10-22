import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createRequestedToolInvocation,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  modelMessageSource,
  startToolInvocation,
} from "@caelush/agent";
import type { AgentMessageRecordDraft } from "@caelush/agent";
import {
  AgentRunSchema,
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type AgentStep,
  type ContextBudgetPolicySnapshot,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  CHECK_FAILED_TOKEN,
  CHECK_PASSED_MARKER,
  FeedbackDrivenAdapter,
  PADDING_READS,
  type FeedbackScenario,
} from "./support/feedback-driven-adapter.js";
import {
  createReliabilityFixture,
  type ReliabilityFixture,
} from "./support/reliability-fixture.js";

/**
 * Scenarios driven by the feedback the model actually received.
 *
 * ```text
 * step n     reads the result of one specific callId, and the newest plan block
 * step n+1   exists only because that result is the one this scenario needed
 * ```
 *
 * The difference from the long-run test is the point of this file. There, turn 7 sends the patch
 * because turn 7 sends the patch. Here, the patch is sent because the schema refusal for `bad-patch`
 * was delivered, quoted the offending field, and was not reported as an infrastructure failure. If
 * any of that is untrue the adapter raises at that request and the scenario fails there.
 *
 * What this proves is the feedback channel: a rejection reaches the model as a correction it can act
 * on, a failed check reaches it as a fact it can repair, repaired history is readable without being
 * replayed, and the newest plan plus its newest failure survive a working-set compaction. It is not
 * evidence about a real model's willingness to use any of it — that needs a configured provider and
 * is reported separately.
 */

const execFileAsync = promisify(execFile);

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function fixtureFor(
  scenario: FeedbackScenario,
  options: {
    readonly contextBudgetPolicy?: ContextBudgetPolicySnapshot;
    readonly modelLimits?: {
      readonly contextWindowTokens: number;
      readonly maxOutputTokens: number;
    };
    readonly goal?: string;
  } = {},
): Promise<{ readonly adapter: FeedbackDrivenAdapter; readonly fixture: ReliabilityFixture }> {
  const adapter = new FeedbackDrivenAdapter(scenario);
  const fixture = await createReliabilityFixture({
    adapter,
    permissionPreset: "FULL_ACCESS",
    limits: { maxSteps: 40, maxToolCalls: 80, timeoutMs: 120_000 },
    ...(options.goal === undefined ? {} : { goal: options.goal }),
    ...(options.modelLimits === undefined ? {} : { modelLimits: options.modelLimits }),
    ...(options.contextBudgetPolicy === undefined
      ? {}
      : { contextBudgetPolicy: options.contextBudgetPolicy }),
  });
  disposers.push(() => fixture.dispose());
  return { adapter, fixture };
}

describe("feedback-driven reliability scenarios", () => {
  it("corrects a rejected Tool argument only after the schema feedback arrives", async () => {
    const { adapter, fixture } = await fixtureFor("argument-correction");

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(result.run.status).toBe("COMPLETED");
    // The rejected call never became an invocation: nothing downstream of admission ran for it.
    const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
    expect(invocations.map((item) => item.externalCallId)).toEqual([
      "plan-1",
      "good-patch",
      "plan-2",
      "read-back",
    ]);
    expect(await fixture.storage.observations.listByRun(fixture.run.id)).toHaveLength(4);
    expect(await readFile(join(fixture.workspacePath, "greeting.mjs"), "utf8")).toContain(
      "GREETING_SENTINEL",
    );
    // The consumption record is the evidence that the correction followed feedback, not a counter.
    expect(
      adapter.consumptions.map((entry) => `${entry.consumedCallId}:${entry.observation}`),
    ).toEqual([
      "plan-1:SUCCEEDED",
      "bad-patch:REJECTED",
      "good-patch:SUCCEEDED",
      "plan-2:SUCCEEDED",
      "read-back:SUCCEEDED",
    ]);
  }, 60_000);

  it("repairs a failing check from its real outcome and re-runs it", async () => {
    const { adapter, fixture } = await fixtureFor("failed-check-repair");

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(result.run.status).toBe("COMPLETED");
    expect(
      adapter.consumptions.map((entry) => `${entry.consumedCallId}:${entry.observation}`),
    ).toEqual([
      "plan-1:SUCCEEDED",
      "write-check:SUCCEEDED",
      "run-check-1:CHECK_FAILED",
      "plan-2:SUCCEEDED",
      "fix-check:SUCCEEDED",
      "run-check-2:CHECK_PASSED",
      "plan-3:SUCCEEDED",
    ]);
    // Independent evidence: the check is run again outside the Agent, in its own process.
    const script = join(fixture.workspacePath, "check.mjs");
    const executed = await execFileAsync(process.execPath, [script], {
      cwd: fixture.workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(executed.stdout).toContain(CHECK_PASSED_MARKER);
    // The failure the model acted on was a real execution, not a narrative: two runs of the script.
    const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
    expect(invocations.filter((item) => item.toolName === "exec_command")).toHaveLength(2);
  }, 60_000);

  it("keeps the plan and the newest failure in the request after a working-set compaction", async () => {
    const { adapter, fixture } = await fixtureFor("post-compaction", {
      modelLimits: { contextWindowTokens: 32_768, maxOutputTokens: 2_048 },
      goal: "Continue the reliability scenario from its accepted feedback.",
      contextBudgetPolicy: {
        version: "WORKING_SET_V2",
        requestBudget: { version: "LEGACY_FULL_OUTPUT_V1" },
        workingSet: {
          // A deliberately small working set, so the Run really reaches pressure by reading durable
          // files. The threshold has to sit above the fixed Context sources, and the compacted range
          // has to be a real fraction of the source — otherwise the gain gate refuses the compaction
          // and nothing about surviving one is proven.
          targetTokens: 4_000,
          triggerRatio: 0.75,
          postCompactionRatio: 0.5,
          allowCurrentTurnPrefix: true,
          cooldownTurns: 1,
        },
      },
    });
    await writeFile(join(fixture.workspacePath, "failing-check.mjs"), FAILING_SCRIPT, "utf8");
    for (const name of PADDING_READS) {
      await writeFile(join(fixture.workspacePath, name), PADDING, "utf8");
    }

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(
      result.run.status,
      JSON.stringify({
        status: result.run.status,
        failure: adapter.contractFailure,
        summaryCalls: adapter.summaryCalls,
        consumptions: adapter.consumptions,
        mainRequestCount: adapter.mainRequests.length,
        finalMessageCount: adapter.mainRequests.at(-1)?.request.messages.length,
        checkpoints: (await fixture.storage.contextCheckpointsV2.listByRun(fixture.run.id)).length,
        usage: await fixture.composition.contextUsage.getContextUsage(String(fixture.run.id)),
      }),
    ).toBe("COMPLETED");
    // Compaction really ran; otherwise nothing about surviving it was proven.
    expect(adapter.summaryCalls).toBeGreaterThan(0);
    expect(
      (await fixture.storage.contextCheckpointsV2.listByRun(fixture.run.id)).length,
    ).toBeGreaterThan(0);
    // The failure token reaches the request the model reads after compaction.
    expect(JSON.stringify(adapter.mainRequests.at(-1)?.request.messages)).toContain(
      CHECK_FAILED_TOKEN,
    );
    // Compaction is a read-side projection: durable Tool results keep their own bytes.
    const records = await fixture.storage.messageRecords.listByRun(fixture.run.id);
    const toolResultText = records
      .filter((record) => record.messageType === "TOOL_RESULT")
      .map((record) => JSON.stringify(record.data))
      .join("\n");
    expect(toolResultText).toContain(CHECK_FAILED_TOKEN);
    const sequences = records.map((record) => record.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  }, 60_000);

  it("keeps the original history when an elective semantic summary fails", async () => {
    const { adapter, fixture } = await fixtureFor("keep-original-post-compaction", {
      modelLimits: { contextWindowTokens: 32_768, maxOutputTokens: 2_048 },
      goal: "Continue the reliability scenario from its accepted feedback.",
      contextBudgetPolicy: {
        version: "WORKING_SET_V2",
        requestBudget: { version: "LEGACY_FULL_OUTPUT_V1" },
        workingSet: {
          targetTokens: 4_000,
          triggerRatio: 0.75,
          postCompactionRatio: 0.5,
          allowCurrentTurnPrefix: true,
          cooldownTurns: 1,
        },
      },
    });
    await writeFile(join(fixture.workspacePath, "failing-check.mjs"), FAILING_SCRIPT, "utf8");
    for (const name of PADDING_READS) {
      await writeFile(join(fixture.workspacePath, name), PADDING, "utf8");
    }

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(
      result.run.status,
      JSON.stringify({ run: result.run, failure: adapter.contractFailure }),
    ).toBe("COMPLETED");
    expect(adapter.summaryCalls).toBeGreaterThan(0);
    const checkpoints = await fixture.storage.contextCheckpointsV2.listByRun(fixture.run.id);
    expect(checkpoints).toHaveLength(0);
    expect(JSON.stringify(adapter.mainRequests.at(-1)?.request.messages)).toContain(
      CHECK_FAILED_TOKEN,
    );
    const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
    expect(invocations.filter((invocation) => invocation.toolName === "read_history")).toHaveLength(
      0,
    );
    expect(adapter.consumptions.at(-1)).toMatchObject({
      consumedCallId: "read-back",
      observation: "SUCCEEDED",
    });
    expect(adapter.contractFailure).toBeUndefined();
  }, 90_000);

  it("re-issues a call that provably never started, and inspects an unknown outcome first", async () => {
    const notStarted = await seedFailedRun("NONE");
    const notStartedResult = await notStarted.fixture.composition.controller.start(
      notStarted.fixture.run.id,
    );
    expect(notStartedResult.run.status).toBe("COMPLETED");
    expect(notStarted.adapter.consumptions[0]).toMatchObject({
      consumedCallId: "interrupted-call",
      observation: "NOT_STARTED",
    });
    // The repair executed nothing; the safe retry is the model's own new call.
    expect(notStarted.adapter.consumptions[1]).toMatchObject({
      consumedCallId: "retry-read",
      observation: "SUCCEEDED",
    });

    const unknown = await seedFailedRun("UNSTARTED_OBSERVATION");
    const unknownResult = await unknown.fixture.composition.controller.start(
      unknown.fixture.run.id,
    );
    expect(unknownResult.run.status).toBe("COMPLETED");
    expect(unknown.adapter.consumptions[0]).toMatchObject({
      consumedCallId: "interrupted-call",
      observation: "OUTCOME_UNKNOWN",
    });
    // An unknown outcome is inspected, never replayed: the second call reads the current state.
    expect(unknown.adapter.consumptions[1]).toMatchObject({
      consumedCallId: "inspect-state",
      observation: "SUCCEEDED",
    });
  }, 90_000);
});

const FAILING_SCRIPT = [
  `process.stdout.write("CHECK_FAILED ${CHECK_FAILED_TOKEN}\\n");`,
  "process.exitCode = 1;",
  "",
].join("\n");

const PADDING = Array.from(
  { length: 400 },
  (_, index) => `PADDING_LINE_${String(index).padStart(3, "0")} durable workspace facts`,
).join("\n");

const turns = createDeterministicConversationTurnIdFactory();
const projectors = createStandardAgentMessageProjectorRegistry();
const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));

/**
 * A FAILED Run in the fixture Session whose assistant message has one unanswered Tool call.
 *
 * `NONE` proves the handler was never entered; `UNSTARTED_OBSERVATION` leaves an invocation that
 * started and never settled, which is the unknown-outcome boundary. The repair mechanics are covered
 * by `failed-tool-history-continuation.test.ts`; this seed exists so the *choice* the model makes
 * after reading the closure can be observed through the same adapter the other scenarios use.
 */
async function seedFailedRun(invocation: "NONE" | "UNSTARTED_OBSERVATION"): Promise<{
  readonly adapter: FeedbackDrivenAdapter;
  readonly fixture: ReliabilityFixture;
}> {
  const adapter = new FeedbackDrivenAdapter(
    invocation === "NONE" ? "historical-not-started" : "historical-unknown",
  );
  const fixture = await createReliabilityFixture({ adapter, permissionPreset: "FULL_ACCESS" });
  disposers.push(() => fixture.dispose());
  await writeFile(
    join(fixture.workspacePath, "state.txt"),
    "STATE_SENTINEL current state\n",
    "utf8",
  );

  const now = createTimestampMs(Date.now() - 60_000);
  const run = AgentRunSchema.parse({
    ...fixture.run,
    id: createRunId(),
    goal: "The run that failed before its requested Tool result was answered.",
    // Seeded RUNNING because the Tool execution ledger only accepts facts while the Run is running.
    status: "RUNNING",
    createdAt: now,
    startedAt: createTimestampMs(now + 50),
  });
  await fixture.storage.runs.insert(run);

  const step: AgentStep = {
    id: createStepId(),
    runId: run.id,
    sequence: 1,
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
    content: [
      {
        type: "TOOL_CALL" as const,
        toolCallId: "interrupted-call",
        toolName: "read_file" as const,
        input: { path: "state.txt" },
      },
    ],
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
  await fixture.storage.messageRecords.append(run.id, [draft]);

  if (invocation === "UNSTARTED_OBSERVATION") {
    const requested = createRequestedToolInvocation({
      id: createToolInvocationId(),
      runId: run.id,
      stepId: step.id,
      externalCallId: "interrupted-call",
      toolName: "read_file",
      args: { path: "state.txt" },
      riskLevel: "LOW",
      createdAt: createTimestampMs(now + 200),
    });
    await fixture.storage.toolExecution.commit({
      sessionId: run.sessionId,
      invocation: requested,
      expectedRevision: null,
      events: [],
    });
    // Started with no observation committed: the side-effect boundary is genuinely unknown, and the
    // seed leaves it that way on purpose.
    await fixture.storage.toolExecution.commit({
      sessionId: run.sessionId,
      invocation: startToolInvocation(requested, createTimestampMs(now + 300)),
      expectedRevision: 1,
      events: [],
    });
  }

  await fixture.storage.runs.update({
    ...run,
    status: "FAILED",
    finishedAt: createTimestampMs(now + 1_000),
  });
  return { adapter, fixture };
}
