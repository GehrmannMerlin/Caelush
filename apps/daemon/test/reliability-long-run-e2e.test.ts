import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

const fixtures: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of fixtures.splice(0)) await dispose();
});

const RESOURCE_POLICY = {
  mode: "ADAPTIVE",
  correctionVersion: "AUTONOMOUS_CORRECTION_V2",
  operationalLease: { maxAgentTurns: 12, maxToolOperations: 24 },
  batch: { maxToolCallsPerTurn: 2 },
  progress: {
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 4,
    replansBeforePause: 2,
  },
  hardLimits: {},
  inactivity: {},
} as const;

const WORKING_SET = {
  version: "WORKING_SET_V2",
  requestBudget: { version: "LEGACY_FULL_OUTPUT_V1" },
  workingSet: {
    targetTokens: 12_000,
    triggerRatio: 0.75,
    postCompactionRatio: 0.5,
    allowCurrentTurnPrefix: true,
    cooldownTurns: 5,
  },
} as const;

function summaryText(): string {
  return JSON.stringify({
    goal: "Complete the synthetic reliability workload.",
    constraints: ["Preserve user intent and accepted plan state."],
    completedWork: ["Older closed tool batches were summarized."],
    inProgress: ["Continue from the most recent closed batch."],
    blocked: [],
    importantDiscoveries: ["The active turn remains open across tool batches."],
    keyDecisions: ["Keep the newest tool batch and current user request."],
    criticalReferences: [],
    nextIntent: "Continue the deterministic workload.",
  });
}

const TASK_STORE_PATCH = [
  "*** Begin Patch",
  "*** Add File: app/task-store.mjs",
  '+import { readFile, writeFile } from "node:fs/promises";',
  '+import { dirname, join } from "node:path";',
  '+import { fileURLToPath } from "node:url";',
  "+",
  '+const dataFile = join(dirname(fileURLToPath(import.meta.url)), "tasks.json");',
  "+",
  "+export async function loadTasks() {",
  "+  try {",
  '+    return JSON.parse(await readFile(dataFile, "utf8"));',
  "+  } catch (error) {",
  '+    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];',
  "+    throw error;",
  "+  }",
  "+}",
  "+",
  "+export async function saveTask(task) {",
  '+  if (!task || typeof task.id !== "string" || typeof task.title !== "string") {',
  '+    throw new TypeError("A task needs a string id and title.");',
  "+  }",
  "+  const tasks = await loadTasks();",
  "+  const index = tasks.findIndex((entry) => entry.id === task.id);",
  "+  if (index < 0) tasks.push(task);",
  "+  else tasks[index] = task;",
  '+  await writeFile(dataFile, JSON.stringify(tasks, null, 2) + "\\n", "utf8");',
  "+  return structuredClone(task);",
  "+}",
  "+",
  "+export async function createTask(title) {",
  '+  if (typeof title !== "string" || title.trim().length === 0) {',
  '+    throw new TypeError("Task title is required.");',
  "+  }",
  '+  const task = { id: "task-1", title: title.trim(), completed: false };',
  "+  await saveTask(task);",
  "+  return task;",
  "+}",
  "+",
  "+export async function queryTasks(text) {",
  "+  const tasks = await loadTasks();",
  "+  return tasks.filter((task) => task.title.toLowerCase().includes(text.toLowerCase()));",
  "+}",
  "*** End Patch",
].join("\n");

class CorrectionAndApplicationAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly mainRequests: ApiAdapterStreamInput[] = [];
  summaryCalls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if ((input.request.tools?.length ?? 0) === 0) {
      this.summaryCalls += 1;
      return this.summary();
    }
    this.mainRequests.push(input);
    return this.turn(this.mainRequests.length);
  }

  private async *summary(): AsyncGenerator<AIAdapterEvent> {
    yield* answer(summaryText());
  }

  private async *turn(index: number): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      yield* toolCall("app-plan", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "create-store",
            step: "Create and exercise the synthetic task store.",
            status: "in_progress",
            acceptance: ["Create, save, reload and query return durable task data."],
          },
        ],
        execution: {
          goal: "Create a small task store app through the actual daemon tool path.",
          constraints: ["Keep task data inside the fixture workspace."],
          discoveries: [],
          decisions: [],
          unresolved: [],
          nextAction: "Create the task-store module and verify it independently.",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index >= 2 && index <= 5) {
      yield* toolCall("invalid-patch-" + index, "apply_patch", { patch: 7 as never });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index === 6) {
      yield* toolCall("valid-patch-6", "apply_patch", { patch: TASK_STORE_PATCH });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index >= 7 && index <= 10) {
      yield* toolCall("invalid-read-" + index, "read_file", { path: 7 as never, limit: 20 });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index === 11) {
      yield* toolCall("resolved-read-11", "read_file", { path: "evidence.txt", limit: 40 });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index < 75) {
      yield* toolCall("evidence-read-" + index, "read_file", { path: "evidence.txt", limit: 40 });
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer(
      "The synthetic task store passed its independent create/save/reload/query checks.",
    );
  }
}

class LongWorkingSetAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly mainRequests: ApiAdapterStreamInput[] = [];
  readonly requestSamples: Array<{ turn: number; bytes: number; messageCount: number }> = [];
  summaryCalls = 0;
  scriptedToolCalls = 0;
  private mainTurn = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if (
      (input.request.tools?.length ?? 0) === 0 ||
      input.request.toolChoice?.type === "NONE" ||
      input.request.messages.some((message) =>
        JSON.stringify(message).includes("Compaction semantic source JSON"),
      )
    ) {
      this.summaryCalls += 1;
      return this.summary();
    }
    this.mainTurn += 1;
    this.mainRequests.push(input);
    this.requestSamples.push({
      turn: this.mainTurn,
      bytes: Buffer.byteLength(JSON.stringify(input.request.messages), "utf8"),
      messageCount: input.request.messages.length,
    });
    return this.turn(this.mainTurn);
  }

  private async *summary(): AsyncGenerator<AIAdapterEvent> {
    yield* answer(summaryText());
  }

  private async *turn(index: number): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      this.scriptedToolCalls += 1;
      yield* toolCall("long-plan", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "long-run",
            step: "Process the scripted evidence in bounded batches.",
            status: "in_progress",
            acceptance: ["All 400 Tool results remain ordered and safely resumable."],
          },
        ],
        execution: {
          goal: "Exercise a single long user turn with safe working-set compaction.",
          constraints: ["Do not mutate the frozen hard limits."],
          discoveries: [],
          decisions: [],
          unresolved: [],
          nextAction: "Read the durable evidence in bounded batches.",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index >= 2 && index <= 150) {
      this.scriptedToolCalls += 2;
      const firstRead = (index - 2) * 2 + 1;
      yield* evidenceRead("long-read-" + index + "-a", firstRead);
      yield* evidenceRead("long-read-" + index + "-b", firstRead + 1);
      yield finish("TOOL_CALLS");
      return;
    }
    if (index === 151 || index === 152) {
      this.scriptedToolCalls += 2;
      const firstRead = 299 + (index - 151) * 2;
      yield* evidenceRead("long-read-" + index + "-a", firstRead);
      yield* evidenceRead("long-read-" + index + "-b", firstRead + 1);
      yield finish("TOOL_CALLS");
      return;
    }
    if (index === 249) {
      this.scriptedToolCalls += 1;
      yield* evidenceRead("long-read-249", 399);
      yield finish("TOOL_CALLS");
      return;
    }
    if (index >= 153 && index < 249) {
      this.scriptedToolCalls += 1;
      yield* evidenceRead("long-read-" + index, 303 + (index - 153));
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer(
      "The 250-step single-turn workload completed after preserving the latest workset.",
    );
  }
}

function makeEvidence(): string {
  return Array.from(
    { length: 40 },
    (_, index) =>
      "EVIDENCE_LINE_" +
      String(index).padStart(3, "0") +
      " " +
      "durable observation and current task facts ".repeat(4),
  ).join("\n");
}

function makeSmallEvidence(): string {
  return Array.from(
    { length: 8 },
    (_, index) =>
      "APP_EVIDENCE_" + String(index).padStart(2, "0") + " " + "real fixture data ".repeat(6),
  ).join("\n");
}

function evidenceRead(id: string, ordinal: number): AIAdapterEvent[] {
  return toolCall(id, "read_file", {
    path: "evidence.txt",
    offset: ((ordinal - 1) % 40) + 1,
    limit: 1,
  });
}

describe("daemon long-run reliability acceptance", () => {
  it("continues after four invalid patches, commits the fifth patch, and verifies the created app", async () => {
    const adapter = new CorrectionAndApplicationAdapter();
    const fixture = await createReliabilityFixture({
      adapter,
      limits: { maxSteps: 80, maxToolCalls: 100, timeoutMs: 180_000 },
      resourcePolicy: RESOURCE_POLICY,
      permissionPreset: "FULL_ACCESS",
    });
    fixtures.push(() => fixture.dispose());
    await writeFile(join(fixture.workspacePath, "evidence.txt"), makeSmallEvidence(), "utf8");

    const result = await fixture.composition.controller.start(fixture.run.id);
    const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
    const observations = await fixture.storage.observations.listByRun(fixture.run.id);
    const toolResults = (await fixture.storage.messageRecords.listByRun(fixture.run.id)).filter(
      (record) => record.messageType === "TOOL_RESULT",
    );
    const progress = await fixture.storage.resourceGovernance.get(fixture.run.id);

    expect(result.run.status).toBe("COMPLETED");
    expect(adapter.mainRequests).toHaveLength(75);
    expect(toolResults).toHaveLength(74);
    expect(invocations).toHaveLength(66);
    expect(observations.filter((item) => item.kind === "TOOL")).toHaveLength(66);
    expect(invocations.filter((item) => item.toolName === "apply_patch")).toHaveLength(1);
    expect(observations.filter((item) => item.kind === "TOOL" && item.isError)).toHaveLength(0);
    expect(progress?.leaseEpoch).toBeGreaterThan(1);
    expect(progress?.semanticProgress?.deliveryReceipts?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(progress?.correctionRecovery).toBeUndefined();
    expect(JSON.stringify(adapter.mainRequests[5]?.request.messages)).toMatch(
      /INPUT_CORRECTION|REVIEW_APPROACH|repeated|correction/iu,
    );

    const moduleUrl = pathToFileURL(join(fixture.workspacePath, "app", "task-store.mjs")).href;
    const taskStore = await import(moduleUrl);
    const created = await taskStore.createTask("reliable local tasks");
    expect(created).toEqual({
      id: "task-1",
      title: "reliable local tasks",
      completed: false,
    });
    await taskStore.saveTask({ ...created, completed: true });
    const reloaded = await taskStore.loadTasks();
    expect(reloaded).toEqual([{ ...created, completed: true }]);
    expect(await taskStore.queryTasks("local")).toEqual([{ ...created, completed: true }]);
    expect(
      JSON.parse(await readFile(join(fixture.workspacePath, "app", "tasks.json"), "utf8")),
    ).toEqual(reloaded);
  }, 180_000);

  it("runs 250 model steps and 400 ordered Tool results in one compacted user turn", async () => {
    const adapter = new LongWorkingSetAdapter();
    const fixture = await createReliabilityFixture({
      adapter,
      limits: { maxSteps: 270, maxToolCalls: 430, timeoutMs: 600_000 },
      resourcePolicy: RESOURCE_POLICY,
      contextBudgetPolicy: WORKING_SET,
    });
    fixtures.push(() => fixture.dispose());
    await writeFile(join(fixture.workspacePath, "evidence.txt"), makeEvidence(), "utf8");

    const startedAt = performance.now();
    const result = await fixture.composition.controller.start(fixture.run.id);
    const elapsedMs = performance.now() - startedAt;
    const records = await fixture.storage.messageRecords.listByRun(fixture.run.id);
    const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
    const observations = await fixture.storage.observations.listByRun(fixture.run.id);
    const checkpoints = await fixture.storage.contextCheckpointsV2.listByRun(fixture.run.id);
    const progress = await fixture.storage.resourceGovernance.get(fixture.run.id);
    const toolResults = records.filter((record) => record.messageType === "TOOL_RESULT");
    const requestedCallIds = records
      .filter((record) => record.messageType === "ASSISTANT")
      .flatMap((record) => {
        const content = record.data.content;
        if (!Array.isArray(content)) return [];
        return content.flatMap((part) => {
          if (
            typeof part !== "object" ||
            part === null ||
            !("type" in part) ||
            part.type !== "TOOL_CALL" ||
            !("toolCallId" in part) ||
            typeof part.toolCallId !== "string"
          )
            return [];
          return [part.toolCallId];
        });
      });
    const resultCallIds = toolResults.map((record) => record.data.toolCallId);
    const firstRequest = adapter.requestSamples[0];
    const finalRequest = adapter.requestSamples.at(-1);

    expect(result.run.status).toBe("COMPLETED");
    expect(adapter.mainRequests).toHaveLength(250);
    expect(adapter.scriptedToolCalls).toBe(400);
    expect(toolResults).toHaveLength(400);
    expect(invocations).toHaveLength(400);
    expect(observations.filter((item) => item.kind === "TOOL")).toHaveLength(400);
    expect(resultCallIds).toEqual(requestedCallIds);
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(firstRequest).toBeDefined();
    expect(finalRequest).toBeDefined();
    expect(finalRequest!.bytes).toBeLessThan(firstRequest!.bytes * 4);
    expect(progress?.leaseEpoch).toBeGreaterThanOrEqual(4);
    expect(adapter.summaryCalls).toBeGreaterThanOrEqual(2);
    expect(elapsedMs).toBeGreaterThan(0);

    const metrics = {
      scenario: "long-run-250-400",
      elapsedMs: Math.round(elapsedMs),
      mainModelSteps: adapter.mainRequests.length,
      scriptedToolCalls: adapter.scriptedToolCalls,
      toolResults: toolResults.length,
      invocations: invocations.length,
      observations: observations.filter((item) => item.kind === "TOOL").length,
      compactionCalls: adapter.summaryCalls,
      checkpoints: checkpoints.length,
      leaseEpoch: progress?.leaseEpoch,
      firstRequestBytes: firstRequest?.bytes,
      finalRequestBytes: finalRequest?.bytes,
      firstRequestMessages: firstRequest?.messageCount,
      finalRequestMessages: finalRequest?.messageCount,
    };
    console.info(JSON.stringify(metrics));
    const metricsPath = process.env["CAELUSH_RELIABILITY_METRICS_PATH"];
    if (metricsPath !== undefined) {
      await writeFile(metricsPath, JSON.stringify(metrics, null, 2) + "\n", "utf8");
    }
  }, 600_000);
});
