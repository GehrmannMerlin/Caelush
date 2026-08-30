import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRunSchema,
  createEventId,
  createLLMCallId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { AgentLoop, RunController } from "@caelush/core";
import { EventBus } from "@caelush/events";
import { LLMTurnResultSchema, type LLMTurnResult } from "@caelush/llm/turn";
import {
  ToolBatchCoordinator,
  ToolDispatcher,
  ToolRegistryBuilder,
  createFileMutationToolRegistrations,
  createReadOnlyFilesystemToolRegistrations,
  createRequestedToolInvocation,
  startToolInvocation,
  type ToolCommittedEventNotifier,
  type ToolExecutionCommit,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutionGatePort,
} from "@caelush/tools";
import { describe, expect, it } from "vitest";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { CaelushToolExecutionGate } from "@caelush/security";

const definitions = [
  {
    name: "echo_value" as const,
    description: "Echo a value.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" }, secret: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    riskLevel: "LOW" as const,
    requiredCapabilities: [],
    runtimeRequirements: {},
  },
  {
    name: "approval_value" as const,
    description: "Requires approval.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    riskLevel: "HIGH" as const,
    requiredCapabilities: [],
    runtimeRequirements: {},
  },
];

function makeRun(pathname: string, runtimeKind = "fixture") {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect values",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: pathname },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: runtimeKind },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
  });
}

async function snapshotWorkspace(root: string): Promise<readonly unknown[]> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(absolutePath);
      files.push({
        path: path.relative(root, absolutePath).replaceAll(path.sep, "/"),
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function seedRun(storage: CaelushStorage, run: ReturnType<typeof makeRun>) {
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(1),
    metadata: {},
  });
  await storage.runs.insert(run);
}

function createRuntime(
  storage: CaelushStorage,
  eventBus: EventBus,
  execute: (request: ToolExecutionRequest) => Promise<ToolExecutionResult>,
  gate: (toolName: string) => "ALLOW" | "REQUIRE_APPROVAL" = () => "ALLOW",
  initialNow = 100,
) {
  const builder = new ToolRegistryBuilder();
  for (const definition of definitions) builder.register({ definition, handler: { execute } });
  const registry = builder.build();
  const notifier: ToolCommittedEventNotifier = {
    notifyCommitted: (events) => eventBus.notifyCommitted(events),
  };
  let now = initialNow;
  const dispatcher = new ToolDispatcher({
    registry,
    store: storage.toolExecution,
    gate: { decide: async ({ toolName }) => ({ kind: gate(toolName) }) },
    notifier,
    clock: { now: () => createTimestampMs(++now) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
  });
  return { dispatcher, coordinator: new ToolBatchCoordinator(dispatcher), registry };
}

function createFilesystemRuntime(
  storage: CaelushStorage,
  eventBus: EventBus,
  gate: ToolExecutionGatePort = { decide: async () => ({ kind: "ALLOW" as const }) },
) {
  const runtimeResolver = createLocalRuntimeResolver(new LocalRuntime());
  const builder = new ToolRegistryBuilder();
  for (const registration of createReadOnlyFilesystemToolRegistrations(runtimeResolver)) {
    builder.register(registration);
  }
  for (const registration of createFileMutationToolRegistrations(runtimeResolver)) {
    builder.register(registration);
  }
  const notifier: ToolCommittedEventNotifier = {
    notifyCommitted: (events) => eventBus.notifyCommitted(events),
  };
  let now = 100;
  const dispatcher = new ToolDispatcher({
    registry: builder.build(),
    store: storage.toolExecution,
    gate,
    notifier,
    clock: { now: () => createTimestampMs(++now) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
  });
  return { dispatcher, coordinator: new ToolBatchCoordinator(dispatcher) };
}

function createController(
  storage: CaelushStorage,
  eventBus: EventBus,
  turns: LLMTurnResult[],
  coordinator?: ToolBatchCoordinator,
  observedRequests: Array<{ tools?: unknown; messages: unknown[] }> = [],
  initialNow = 10,
) {
  let now = initialNow;
  const loop = new AgentLoop({
    inspector: { inspect: async () => ({}) as never },
    planner: { plan: async () => ({}) as never },
    contextBuilder: {
      build: (input) => ({
        messages:
          input.mode === "TOOL_CONTINUATION"
            ? input.currentTurnMessages
            : [input.currentUserMessage],
        report: {} as never,
      }),
    },
    llmClient: {
      complete: async (request) => {
        observedRequests.push({ tools: request.tools, messages: request.messages });
        return turns.shift()!;
      },
    },
    clock: { now: () => createTimestampMs(now++) },
    stepIdFactory: { create: () => createStepId() },
  });
  return new RunController({
    agentLoop: loop,
    execution: storage.execution,
    events: eventBus,
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic",
        contextLimits: { maxInputTokens: 1000 },
      }),
    },
    ...(coordinator === undefined ? {} : { toolCoordinator: coordinator }),
    clock: { now: () => createTimestampMs(now++) },
    eventIdFactory: { create: createEventId },
  });
}

function turn(
  text: string,
  toolCalls: LLMTurnResult["toolCalls"],
  finishReason: LLMTurnResult["finishReason"],
): LLMTurnResult {
  return LLMTurnResultSchema.parse({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls,
    finishReason,
  });
}

describe("RunController automatic Tool Batch integration", () => {
  it("runs real read-only filesystem tools through AgentLoop and leaves the workspace unchanged", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-8a-e2e-"));
    const workspace = path.join(directory, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "Caelush runtime\n", "utf8");
    await writeFile(
      path.join(workspace, "src", "agent.ts"),
      'export const name = "AgentLoop";\n',
      "utf8",
    );
    await writeFile(
      path.join(workspace, "src", "runtime.ts"),
      "export const runtime = true;\n",
      "utf8",
    );
    await writeFile(path.join(workspace, "src", "utf8.ts"), 'export const emoji = "😀";\n', "utf8");
    const before = await snapshotWorkspace(workspace);

    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun(workspace, "local");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.events);
    const runtime = createFilesystemRuntime(storage, eventBus);
    const observed: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [
        turn(
          "inspect workspace",
          [
            { id: "call-list", name: "list_directory", input: { path: "src" } },
            { id: "call-find", name: "find_files", input: { pattern: "**/*.ts" } },
            { id: "call-read", name: "read_file", input: { path: "src/agent.ts" } },
            {
              id: "call-search",
              name: "search_text",
              input: { pattern: "AgentLoop", include: "*.ts" },
            },
          ],
          "TOOL_CALLS",
        ),
        turn("Final Candidate", [], "STOP"),
      ],
      runtime.coordinator,
      observed,
    );

    try {
      const result = await controller.start(run.id);

      expect(result.status).toBe("AWAITING_VERIFICATION");
      expect(observed[0]?.tools).toEqual(runtime.coordinator.modelDefinitions());
      expect(observed[1]?.messages.slice(-4)).toEqual([
        expect.objectContaining({ toolCallId: "call-list", isError: false }),
        expect.objectContaining({
          toolCallId: "call-find",
          content: "src/agent.ts\nsrc/runtime.ts\nsrc/utf8.ts",
          isError: false,
        }),
        expect.objectContaining({
          toolCallId: "call-read",
          content: expect.stringContaining("1: export const name"),
          isError: false,
        }),
        expect.objectContaining({
          toolCallId: "call-search",
          content: expect.stringContaining("src/agent.ts:1:"),
          isError: false,
        }),
      ]);
      expect((await storage.toolInvocations.listByRun(run.id)).map((item) => item.status)).toEqual([
        "COMPLETED",
        "COMPLETED",
        "COMPLETED",
        "COMPLETED",
      ]);
      expect(await storage.observations.listByRun(run.id)).toHaveLength(4);
      expect(await snapshotWorkspace(workspace)).toEqual(before);
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs apply_patch through AgentLoop and lets a trailing read observe the committed files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-8b-e2e-"));
    const workspace = path.join(directory, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "math.ts"), "export const answer = 41;\n", "utf8");
    await writeFile(path.join(workspace, "src", "old.ts"), "export const old = true;\n", "utf8");
    await writeFile(path.join(workspace, "README.md"), "unchanged\n", "utf8");
    const beforeReadme = await readFile(path.join(workspace, "README.md"));

    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun(workspace, "local");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.events);
    const runtime = createFilesystemRuntime(storage, eventBus);
    const observed: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [
        turn(
          "mutate workspace",
          [
            {
              id: "call-patch",
              name: "apply_patch",
              input: {
                patch: [
                  "*** Begin Patch",
                  "*** Update File: src/math.ts",
                  "@@",
                  "-export const answer = 41;",
                  "+export const answer = 42;",
                  "*** Add File: src/helper.ts",
                  "+export const helper = true;",
                  "*** Delete File: src/old.ts",
                  "*** End Patch",
                ].join("\n"),
              },
            },
            { id: "call-read", name: "read_file", input: { path: "src/math.ts" } },
            { id: "call-read-helper", name: "read_file", input: { path: "src/helper.ts" } },
          ],
          "TOOL_CALLS",
        ),
        turn("Final Candidate", [], "STOP"),
      ],
      runtime.coordinator,
      observed,
    );

    try {
      const result = await controller.start(run.id);

      expect(result.status).toBe("AWAITING_VERIFICATION");
      expect(observed[1]?.messages.slice(-3)).toEqual([
        expect.objectContaining({
          toolCallId: "call-patch",
          content: expect.stringContaining("Patch applied."),
          isError: false,
        }),
        expect.objectContaining({
          toolCallId: "call-read",
          content: expect.stringContaining("export const answer = 42;"),
          isError: false,
        }),
        expect.objectContaining({
          toolCallId: "call-read-helper",
          content: expect.stringContaining("export const helper = true;"),
          isError: false,
        }),
      ]);
      expect((await storage.toolInvocations.listByRun(run.id)).map((item) => item.status)).toEqual([
        "COMPLETED",
        "COMPLETED",
        "COMPLETED",
      ]);
      expect(await readFile(path.join(workspace, "src", "math.ts"), "utf8")).toBe(
        "export const answer = 42;\n",
      );
      expect(await readFile(path.join(workspace, "src", "helper.ts"), "utf8")).toBe(
        "export const helper = true;\n",
      );
      await expect(readFile(path.join(workspace, "src", "old.ts"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(path.join(workspace, "README.md"))).toEqual(beforeReadme);
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("derives policy from AgentRun and stops a dangerous patch at approval", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-9a-approval-e2e-"));
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "unchanged\n", "utf8");
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = AgentRunSchema.parse({
      ...makeRun(workspace, "local"),
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.events);
    const runtime = createFilesystemRuntime(storage, eventBus, new CaelushToolExecutionGate());
    const controller = createController(
      storage,
      eventBus,
      [
        turn(
          "mutate workspace",
          [
            {
              id: "call-patch",
              name: "apply_patch",
              input: {
                patch: [
                  "*** Begin Patch",
                  "*** Update File: README.md",
                  "@@",
                  "-unchanged",
                  "+changed",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          ],
          "TOOL_CALLS",
        ),
      ],
      runtime.coordinator,
    );

    try {
      const result = await controller.start(run.id);
      expect(result.status).toBe("WAITING_APPROVAL");
      expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("unchanged\n");
      expect(await storage.toolInvocations.listByRun(run.id)).toMatchObject([
        { status: "WAITING_APPROVAL", toolName: "apply_patch" },
      ]);
      expect((await storage.runs.get(run.id))?.status).toBe("WAITING_APPROVAL");
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes one complete batch, resumes the AgentLoop, and preserves source order", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.events);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runtime = createRuntime(storage, eventBus, async ({ externalCallId }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${externalCallId}`);
      await new Promise((resolve) => setTimeout(resolve, externalCallId === "call-A" ? 5 : 0));
      order.push(`finish:${externalCallId}`);
      active -= 1;
      return {
        content: externalCallId === "call-B" ? "ordinary error" : externalCallId,
        details: { secret: "details-secret" },
        isError: externalCallId === "call-B",
      };
    });
    const observed: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [
        turn(
          "inspect",
          [
            { id: "call-A", name: "echo_value", input: {} },
            { id: "call-B", name: "echo_value", input: {} },
          ],
          "TOOL_CALLS",
        ),
        turn("final answer", [], "STOP"),
      ],
      runtime.coordinator,
      observed,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(order).toEqual(["start:call-A", "finish:call-A", "start:call-B", "finish:call-B"]);
    expect(maxActive).toBe(1);
    expect(observed).toHaveLength(2);
    expect(observed[0]?.tools).toEqual(runtime.coordinator.modelDefinitions());
    expect(observed[1]?.messages.slice(-2)).toEqual([
      {
        role: "tool",
        toolCallId: "call-A",
        toolName: "echo_value",
        content: "call-A",
        isError: false,
      },
      {
        role: "tool",
        toolCallId: "call-B",
        toolName: "echo_value",
        content: "ordinary error",
        isError: true,
      },
    ]);
    expect((await storage.messages.listByRun(run.id)).map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(
      (await storage.toolInvocations.listByRun(run.id)).map((invocation) => invocation.status),
    ).toEqual(["COMPLETED", "FAILED"]);
    expect(await storage.observations.listByRun(run.id)).toHaveLength(2);
    expect(JSON.stringify(await storage.messages.listByRun(run.id))).not.toContain(
      "details-secret",
    );
    expect((await storage.events.replay(run.id)).map((event) => event.type)).not.toContain(
      "run.completed",
    );
    await storage.close();
  });

  it("pauses the Run at approval and does not create trailing calls", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.events);
    const calls: string[] = [];
    const runtime = createRuntime(
      storage,
      eventBus,
      async ({ externalCallId }) => {
        calls.push(externalCallId);
        return { content: externalCallId, details: {}, isError: false };
      },
      (toolName) => (toolName === "approval_value" ? "REQUIRE_APPROVAL" : "ALLOW"),
    );
    const controller = createController(
      storage,
      eventBus,
      [
        turn(
          "inspect",
          [
            { id: "call-A", name: "echo_value", input: {} },
            { id: "call-B", name: "approval_value", input: {} },
            { id: "call-C", name: "echo_value", input: {} },
          ],
          "TOOL_CALLS",
        ),
      ],
      runtime.coordinator,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("WAITING_APPROVAL");
    expect(calls).toEqual(["call-A"]);
    expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(2);
    expect((await storage.toolInvocations.listByRun(run.id)).at(-1)?.status).toBe(
      "WAITING_APPROVAL",
    );
    const checkpoint = await storage.continuations.get(run.id);
    expect(checkpoint?.checkpoint.type).toBe("WAITING_TOOL_RESULTS");
    if (checkpoint?.checkpoint.type !== "WAITING_TOOL_RESULTS")
      throw new Error("expected checkpoint");
    expect(checkpoint.checkpoint.waitingApproval?.externalCallId).toBe("call-B");
    expect(checkpoint.checkpoint.receivedResults).toBeUndefined();
    expect((await storage.runs.get(run.id))?.status).toBe("WAITING_APPROVAL");
    expect((await storage.runStates.get(run.id))?.status).toBe("WAITING_APPROVAL");
    expect((await storage.messages.listByRun(run.id)).map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect((await controller.recover(run.id)).status).toBe("WAITING_APPROVAL");
    expect(calls).toEqual(["call-A"]);
    await storage.close();
  });

  it("drives multiple provider Tool turns without recursive controller calls", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.events);
    const calls: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ externalCallId }) => {
      calls.push(externalCallId);
      return { content: externalCallId, details: {}, isError: false };
    });
    const providerRequests: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [
        turn("first", [{ id: "call-A", name: "echo_value", input: {} }], "TOOL_CALLS"),
        turn("second", [{ id: "call-B", name: "echo_value", input: {} }], "TOOL_CALLS"),
        turn("final", [], "STOP"),
      ],
      runtime.coordinator,
      providerRequests,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(calls).toEqual(["call-A", "call-B"]);
    expect(providerRequests).toHaveLength(3);
    expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(2);
    expect((await storage.messages.listByRun(run.id)).map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    await storage.close();
  });

  it("returns an unknown Tool as a model-recoverable result while executing known Tools", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.events);
    const calls: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ externalCallId }) => {
      calls.push(externalCallId);
      return { content: "known result", details: {}, isError: false };
    });
    const requests: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [
        turn(
          "repair",
          [
            { id: "call-unknown", name: "unknown_tool", input: {} },
            { id: "call-known", name: "echo_value", input: {} },
          ],
          "TOOL_CALLS",
        ),
        turn("self corrected", [], "STOP"),
      ],
      runtime.coordinator,
      requests,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(calls).toEqual(["call-known"]);
    expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(1);
    expect(requests[1]?.messages.slice(-2)).toEqual([
      expect.objectContaining({ toolCallId: "call-unknown", isError: true }),
      expect.objectContaining({
        toolCallId: "call-known",
        content: "known result",
        isError: false,
      }),
    ]);
    await storage.close();
  });

  it("fails the Run on Tool infrastructure failure without submitting a partial batch", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.events);
    const calls: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ externalCallId }) => {
      calls.push(externalCallId);
      if (externalCallId === "call-B") throw new Error("handler-secret");
      return { content: "A", details: {}, isError: false };
    });
    const controller = createController(
      storage,
      eventBus,
      [
        turn(
          "run",
          [
            { id: "call-A", name: "echo_value", input: {} },
            { id: "call-B", name: "echo_value", input: {} },
          ],
          "TOOL_CALLS",
        ),
        turn("must not run", [], "STOP"),
      ],
      runtime.coordinator,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("FAILED");
    expect(calls).toEqual(["call-A", "call-B"]);
    expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(2);
    expect(await storage.observations.listByRun(run.id)).toHaveLength(2);
    expect((await storage.runs.get(run.id))?.status).toBe("FAILED");
    expect(await storage.continuations.get(run.id)).toBeNull();
    expect((await storage.messages.listByRun(run.id)).map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(await storage.events.replay(run.id))).not.toContain("handler-secret");
    await storage.close();
  });

  it("resumes directly from durably accepted Tool Results after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-7c-accepted-"));
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openCaelushStorage({ path: databasePath });
    const run = makeRun(path.join(directory, "project"));
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.events);
    const firstController = createController(firstStorage, firstBus, [
      turn("inspect", [{ id: "call-A", name: "echo_value", input: {} }], "TOOL_CALLS"),
    ]);
    const waiting = await firstController.start(run.id);
    expect(waiting.status).toBe("WAITING_TOOL_RESULTS");
    if (waiting.status !== "WAITING_TOOL_RESULTS") throw new Error("expected waiting boundary");
    const continuation = await firstStorage.continuations.get(run.id);
    if (continuation?.checkpoint.type !== "WAITING_TOOL_RESULTS")
      throw new Error("expected continuation");
    await firstStorage.continuations.set(
      run.id,
      {
        ...continuation.checkpoint,
        receivedResults: [
          {
            role: "tool",
            toolCallId: "call-A",
            toolName: "echo_value",
            content: "accepted",
            isError: false,
          },
        ],
      },
      createTimestampMs(30),
      continuation.revision,
    );
    await firstStorage.close();

    const restarted = await openCaelushStorage({ path: databasePath });
    const secondBus = new EventBus(restarted.events);
    const secondRuntime = createRuntime(
      restarted,
      secondBus,
      async () => {
        throw new Error("accepted Tool Results must not redispatch");
      },
      () => "ALLOW",
      200,
    );
    const observed: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const controller = createController(
      restarted,
      secondBus,
      [turn("accepted final", [], "STOP")],
      secondRuntime.coordinator,
      observed,
      200,
    );

    const result = await controller.recover(run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.messages.slice(-1)).toEqual([
      {
        role: "tool",
        toolCallId: "call-A",
        toolName: "echo_value",
        content: "accepted",
        isError: false,
      },
    ]);
    expect(await restarted.toolInvocations.listByRun(run.id)).toHaveLength(0);
    await restarted.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("recovers a mid-batch interruption without retrying or starting the trailing Tool", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-7c-crash-"));
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openCaelushStorage({ path: databasePath });
    const run = makeRun(path.join(directory, "project"));
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.events);
    let firstCalls = 0;
    const firstRuntime = createRuntime(firstStorage, firstBus, async () => {
      firstCalls += 1;
      return { content: "A", details: {}, isError: false };
    });
    const firstController = createController(firstStorage, firstBus, [
      turn(
        "inspect",
        [
          { id: "call-A", name: "echo_value", input: {} },
          { id: "call-B", name: "echo_value", input: {} },
          { id: "call-C", name: "echo_value", input: {} },
        ],
        "TOOL_CALLS",
      ),
    ]);
    const waiting = await firstController.start(run.id);
    expect(waiting.status).toBe("WAITING_TOOL_RESULTS");
    if (waiting.status !== "WAITING_TOOL_RESULTS") throw new Error("expected waiting boundary");
    const sourceStepId = waiting.sourceStepId;
    const firstA = await firstRuntime.dispatcher.dispatch({
      sessionId: run.sessionId,
      runId: run.id,
      stepId: sourceStepId,
      externalCallId: "call-A",
      toolName: "echo_value",
      args: {},
      environment: { workspace: run.workspace, runtime: run.runtime },
      securityContext: { permissionProfile: "READ_ONLY", approvalPolicy: "DANGEROUS_ONLY" },
    });
    expect(firstA.kind).toBe("RESULT");
    const running = startToolInvocation(
      createRequestedToolInvocation({
        id: createToolInvocationId(),
        runId: run.id,
        stepId: sourceStepId,
        externalCallId: "call-B",
        toolName: "echo_value",
        args: {},
        riskLevel: "LOW",
        createdAt: createTimestampMs(200),
      }),
      createTimestampMs(201),
    );
    const requested = await firstStorage.toolExecution.commit({
      sessionId: run.sessionId,
      invocation: running,
      expectedRevision: null,
      events: [],
    } satisfies ToolExecutionCommit);
    expect(requested.snapshot.invocation.status).toBe("RUNNING");
    await firstStorage.close();

    const restarted = await openCaelushStorage({ path: databasePath });
    const secondBus = new EventBus(restarted.events);
    const recoveredObserved: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const secondRuntime = createRuntime(
      restarted,
      secondBus,
      async () => {
        throw new Error("no recovered Tool may execute");
      },
      () => "ALLOW",
      300,
    );
    const controller = createController(
      restarted,
      secondBus,
      [turn("recovered final", [], "STOP")],
      secondRuntime.coordinator,
      recoveredObserved,
      400,
    );

    const result = await controller.recover(run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(firstCalls).toBe(1);
    expect(recoveredObserved[0]?.messages.slice(-3)).toEqual([
      expect.objectContaining({ toolCallId: "call-A", isError: false }),
      expect.objectContaining({ toolCallId: "call-B", isError: true }),
      expect.objectContaining({ toolCallId: "call-C", isError: true }),
    ]);
    expect(await restarted.toolInvocations.listByRun(run.id)).toHaveLength(2);
    expect(await restarted.observations.listByRun(run.id)).toHaveLength(2);
    expect((await restarted.toolInvocations.listByRun(run.id)).at(-1)?.error?.details).toEqual({
      executionDisposition: "UNCERTAIN_SIDE_EFFECT",
    });
    expect((await restarted.messages.listByRun(run.id)).map((entry) => entry.message.role)).toEqual(
      ["user", "assistant", "tool", "tool", "tool", "assistant"],
    );
    await restarted.close();
    await rm(directory, { recursive: true, force: true });
  });
});
