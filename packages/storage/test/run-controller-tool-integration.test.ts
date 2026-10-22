import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRunSchema,
  createApprovalRequestId,
  createEventId,
  createLLMCallId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type TimestampMs,
  type ToolInvocationId,
} from "@caelush/protocol";
import {
  RunController,
  RunDeadlineRegistry,
  RunRetryRegistry,
  createCodingCompletionAssembly,
  toContextObservationProjection,
  type AIModelTurnResult,
} from "@caelush/core";
import { EventBus } from "./support/test-event-notifier.js";

import {
  createModelToolFeedbackProjector,
  createRequestedToolInvocation,
  createToolAdmissionCoordinator,
  createToolResultBatchNormalizer,
  createToolResultPipeline,
  startToolInvocation,
  DefaultAgentToolRegistryBuilder,
  UNBOUNDED_TOOL_BUDGET_ADMISSION,
  type AgentTool,
  type AgentToolRegistry,
  type ToolAdmissionCoordinator,
  type ToolBatchCoordinator,
  type ToolExecutionCommit,
  type ToolExecutionGatePort,
  type EffectReconciliationPort,
} from "@caelush/agent";
import {
  createCodingToolAdmissionPort,
  createCodingToolCatalog,
  createCodingToolDurableMetadataPort,
  createCodingToolSettlementExtensionProjector,
  createDefaultCodingTools,
  createDurableInvocationGatePort,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  createRuntimeEffectReconciliationPort,
  type CodingToolCatalog,
  type CodingToolDefinition,
  type DefaultCodingToolOperations,
  type PatchOperations,
} from "@caelush/coding-agent";
import { describe, expect, it, vi } from "vitest";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import type { CaelushStorage } from "../src/index.js";
import { makeRun as makeStorageRun, verificationPlanner } from "./support/fixtures.js";
import { openToolStorage } from "./support/tool-settlement-decoder.js";
import { CaelushToolExecutionGate, createV1ToolApprovalRequestFactory } from "@caelush/security";
import { aiError, modelTurnResult } from "./support/model-turns.js";
import { createCanonicalToolRuntime } from "./support/canonical-tool-runtime.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { testRunMessageAuthority } from "../../core/test/support/run-message-authority.js";

async function projectedMessages(storage: CaelushStorage, runId: string) {
  const messages = testRunMessageAuthority({
    records: (runId) => storage.messageRecords.listByRun(runId),
  });
  const records = await storage.messageRecords.listByRun(runId as never);
  return records.flatMap(
    (record) =>
      messages.projectors.project({
        sequence: record.sequence,
        schemaVersion: record.schemaVersion,
        ...(record.modelProjectionVersion === undefined
          ? {}
          : { modelProjectionVersion: record.modelProjectionVersion }),
        message: messages.codecs.decode(record),
      }).messages,
  );
}

/**
 * The two fixture Tools, as canonical `AgentTool`s plus their Coding overlay.
 *
 * ```text
 * echo_value       LOW    a plain Tool, always admissible
 * approval_value   HIGH   the Tool the policy stops at approval
 * ```
 *
 * The executable half is a general `AgentTool` and carries no risk level; the risk level is Coding
 * overlay metadata and travels on the `CodingToolDefinition`, exactly as it does for a builtin.
 */
function fixtureDefinitions(execute: AgentTool["execute"]): readonly CodingToolDefinition[] {
  const echo: AgentTool = {
    name: "echo_value",
    description: "Echo a value.",
    inputSchema: { type: "object", additionalProperties: false },
    label: "Echo value",
    resultDetailsSchema: {
      type: "object",
      properties: { value: { type: "string" }, secret: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    executionMode: "SEQUENTIAL",
    // The echo call is a read: declaring that lets it stay independent of a sibling rejection.
    scheduling: { class: "READ_ONLY" },
    execute,
  };
  const approval: AgentTool = {
    name: "approval_value",
    description: "Requires approval.",
    inputSchema: { type: "object", additionalProperties: false },
    label: "Approval value",
    resultDetailsSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    executionMode: "SEQUENTIAL",
    execute,
  };
  return Object.freeze([
    {
      tool: echo,
      security: { riskLevel: "LOW", requiredCapabilities: [], runtimeRequirements: {} },
    },
    {
      tool: approval,
      security: { riskLevel: "HIGH", requiredCapabilities: [], runtimeRequirements: {} },
    },
  ]);
}

/** Every host here admits every call unless it says otherwise. */
const ALLOW_ALL: ToolExecutionGatePort = { decide: async () => ({ kind: "ALLOW" as const }) };

/** A fixture policy: one named Tool requires review, every other Tool is admitted. */
function approvalFor(toolName: string): ToolExecutionGatePort {
  return {
    decide: async ({ toolName: called }) => ({
      kind: called === toolName ? ("REQUIRE_APPROVAL" as const) : ("ALLOW" as const),
    }),
  };
}

/** The Tools the legacy read-only and file-mutation registrations used to produce, in Coding order. */
const FILESYSTEM_TOOL_NAMES = Object.freeze([
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "apply_patch",
] as const);

function makeRun(
  pathname: string,
  runtimeKind = "fixture",
  overrides: Partial<ReturnType<typeof AgentRunSchema.parse>> = {},
) {
  return makeStorageRun(createSessionId(), {
    goal: "inspect values",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: pathname },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: runtimeKind },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
    ...overrides,
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

/**
 * The Coding/Security admission over the real durable store.
 *
 * ```text
 * createCodingToolAdmissionPort        the Coding catalog's risk metadata + facts projector
 *        ↓ over
 * createDurableInvocationGatePort      the durable Invocation the Security gate validates against
 *        ↓ around
 * the host's gate                      the real CaelushToolExecutionGate, or a fixture policy
 * ```
 *
 * The durable-invocation wrapper is what the production composition root uses, and it is load-bearing
 * here: the Security gate requires the invocation it is handed to agree with the policy metadata on
 * Tool name and risk level, and the durable row — written from the Coding catalog — is the value that
 * agrees.
 */
function createCodingAdmission(input: {
  readonly storage: CaelushStorage;
  readonly registry: AgentToolRegistry;
  readonly catalog: CodingToolCatalog;
  readonly gate: ToolExecutionGatePort;
  readonly clock: { now(): TimestampMs };
}): ToolAdmissionCoordinator {
  return createToolAdmissionCoordinator({
    policy: createCodingToolAdmissionPort({
      gate: createDurableInvocationGatePort({
        gate: input.gate,
        invocations: {
          resolve: async ({ invocationId }) =>
            (await input.storage.toolExecution.load(invocationId as ToolInvocationId))?.invocation,
        },
      }),
      registry: input.registry,
      catalog: input.catalog,
      approvalPresentation: (decision) => decision.safeAction,
    }),
    approvals: input.storage.approvals,
    approvalRequests: createV1ToolApprovalRequestFactory({
      registry: input.registry,
      catalog: input.catalog,
      gate: input.gate,
      approvalIdFactory: { create: createApprovalRequestId },
    }),
    budget: UNBOUNDED_TOOL_BUDGET_ADMISSION,
    clock: input.clock,
    eventIdFactory: { create: createEventId },
  });
}

/** The three canonical authorities, as the Run Layer receives them. */
function canonicalToolTurn(runtime: {
  readonly batch: ToolBatchCoordinator;
  readonly registry: AgentToolRegistry;
}) {
  return {
    batches: runtime.batch,
    feedback: createModelToolFeedbackProjector({
      projection: toContextObservationProjection(),
    }),
    normalizer: createToolResultBatchNormalizer(),
    // The model-facing catalog comes from the registry that resolves execution: one registry, never
    // two, read in the registry's own `modelSpecs()` form rather than projected down to it.
    modelSpecs: () => runtime.registry.modelSpecs(),
  };
}

/** Compose one immutable registry, its Coding overlay and the canonical durable Tool pipeline. */
function createCanonicalRuntime(
  storage: CaelushStorage,
  eventBus: EventBus,
  definitions: readonly CodingToolDefinition[],
  gate: ToolExecutionGatePort,
  initialNow: number,
  effectReconciliation?: EffectReconciliationPort,
) {
  const builder = new DefaultAgentToolRegistryBuilder();
  for (const definition of definitions) builder.register(definition.tool);
  const registry = builder.build();
  const catalog = createCodingToolCatalog({ registry, definitions });
  let now = initialNow;
  const runtime = createCanonicalToolRuntime({
    storage,
    registry,
    notifier: eventBus,
    clock: { now: () => createTimestampMs(++now) },
    admission: createCodingAdmission({
      storage,
      registry,
      catalog,
      gate,
      clock: { now: () => createTimestampMs(++now) },
    }),
    // The durable row's risk level comes from the Coding catalog, which is the authority that owns it —
    // the same value the Security gate validates the invocation against.
    metadata: createCodingToolDurableMetadataPort({ registry, catalog }),
    // The Coding settlement extension, exactly as the daemon composition builds it: the effect
    // vocabulary belongs to the Coding layer, and the host-domain events an effect implies are drawn
    // from the same event identity factory as the terminal event they accompany.
    resultPipelineFactory: ({ invocation, environment, sessionId }) =>
      createToolResultPipeline({
        settlementExtension: createCodingToolSettlementExtensionProjector({
          catalog,
          invocation: {
            invocation,
            ...(sessionId === undefined ? {} : { sessionId }),
            environment,
            nextEventId: () => createEventId(),
          },
        }),
      }),
    ...(effectReconciliation === undefined ? {} : { effectReconciliation }),
  });
  return { runtime, registry, catalog };
}

function createRuntime(
  storage: CaelushStorage,
  eventBus: EventBus,
  execute: AgentTool["execute"],
  gate: ToolExecutionGatePort = ALLOW_ALL,
  initialNow = Date.now(),
  effectReconciliation?: EffectReconciliationPort,
) {
  const composed = createCanonicalRuntime(
    storage,
    eventBus,
    fixtureDefinitions(execute),
    gate,
    initialNow,
    effectReconciliation,
  );
  return {
    runtime: composed.runtime,
    dispatcher: composed.runtime.coordinator,
    batch: composed.runtime.batch,
    registry: composed.registry,
  };
}

function createFilesystemRuntime(
  storage: CaelushStorage,
  eventBus: EventBus,
  gate: ToolExecutionGatePort = ALLOW_ALL,
  initialNow = Date.now(),
  options: {
    readonly effectReconciliation?: EffectReconciliationPort;
    readonly afterPatchApply?: () => Promise<void>;
  } = {},
) {
  const runtimeResolver = createLocalRuntimeResolver(new LocalRuntime());
  const readOnly = createRuntimeReadOnlyOperations(runtimeResolver);
  const runtimePatch = createRuntimePatchOperations(runtimeResolver);
  const patch: PatchOperations =
    options.afterPatchApply === undefined
      ? runtimePatch
      : {
          async apply(input) {
            const result = await runtimePatch.apply(input);
            await options.afterPatchApply?.();
            return result;
          },
        };
  const operations: DefaultCodingToolOperations = {
    readFile: readOnly,
    readOnly,
    patch,
    exec: createRuntimeProcessOperations(runtimeResolver),
    process: createRuntimeProcessOperations(runtimeResolver),
    git: createRuntimeGitOperations(runtimeResolver),
  };
  // The legacy suite composed the read-only registrations plus the file-mutation one: the four read
  // Tools and `apply_patch`, in the Coding order. Selecting those by name from the one declaration of
  // the default set is what keeps this subset and the Coding catalog describing the same five Tools.
  const selected = new Set<string>(FILESYSTEM_TOOL_NAMES);
  const definitions = createDefaultCodingTools(operations).filter((definition) =>
    selected.has(definition.tool.name),
  );
  expect(definitions.map((definition) => definition.tool.name)).toEqual([...FILESYSTEM_TOOL_NAMES]);
  const composed = createCanonicalRuntime(
    storage,
    eventBus,
    definitions,
    gate,
    initialNow,
    options.effectReconciliation,
  );
  return {
    runtime: composed.runtime,
    dispatcher: composed.runtime.coordinator,
    batch: composed.runtime.batch,
    registry: composed.registry,
    catalog: composed.catalog,
  };
}

function createController(
  storage: CaelushStorage,
  eventBus: EventBus,
  turns: Array<AIModelTurnResult | Error>,
  runtime?: {
    readonly batch: ToolBatchCoordinator;
    readonly registry: AgentToolRegistry;
  },
  observedRequests: Array<{ tools?: unknown; messages: readonly unknown[] }> = [],
  initialNow = 10,
  deadlineRegistry?: RunDeadlineRegistry,
  fixedClock?: { value: number },
  retryRegistry?: RunRetryRegistry,
) {
  let now = initialNow;
  const clock = { now: () => createTimestampMs(fixedClock?.value ?? now++) };
  const messages = testRunMessageAuthority({
    records: (runId) => storage.messageRecords.listByRun(runId),
  });
  const agentExecution = testRunAgentExecution({
    executor: fakeFrozenModelTurnExecutor(async (request) => {
      observedRequests.push({ tools: request.tools, messages: request.messages });
      const next = turns.shift();
      if (next instanceof Error) throw next;
      return next!;
    }),
    // The model-visible catalog comes from the same registry that resolves execution, exactly as the
    // production composition root derives it from the active Tool registry.
    ...(runtime === undefined ? {} : { tools: runtime.registry.modelSpecs() }),
    createStepId: () => createStepId(),
  });
  const configResolver = {
    resolve: async () => ({
      baseSystemPrompt: "synthetic",
      contextLimits: { maxInputTokens: 1000 },
    }),
  };
  const completion = createCodingCompletionAssembly({
    clock,
    configResolver,
    planner: verificationPlanner,
    planIdFactory: createVerificationPlanId,
    checkIdFactory: createVerificationCheckId,
    evidenceIdFactory: createVerificationEvidenceId,
    executionStore: storage.verificationExecution,
    executionRecovery: storage.verificationExecution,
    reviewer: {
      review: async ({ bundle }) => ({
        status: "PASSED" as const,
        review: { verdict: "PASS" as const, summary: "The fixture candidate is acceptable." },
        reviewInputHash: bundle.reviewInputHash,
      }),
    },
    workspace: {
      inspect: async () => ({ inspectionComplete: true, paths: [] }),
    },
    git: {
      status: async () => ({ available: false }),
      diff: async ({ path: changedPath }) => ({ path: changedPath, diff: "", truncated: false }),
    },
    evidenceSanitizer: {
      redactText: (value) => value,
      boundText: (value, maxBytes) => ({
        text: value.slice(0, maxBytes),
        omittedBytes: Math.max(0, Buffer.byteLength(value, "utf8") - maxBytes),
        truncated: Buffer.byteLength(value, "utf8") > maxBytes,
      }),
    },
  });
  return new RunController({
    agentExecution: agentExecution.factory,
    executionStore: storage.execution,
    completionStore: storage.execution,
    events: eventBus,
    configResolver,
    messages,
    completion,
    progressPersistence: storage.execution,
    resourceGovernance: storage.resourceGovernance,
    ...(runtime === undefined ? {} : { toolTurn: canonicalToolTurn(runtime) }),
    clock,
    eventIdFactory: { create: createEventId },
    approvals: storage.approvals,
    ...(deadlineRegistry === undefined ? {} : { deadlineRegistry }),
    ...(retryRegistry === undefined ? {} : { retryRegistry }),
  });
}

function turn(
  text: string,
  toolCalls: AIModelTurnResult["toolCalls"],
  finishReason: AIModelTurnResult["finishReason"],
): AIModelTurnResult {
  return modelTurnResult({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls,
    finishReason,
  });
}

describe("RunController automatic Tool Batch integration", () => {
  it("executes seven legal calls and persists one parameter rejection in an eight-request turn", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo", "fixture", {
      limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 10_000 },
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const executed: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
      executed.push(externalCallId);
      return { content: externalCallId, details: {}, isError: false };
    });
    const allCalls = Array.from({ length: 8 }, (_, index) => ({
      id: `call-${index}`,
      name: "echo_value",
      input: {},
    }));
    const executableCalls = allCalls.filter((_, index) => index !== 3);
    let executableIndex = 0;
    const toolRequests: AIModelTurnResult["toolRequests"] = allCalls.map((call, sourceOrdinal) =>
      sourceOrdinal === 3
        ? {
            kind: "INVALID_ARGUMENTS",
            sourceOrdinal,
            id: call.id,
            name: call.name,
            issue: { code: "MALFORMED_JSON", argumentBytes: 11 },
          }
        : {
            kind: "EXECUTABLE",
            sourceOrdinal,
            call: executableCalls[executableIndex++]!,
          },
    );
    const firstTurn = turn(
      "seven valid calls and one rejected request",
      executableCalls,
      "TOOL_CALLS",
    );
    const observed: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [{ ...firstTurn, toolRequests }, turn("all eight requests have a result", [], "STOP")],
      runtime,
      observed,
    );

    try {
      const result = await controller.start(run.id);

      expect(result.run.status).toBe("COMPLETED");
      expect(executed).toEqual(executableCalls.map(({ id }) => id));
      expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(7);
      expect(
        (await storage.toolInvocations.listByRun(run.id)).map(
          ({ externalCallId }) => externalCallId,
        ),
      ).toEqual(executableCalls.map(({ id }) => id));
      expect(await storage.observations.listByRun(run.id)).toHaveLength(7);
      expect(observed).toHaveLength(2);
      expect(
        observed[1]?.messages.filter((message) => (message as { role?: string }).role === "tool"),
      ).toHaveLength(8);
      expect(
        observed[1]?.messages
          .filter((message) => (message as { role?: string }).role === "tool")
          .map((message) => (message as { toolCallId?: string }).toolCallId),
      ).toEqual(allCalls.map(({ id }) => id));
    } finally {
      await storage.close();
    }
  });

  it("retries the Provider after Tool Results without redispatching the Tool", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo", "fixture", {
      limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 10_000 },
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const toolCalls: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
      toolCalls.push(externalCallId);
      return { content: "tool-result", details: {}, isError: false };
    });
    const clock = { value: 10 };
    const scheduled: Array<{
      callback: () => void | Promise<void>;
      cancelled: boolean;
    }> = [];
    const retryRegistry = new RunRetryRegistry({
      clock: { now: () => createTimestampMs(clock.value) },
      timer: {
        schedule: (_delayMs, callback) => {
          const entry = { callback, cancelled: false };
          scheduled.push(entry);
          return { cancel: () => (entry.cancelled = true) };
        },
      },
    });
    const controller = createController(
      storage,
      eventBus,
      [
        turn("inspect", [{ id: "call-tool", name: "echo_value", input: {} }], "TOOL_CALLS"),
        aiError("AI_NETWORK", { message: "provider secret" }),
        turn("recovered", [], "STOP"),
      ],
      runtime,
      [],
      10,
      undefined,
      clock,
      retryRegistry,
    );

    const waiting = await controller.start(run.id);

    expect(waiting.status).toBe("WAITING_RETRY");
    expect(toolCalls).toEqual(["call-tool"]);
    if (waiting.status !== "WAITING_RETRY") throw new Error("expected retry boundary");
    expect((await storage.continuations.get(run.id))?.checkpoint).toMatchObject({
      type: "WAITING_RETRY",
      mode: "TOOL_RESULTS",
      attempt: 2,
    });
    clock.value = waiting.nextAttemptAt;
    const timer = scheduled.at(-1);
    if (timer === undefined) throw new Error("retry timer was not armed");
    await timer.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(toolCalls).toEqual(["call-tool"]);
    const retriedRun = await storage.runs.get(run.id);
    expect(retriedRun?.status).toBe("COMPLETED");
    expect(await storage.steps.listByRun(run.id)).toHaveLength(3);
    expect((await projectedMessages(storage, run.id)).map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    await storage.close();
  });

  it("runs real read-only filesystem tools through the Run Layer and leaves the workspace unchanged", async () => {
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

    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun(workspace, "local");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
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
              input: { pattern: "AgentLoop", include: "src/*.ts" },
            },
          ],
          "TOOL_CALLS",
        ),
        turn("Final Candidate", [], "STOP"),
      ],
      runtime,
      observed,
    );

    try {
      const result = await controller.start(run.id);

      expect(result.status).toBe("TERMINAL");
      expect(result.run.status).toBe("COMPLETED");
      expect(observed[0]?.tools).toEqual(runtime.registry.modelSpecs());
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

    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun(workspace, "local", { permissionProfile: "PROJECT_ACCESS" });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
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
      runtime,
      observed,
      // A patch is the one Tool in this suite whose effect projection moves the durable
      // `AgentState`, and the Tool Layer stamps that projection from the Tool dispatcher clock. The
      // Run Layer now settles against that durable state, so the two clocks have to share one epoch
      // — in the production composition they are literally the same clock object. Starting the Run
      // Layer a minute ahead of the Tool Layer's wall clock keeps every Run Layer timestamp later
      // than every Tool timestamp no matter how often either clock is read.
      Date.now() + 60_000,
    );

    try {
      const result = await controller.start(run.id);

      expect(result.status).toBe("TERMINAL");
      expect(result.run.status).toBe("COMPLETED");
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

  it("derives the workspace-write preset from AgentRun and admits a workspace patch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-9a-approval-e2e-"));
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "unchanged\n", "utf8");
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun(workspace, "local", {
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
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
        turn("Patch applied successfully.", [], "STOP"),
      ],
      runtime,
      [],
      Date.now() + 60_000,
    );

    try {
      const result = await controller.start(run.id);
      expect(result.status).toBe("TERMINAL");
      expect(result.run.status).toBe("COMPLETED");
      expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("changed\n");
      expect(await storage.toolInvocations.listByRun(run.id)).toMatchObject([
        { status: "COMPLETED", toolName: "apply_patch" },
      ]);
      expect((await storage.runs.get(run.id))?.status).toBe("COMPLETED");
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes one complete batch, resumes the AgentLoop, and preserves source order", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
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
      runtime,
      observed,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    expect(order).toEqual(["start:call-A", "finish:call-A", "start:call-B", "finish:call-B"]);
    expect(maxActive).toBe(1);
    expect(observed).toHaveLength(2);
    expect(observed[0]?.tools).toEqual(runtime.registry.modelSpecs());
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
    expect((await projectedMessages(storage, run.id)).map((entry) => entry.role)).toEqual([
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
    expect(JSON.stringify(await projectedMessages(storage, run.id))).not.toContain(
      "details-secret",
    );
    expect(
      (
        await storage.eventReader.replay(run.id, {
          afterSequence: 0,
          throughSequence: Number.MAX_SAFE_INTEGER,
          limit: 1000,
        })
      ).map((event) => event.type),
    ).toContain("run.completed");
    await storage.close();
  });

  it("pauses the Run at approval and does not create trailing calls", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const calls: string[] = [];
    const runtime = createRuntime(
      storage,
      eventBus,
      async ({ identity: { externalCallId } }) => {
        calls.push(externalCallId);
        return { content: externalCallId, details: {}, isError: false };
      },
      approvalFor("approval_value"),
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
      runtime,
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
    expect((await projectedMessages(storage, run.id)).map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect((await controller.recover(run.id)).status).toBe("WAITING_APPROVAL");
    expect(calls).toEqual(["call-A"]);
    await storage.close();
  });

  it("times out an idle approval boundary without a follow-up API call", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const clock = { value: 10 };
    const scheduled: Array<{
      callback: () => void | Promise<void>;
      cancelled: boolean;
    }> = [];
    const deadlineRegistry = new RunDeadlineRegistry({
      clock: { now: () => createTimestampMs(clock.value) },
      timer: {
        schedule: (_delay, callback) => {
          const task = { callback, cancelled: false };
          scheduled.push(task);
          return { cancel: () => (task.cancelled = true) };
        },
      },
    });
    const run = makeRun("/repo", "fixture", {
      limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 100 },
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const calls: string[] = [];
    const runtime = createRuntime(
      storage,
      eventBus,
      async ({ identity: { externalCallId } }) => {
        calls.push(externalCallId);
        return { content: externalCallId, details: {}, isError: false };
      },
      approvalFor("approval_value"),
    );
    const controller = createController(
      storage,
      eventBus,
      [turn("inspect", [{ id: "call-approval", name: "approval_value", input: {} }], "TOOL_CALLS")],
      runtime,
      [],
      10,
      deadlineRegistry,
      clock,
    );

    try {
      const waiting = await controller.start(run.id);
      expect(waiting.status).toBe("WAITING_APPROVAL");
      if (waiting.status !== "WAITING_APPROVAL") {
        throw new Error("expected approval boundary");
      }
      expect(scheduled.filter((task) => !task.cancelled)).toHaveLength(1);
      clock.value = 110;
      await scheduled.find((task) => !task.cancelled)!.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect((await storage.runs.get(run.id))?.status).toBe("TIMEOUT");
      expect((await storage.approvals.getById(waiting.approvalId!))?.status).toBe("CANCELLED");
      expect(calls).toEqual([]);
      expect(
        (
          await storage.eventReader.replay(run.id, {
            afterSequence: 0,
            throughSequence: Number.MAX_SAFE_INTEGER,
            limit: 1000,
          })
        ).filter((event) => event.type === "run.timed_out"),
      ).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it("resolves a durable approval and resumes the exact Tool boundary plus trailing calls", async () => {
    const baseNow = Date.now();
    const storage = await openToolStorage({
      path: ":memory:",
      approvalClock: { now: () => createTimestampMs(baseNow + 500) },
    });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const calls: string[] = [];
    const runtime = createRuntime(
      storage,
      eventBus,
      async ({ identity: { externalCallId } }) => {
        calls.push(externalCallId);
        return { content: externalCallId, details: {}, isError: false };
      },
      approvalFor("approval_value"),
      baseNow,
    );
    const observed: Array<{ tools?: unknown; messages: unknown[] }> = [];
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
        turn("final after approval", [], "STOP"),
      ],
      runtime,
      observed,
      baseNow + 1_000,
    );

    const waiting = await controller.start(run.id);
    expect(waiting.status).toBe("WAITING_APPROVAL");
    if (waiting.status !== "WAITING_APPROVAL") throw new Error("expected approval boundary");
    expect(waiting.approvalId).toBeDefined();
    const checkpoint = await storage.continuations.get(run.id);
    if (checkpoint?.checkpoint.type !== "WAITING_TOOL_RESULTS")
      throw new Error("expected checkpoint");
    expect(checkpoint.checkpoint.waitingApproval?.approvalId).toBe(waiting.approvalId);
    expect(calls).toEqual(["call-A"]);
    const resolved = await controller.resolveApproval(run.id, waiting.approvalId!, {
      action: "APPROVE",
      scope: "ONCE",
    });
    expect(resolved.status).toBe("TERMINAL");
    expect(resolved.run.status).toBe("COMPLETED");
    expect(calls).toEqual(["call-A", "call-B", "call-C"]);
    expect(observed).toHaveLength(2);
    expect(observed[1]?.messages.slice(-3)).toEqual([
      expect.objectContaining({ toolCallId: "call-A" }),
      expect.objectContaining({ toolCallId: "call-B" }),
      expect.objectContaining({ toolCallId: "call-C" }),
    ]);
    expect((await storage.toolInvocations.listByRun(run.id)).map(({ status }) => status)).toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(
      (
        await storage.eventReader.replay(run.id, {
          afterSequence: 0,
          throughSequence: Number.MAX_SAFE_INTEGER,
          limit: 1000,
        })
      ).map(({ type }) => type),
    ).toContain("approval.resolved");
    await storage.close();
  });

  it("preserves a 16-call completed prefix while a later segment waits for approval", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo", "fixture", {
      limits: { maxSteps: 12, maxToolCalls: 64, timeoutMs: 60_000 },
      resourcePolicy: {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 32, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 4,
          identicalCallNudgeThreshold: 2,
          noProgressTurnsBeforeReplan: 3,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      },
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const executed: string[] = [];
    const runtime = createRuntime(
      storage,
      eventBus,
      async ({ identity: { externalCallId } }) => {
        executed.push(externalCallId);
        return { content: externalCallId, details: {}, isError: false };
      },
      approvalFor("approval_value"),
    );
    const calls = [
      ...Array.from({ length: 16 }, (_, index) => ({
        id: `call-${String(index).padStart(2, "0")}`,
        name: "echo_value",
        input: {},
      })),
      { id: "call-16", name: "approval_value", input: {} },
      { id: "call-17", name: "echo_value", input: {} },
    ];
    const requests: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [turn("inspect values", calls, "TOOL_CALLS"), turn("all values inspected", [], "STOP")],
      runtime,
      requests,
    );

    const waiting = await controller.start(run.id);
    expect(waiting.status).toBe("WAITING_APPROVAL");
    if (waiting.status !== "WAITING_APPROVAL") throw new Error("expected approval boundary");
    expect(executed).toEqual(calls.slice(0, 16).map((call) => call.id));
    expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(17);
    expect(
      (await storage.toolInvocations.listByRun(run.id))
        .slice(0, 16)
        .every((invocation) => invocation.status === "COMPLETED"),
    ).toBe(true);

    const result = await controller.resolveApproval(run.id, waiting.approvalId!, {
      action: "APPROVE",
      scope: "ONCE",
    });

    expect(result.run.status).toBe("COMPLETED");
    expect(executed).toEqual(calls.map((call) => call.id));
    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages.filter((message) => (message as { role?: string }).role === "tool"),
    ).toHaveLength(18);
    expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(18);
    expect(
      (await storage.toolInvocations.listByRun(run.id)).map((invocation) => invocation.status),
    ).toEqual(Array.from({ length: 18 }, () => "COMPLETED"));
    await storage.close();
  });

  it("recovers a partially completed second segment across SQLite restart before approval", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "caelush-tool-segment-approval-restart-"),
    );
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openToolStorage({ path: databasePath });
    const run = makeRun(path.join(directory, "project"), "fixture", {
      limits: { maxSteps: 12, maxToolCalls: 64, timeoutMs: 60_000 },
      resourcePolicy: {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 32, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 4,
          identicalCallNudgeThreshold: 2,
          noProgressTurnsBeforeReplan: 3,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      },
    });
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.eventReader);
    const executions = new Map<string, number>();
    const execute = async ({
      identity: { externalCallId },
    }: Parameters<AgentTool["execute"]>[0]) => {
      executions.set(externalCallId, (executions.get(externalCallId) ?? 0) + 1);
      return { content: externalCallId, details: {}, isError: false };
    };
    const firstRuntime = createRuntime(
      firstStorage,
      firstBus,
      execute,
      approvalFor("approval_value"),
    );
    const calls = [
      ...Array.from({ length: 17 }, (_, index) => ({
        id: `call-${String(index).padStart(2, "0")}`,
        name: "echo_value",
        input: {},
      })),
      { id: "call-17", name: "approval_value", input: {} },
    ];
    const firstRequests: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
    const firstController = createController(
      firstStorage,
      firstBus,
      [turn("inspect and then approve", calls, "TOOL_CALLS")],
      firstRuntime,
      firstRequests,
    );

    try {
      const waiting = await firstController.start(run.id);
      expect(waiting.status).toBe("WAITING_APPROVAL");
      if (waiting.status !== "WAITING_APPROVAL") throw new Error("expected approval boundary");
      expect(firstRequests).toHaveLength(1);
      expect([...executions.keys()]).toEqual(calls.slice(0, 17).map(({ id }) => id));
      expect(await firstStorage.toolInvocations.listByRun(run.id)).toHaveLength(18);
      expect(
        (await firstStorage.toolInvocations.listByRun(run.id))
          .slice(0, 17)
          .every((invocation) => invocation.status === "COMPLETED"),
      ).toBe(true);

      // The second 16+2 segment has committed one result and an approval boundary. Closing and
      // reopening SQLite models a process loss at that durable boundary, not an in-memory resume.
      await firstStorage.close();

      const restarted = await openToolStorage({ path: databasePath });
      const restartedBus = new EventBus(restarted.eventReader);
      const restartedRuntime = createRuntime(
        restarted,
        restartedBus,
        execute,
        approvalFor("approval_value"),
      );
      const resumedRequests: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
      const recoveredController = createController(
        restarted,
        restartedBus,
        [turn("the approved operation completed", [], "STOP")],
        restartedRuntime,
        resumedRequests,
        100,
      );

      try {
        const recovered = await recoveredController.recover(run.id);
        expect(recovered.status).toBe("WAITING_APPROVAL");
        if (recovered.status !== "WAITING_APPROVAL") {
          throw new Error("expected the durable approval boundary after restart");
        }

        const result = await recoveredController.resolveApproval(run.id, recovered.approvalId!, {
          action: "APPROVE",
          scope: "ONCE",
        });

        expect(result.run.status).toBe("COMPLETED");
        expect([...executions.entries()]).toEqual(calls.map(({ id }) => [id, 1]));
        expect(resumedRequests).toHaveLength(1);
        expect(
          resumedRequests[0]?.messages.filter(
            (message) => (message as { role?: string }).role === "tool",
          ),
        ).toHaveLength(18);
        expect(
          (await restarted.toolInvocations.listByRun(run.id)).map(({ status }) => status),
        ).toEqual(Array.from({ length: 18 }, () => "COMPLETED"));
        expect(await restarted.observations.listByRun(run.id)).toHaveLength(18);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("carries a failed-call dependency barrier across real 16+2 Run segments", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo", "fixture", {
      limits: { maxSteps: 12, maxToolCalls: 64, timeoutMs: 60_000 },
      resourcePolicy: {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 32, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 4,
          identicalCallNudgeThreshold: 2,
          noProgressTurnsBeforeReplan: 3,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      },
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const executed: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
      executed.push(externalCallId);
      return { content: externalCallId, details: {}, isError: false };
    });
    const segments: Array<{ readonly offset: number | undefined; readonly size: number }> = [];
    const trackingBatch: ToolBatchCoordinator = {
      execute: async (request) => {
        segments.push({
          offset: request.segment?.sourceOrdinalOffset,
          size: request.calls.length,
        });
        return await runtime.batch.execute(request);
      },
    };
    const calls = [
      { id: "call-unknown", name: "missing_tool", input: {} },
      ...Array.from({ length: 16 }, (_, index) => ({
        id: `read-${String(index).padStart(2, "0")}`,
        name: "echo_value",
        input: {},
      })),
      { id: "mutate-after-error", name: "approval_value", input: {} },
    ];
    const requests: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [
        turn("read independent values and then continue", calls, "TOOL_CALLS"),
        turn("done", [], "STOP"),
      ],
      { ...runtime, batch: trackingBatch },
      requests,
    );

    try {
      const result = await controller.start(run.id);
      expect(result.run.status).toBe("COMPLETED");
      expect(segments).toEqual([
        { offset: 0, size: 16 },
        { offset: 16, size: 2 },
      ]);
      expect(executed).toEqual(
        Array.from({ length: 16 }, (_, index) => `read-${String(index).padStart(2, "0")}`),
      );
      const toolResults = requests[1]?.messages.filter(
        (message) => (message as { role?: string }).role === "tool",
      ) as Array<{ toolCallId: string; isError: boolean; content: string }> | undefined;
      expect(toolResults?.map(({ toolCallId }) => toolCallId)).toEqual(calls.map(({ id }) => id));
      expect(toolResults?.at(-1)).toMatchObject({
        toolCallId: "mutate-after-error",
        isError: true,
      });
      expect(toolResults?.at(-1)?.content).toContain("Nothing was executed");
      const invocations = await storage.toolInvocations.listByRun(run.id);
      expect(invocations).toHaveLength(16);
      expect(
        invocations.some(({ externalCallId }) => externalCallId === "mutate-after-error"),
      ).toBe(false);
      expect(await storage.observations.listByRun(run.id)).toHaveLength(16);
    } finally {
      await storage.close();
    }
  });

  it("cancels at the boundary after a durable 16-call prefix and never starts the next segment", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo", "fixture", {
      limits: { maxSteps: 12, maxToolCalls: 64, timeoutMs: 60_000 },
      resourcePolicy: {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 32, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 4,
          identicalCallNudgeThreshold: 2,
          noProgressTurnsBeforeReplan: 3,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      },
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const executed: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
      executed.push(externalCallId);
      return { content: externalCallId, details: {}, isError: false };
    });
    const calls = Array.from({ length: 18 }, (_, index) => ({
      id: `call-${String(index).padStart(2, "0")}`,
      name: "echo_value",
      input: {},
    }));
    const controllerHolder: { current?: ReturnType<typeof createController> } = {};
    let cancelTask: Promise<unknown> | undefined;
    const cancelAfterFirstSegment: ToolBatchCoordinator = {
      execute: async (request) => {
        const outcome = await runtime.batch.execute(request);
        if (request.segment?.sourceOrdinalOffset === 0) {
          const controller = controllerHolder.current;
          if (controller === undefined) throw new Error("Run controller was not initialized.");
          cancelTask = controller.cancel(run.id);
          if (!request.signal.aborted) {
            await new Promise<void>((resolve) => {
              request.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        }
        return outcome;
      },
    };
    controllerHolder.current = createController(
      storage,
      eventBus,
      [turn("read these independent values", calls, "TOOL_CALLS")],
      { ...runtime, batch: cancelAfterFirstSegment },
    );

    try {
      const controller = controllerHolder.current;
      if (controller === undefined) throw new Error("Run controller was not initialized.");
      const started = controller.start(run.id);
      const result = await started;
      await cancelTask;

      expect(result.run.status).toBe("CANCELLED");
      expect(executed).toEqual(calls.slice(0, 16).map((call) => call.id));
      expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(16);
      expect(
        (await storage.toolInvocations.listByRun(run.id)).every(
          (invocation) => invocation.status === "COMPLETED",
        ),
      ).toBe(true);
      expect(await storage.observations.listByRun(run.id)).toHaveLength(16);
    } finally {
      await storage.close();
    }
  });

  it("recovers a committed Tool terminal result when its caller disappears before Run settlement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-tool-terminal-crash-"));
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openToolStorage({ path: databasePath });
    const run = makeRun(path.join(directory, "project"), "fixture", {
      limits: { maxSteps: 12, maxToolCalls: 64, timeoutMs: 60_000 },
      resourcePolicy: {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 32, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 4,
          identicalCallNudgeThreshold: 2,
          noProgressTurnsBeforeReplan: 3,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      },
    });
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.eventReader);
    const executed = new Map<string, number>();
    const originalToolExecution = firstStorage.toolExecution;
    let injectedCrash = false;
    let databaseClosed = false;
    const crashAfterTerminalCommit = {
      load: originalToolExecution.load.bind(originalToolExecution),
      findByExternalCall: originalToolExecution.findByExternalCall.bind(originalToolExecution),
      async commit(command: ToolExecutionCommit) {
        const committed = await originalToolExecution.commit(command);
        if (
          !injectedCrash &&
          command.invocation.status === "COMPLETED" &&
          command.invocation.externalCallId === "call-00"
        ) {
          injectedCrash = true;
          await firstStorage.close();
          databaseClosed = true;
          // Model a lost process/response after SQLite committed the terminal observation. The Run
          // layer never receives this result and therefore cannot settle its Tool-result boundary.
          throw new Error("simulated process loss after terminal Tool commit");
        }
        return committed;
      },
    } satisfies CaelushStorage["toolExecution"];
    const crashStorage = new Proxy(firstStorage, {
      get(target, property, receiver) {
        return property === "toolExecution"
          ? crashAfterTerminalCommit
          : Reflect.get(target, property, receiver);
      },
    });
    const firstRuntime = createRuntime(
      crashStorage,
      firstBus,
      async ({ identity: { externalCallId } }) => {
        executed.set(externalCallId, (executed.get(externalCallId) ?? 0) + 1);
        return { content: externalCallId, details: {}, isError: false };
      },
    );
    const calls = Array.from({ length: 18 }, (_, index) => ({
      id: `call-${String(index).padStart(2, "0")}`,
      name: "echo_value",
      input: {},
    }));
    const firstController = createController(
      firstStorage,
      firstBus,
      [turn("inspect these independent values", calls, "TOOL_CALLS")],
      firstRuntime,
    );

    try {
      await firstController.start(run.id).catch(() => undefined);
      expect(injectedCrash).toBe(true);
      expect(databaseClosed).toBe(true);
      expect(executed).toEqual(new Map([["call-00", 1]]));

      const restarted = await openToolStorage({ path: databasePath });
      const secondBus = new EventBus(restarted.eventReader);
      const secondRuntime = createRuntime(
        restarted,
        secondBus,
        async ({ identity: { externalCallId } }) => {
          throw new Error(`recovery must not execute ${externalCallId} again`);
        },
      );
      const observed: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
      const recoveredController = createController(
        restarted,
        secondBus,
        [turn("all Tool results recovered", [], "STOP")],
        secondRuntime,
        observed,
      );

      try {
        const recovered = await recoveredController.recover(run.id);
        expect(recovered.run.status).toBe("COMPLETED");
        expect(observed).toHaveLength(1);
        expect(
          observed[0]?.messages.filter((message) => (message as { role?: string }).role === "tool"),
        ).toHaveLength(18);
        expect(await restarted.toolInvocations.listByRun(run.id)).toHaveLength(18);
        expect(
          (await restarted.toolInvocations.listByRun(run.id)).map((item) => item.externalCallId),
        ).toEqual(calls.map((call) => call.id));
        expect(await restarted.observations.listByRun(run.id)).toHaveLength(18);
        expect([...executed.entries()]).toEqual([["call-00", 1]]);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!databaseClosed) await firstStorage.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("honors an explicit whole-Run Tool budget before opening any chunk", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo", "fixture", {
      limits: { maxSteps: 12, maxToolCalls: 17, timeoutMs: 60_000 },
      resourcePolicy: {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 32, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 4,
          identicalCallNudgeThreshold: 2,
          noProgressTurnsBeforeReplan: 3,
          replansBeforePause: 2,
        },
        hardLimits: { maxToolCalls: 17 },
        inactivity: {},
      },
    });
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const executed: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
      executed.push(externalCallId);
      return { content: externalCallId, details: {}, isError: false };
    });
    const calls = Array.from({ length: 18 }, (_, index) => ({
      id: `call-${String(index).padStart(2, "0")}`,
      name: "echo_value",
      input: {},
    }));
    const observed: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
    const controller = createController(
      storage,
      eventBus,
      [turn("budget is below this request", calls, "TOOL_CALLS")],
      runtime,
      observed,
    );

    try {
      const result = await controller.start(run.id);

      expect(result.run.status).toBe("BUDGET_EXCEEDED");
      expect(executed).toEqual([]);
      expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(0);
      expect(await storage.observations.listByRun(run.id)).toHaveLength(0);
      expect(observed).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it("drives multiple provider Tool turns without recursive controller calls", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const calls: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
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
      runtime,
      providerRequests,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    expect(calls).toEqual(["call-A", "call-B"]);
    expect(providerRequests).toHaveLength(3);
    expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(2);
    expect((await projectedMessages(storage, run.id)).map((entry) => entry.role)).toEqual([
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
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const calls: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
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
      runtime,
      requests,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
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

  it("returns a complete safe Tool-result batch after a Tool infrastructure failure", async () => {
    const storage = await openToolStorage({ path: ":memory:" });
    const run = makeRun("/repo");
    await seedRun(storage, run);
    const eventBus = new EventBus(storage.eventReader);
    const calls: string[] = [];
    const runtime = createRuntime(storage, eventBus, async ({ identity: { externalCallId } }) => {
      calls.push(externalCallId);
      if (externalCallId === "call-B") throw new Error("handler-secret");
      return { content: "A", details: {}, isError: false };
    });
    const observed: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
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
      runtime,
      observed,
    );

    const result = await controller.start(run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    expect(calls).toEqual(["call-A", "call-B"]);
    expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(2);
    expect(await storage.observations.listByRun(run.id)).toHaveLength(2);
    expect((await storage.runs.get(run.id))?.status).toBe("COMPLETED");
    expect(await storage.continuations.get(run.id)).toBeNull();
    expect((await projectedMessages(storage, run.id)).map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(observed).toHaveLength(2);
    expect(observed[1]?.messages.slice(-2)).toEqual([
      expect.objectContaining({ toolCallId: "call-A", isError: false }),
      expect.objectContaining({ toolCallId: "call-B", isError: true }),
    ]);
    expect(
      JSON.stringify(
        await storage.eventReader.replay(run.id, {
          afterSequence: 0,
          throughSequence: Number.MAX_SAFE_INTEGER,
          limit: 1000,
        }),
      ),
    ).not.toContain("handler-secret");
    await storage.close();
  });

  it("resumes directly from durably accepted Tool Results after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-7c-accepted-"));
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openToolStorage({ path: databasePath });
    const run = makeRun(path.join(directory, "project"));
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.eventReader);
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

    const restarted = await openToolStorage({ path: databasePath });
    const secondBus = new EventBus(restarted.eventReader);
    const secondRuntime = createRuntime(
      restarted,
      secondBus,
      async () => {
        throw new Error("accepted Tool Results must not redispatch");
      },
      ALLOW_ALL,
      200,
    );
    const observed: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const controller = createController(
      restarted,
      secondBus,
      [turn("accepted final", [], "STOP")],
      secondRuntime,
      observed,
      200,
    );

    const result = await controller.recover(run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
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

  it("parks a mid-batch unknown effect without retrying or starting the trailing Tool", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-7c-crash-"));
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openToolStorage({ path: databasePath });
    const run = makeRun(path.join(directory, "project"));
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.eventReader);
    let firstCalls = 0;
    const firstRuntime = createRuntime(
      firstStorage,
      firstBus,
      async () => {
        firstCalls += 1;
        return { content: "A", details: {}, isError: false };
      },
      ALLOW_ALL,
      100,
    );
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
    // The first call is executed durably and settles normally: recovery must reuse its terminal row.
    const firstA = await firstRuntime.runtime.coordinator.execute({
      runId: run.id,
      sessionId: run.sessionId,
      sourceStepId,
      call: firstRuntime.runtime.prepare({
        externalCallId: "call-A",
        toolName: "echo_value",
        args: {},
      }),
      environment: { workspace: run.workspace, runtime: run.runtime },
      securityContext: { permissionProfile: "READ_ONLY", approvalPolicy: "DANGEROUS_ONLY" },
      signal: new AbortController().signal,
    });
    expect(firstA.kind).toBe("SETTLED");
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

    const restarted = await openToolStorage({ path: databasePath });
    const secondBus = new EventBus(restarted.eventReader);
    const recoveredObserved: Array<{ tools?: unknown; messages: unknown[] }> = [];
    const secondRuntime = createRuntime(
      restarted,
      secondBus,
      async () => {
        throw new Error("no recovered Tool may execute");
      },
      ALLOW_ALL,
      300,
    );
    const controller = createController(
      restarted,
      secondBus,
      [turn("recovered final", [], "STOP")],
      secondRuntime,
      recoveredObserved,
      400,
    );

    const result = await controller.recover(run.id);

    expect(result.status).toBe("WAITING_RESOURCE");
    expect(result).toMatchObject({
      reason: "EFFECT_UNCONFIRMED",
      toolName: "echo_value",
      reasonCode: "UNAVAILABLE",
    });
    expect(firstCalls).toBe(1);
    expect(recoveredObserved).toHaveLength(0);
    expect(await restarted.toolInvocations.listByRun(run.id)).toHaveLength(2);
    expect(await restarted.observations.listByRun(run.id)).toHaveLength(1);
    expect((await restarted.toolInvocations.listByRun(run.id)).map((item) => item.status)).toEqual([
      "COMPLETED",
      "RUNNING",
    ]);
    expect(
      (await restarted.toolInvocations.listByRun(run.id)).map((item) => item.externalCallId),
    ).toEqual(["call-A", "call-B"]);
    expect((await restarted.toolInvocations.listByRun(run.id)).at(-1)).toMatchObject({
      status: "RUNNING",
      externalCallId: "call-B",
    });
    expect((await projectedMessages(restarted, run.id)).map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
    await restarted.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("parks an unknown effect across SQLite restart and rechecks only after an explicit continue", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-effect-reconciliation-"));
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openToolStorage({ path: databasePath });
    const run = makeRun(path.join(directory, "project"));
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.eventReader);
    let firstExecutorCalls = 0;
    let notifyEffectStarted!: () => void;
    const effectStarted = new Promise<void>((resolve) => {
      notifyEffectStarted = resolve;
    });
    const firstRuntime = createRuntime(firstStorage, firstBus, (): Promise<never> => {
      firstExecutorCalls += 1;
      notifyEffectStarted();
      // Simulate a process loss after the external operation may have happened but before its
      // terminal observation can be committed.
      return new Promise<never>(() => undefined);
    });
    const firstController = createController(
      firstStorage,
      firstBus,
      [
        turn(
          "inspect after mutation",
          [{ id: "call-uncertain", name: "echo_value", input: {} }],
          "TOOL_CALLS",
        ),
      ],
      firstRuntime,
    );
    void firstController.start(run.id).catch(() => undefined);
    await effectStarted;

    const inFlight = await firstStorage.toolInvocations.listByRun(run.id);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]?.status).toBe("RUNNING");
    expect((await firstStorage.continuations.get(run.id))?.checkpoint.type).toBe(
      "WAITING_TOOL_RESULTS",
    );
    await firstStorage.close();

    const restarted = await openToolStorage({ path: databasePath });
    const secondBus = new EventBus(restarted.eventReader);
    const reconciliation = vi.fn(async () => ({ kind: "INCONCLUSIVE" as const }));
    const secondRuntime = createRuntime(
      restarted,
      secondBus,
      async () => {
        throw new Error("a recovered side effect must never be executed again");
      },
      ALLOW_ALL,
      300,
      { reconcile: reconciliation },
    );
    const observed: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
    const controller = createController(
      restarted,
      secondBus,
      [turn("continue after reconciliation", [], "STOP")],
      secondRuntime,
      observed,
      400,
    );

    try {
      const recovered = await controller.recover(run.id);
      expect(recovered.status).toBe("WAITING_RESOURCE");
      expect(recovered).toMatchObject({
        reason: "EFFECT_UNCONFIRMED",
        invocationId: inFlight[0]?.id,
        toolName: "echo_value",
        reasonCode: "INCONCLUSIVE",
      });
      expect(reconciliation).toHaveBeenCalledTimes(1);
      expect(firstExecutorCalls).toBe(1);
      expect(observed).toHaveLength(0);
      expect((await restarted.toolInvocations.listByRun(run.id))[0]?.status).toBe("RUNNING");
      expect(await restarted.observations.listByRun(run.id)).toHaveLength(0);

      const rechecked = await controller.continueResourceGuard(run.id);
      expect(rechecked.status).toBe("WAITING_RESOURCE");
      expect(reconciliation).toHaveBeenCalledTimes(2);
      expect(firstExecutorCalls).toBe(1);
      expect(observed).toHaveLength(0);
      expect((await restarted.toolInvocations.listByRun(run.id))[0]?.status).toBe("RUNNING");
      expect(await restarted.observations.listByRun(run.id)).toHaveLength(0);
    } finally {
      await restarted.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles a patch as unconfirmed after SQLite restart when a read-only check finds its postcondition", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "caelush-effect-matched-reconciliation-"),
    );
    const workspace = path.join(directory, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const target = path.join(workspace, "src", "value.ts");
    await writeFile(target, "export const value = 1;\n", "utf8");
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openToolStorage({ path: databasePath });
    const run = makeRun(workspace, "local", { permissionProfile: "PROJECT_ACCESS" });
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.eventReader);
    let notifyPatchApplied!: () => void;
    const patchApplied = new Promise<void>((resolve) => {
      notifyPatchApplied = resolve;
    });
    let firstPatchHandlerCalls = 0;
    const firstRuntime = createFilesystemRuntime(firstStorage, firstBus, ALLOW_ALL, Date.now(), {
      afterPatchApply: async () => {
        firstPatchHandlerCalls += 1;
        notifyPatchApplied();
        // Simulate losing the process after the filesystem transaction but before the handler reply.
        await new Promise<never>(() => undefined);
      },
    });
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/value.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** End Patch",
    ].join("\n");
    const firstController = createController(
      firstStorage,
      firstBus,
      [
        turn(
          "update the value",
          [{ id: "call-uncertain-patch", name: "apply_patch", input: { patch: patchText } }],
          "TOOL_CALLS",
        ),
      ],
      firstRuntime,
    );
    void firstController.start(run.id).catch(() => undefined);
    await patchApplied;

    expect(firstPatchHandlerCalls).toBe(1);
    expect(await readFile(target, "utf8")).toBe("export const value = 2;\n");
    expect((await firstStorage.toolInvocations.listByRun(run.id))[0]?.status).toBe("RUNNING");
    await firstStorage.close();

    const restarted = await openToolStorage({ path: databasePath });
    const secondBus = new EventBus(restarted.eventReader);
    const runtimeResolver = createLocalRuntimeResolver(new LocalRuntime());
    const runtimeReconciliation = createRuntimeEffectReconciliationPort(runtimeResolver);
    const reconciliation = vi.fn(runtimeReconciliation.reconcile);
    let replayedPatchHandlerCalls = 0;
    const secondRuntime = createFilesystemRuntime(restarted, secondBus, ALLOW_ALL, Date.now(), {
      effectReconciliation: { reconcile: reconciliation },
      afterPatchApply: async () => {
        replayedPatchHandlerCalls += 1;
        throw new Error("recovery must only read the target and never apply the patch again");
      },
    });
    const observed: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
    const controller = createController(
      restarted,
      secondBus,
      [turn("continue from the checked workspace state", [], "STOP")],
      secondRuntime,
      observed,
    );

    try {
      const recovered = await controller.recover(run.id);

      expect(recovered.status).toBe("TERMINAL");
      expect(recovered.run.status).toBe("COMPLETED");
      expect(await readFile(target, "utf8")).toBe("export const value = 2;\n");
      expect(firstPatchHandlerCalls).toBe(1);
      expect(replayedPatchHandlerCalls).toBe(0);
      expect(reconciliation).toHaveBeenCalledOnce();
      expect((await restarted.toolInvocations.listByRun(run.id))[0]?.status).toBe("FAILED");
      expect((await restarted.toolInvocations.listByRun(run.id))[0]?.error?.code).toBe(
        "TOOL_OUTCOME_UNKNOWN",
      );
      expect(await restarted.observations.listByRun(run.id)).toMatchObject([
        {
          isError: true,
          content: expect.stringContaining("current target state matches"),
          details: { effectReconciliation: "MATCHED_EXPECTED_STATE" },
        },
      ]);
      expect(observed[0]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-uncertain-patch",
        isError: true,
        content: expect.stringContaining("current target state matches"),
      });
    } finally {
      await restarted.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a crash between 16+2 Tool segments without replaying the committed prefix", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-tool-segment-crash-"));
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openToolStorage({ path: databasePath });
    const run = makeRun(path.join(directory, "project"), "fixture", {
      limits: { maxSteps: 12, maxToolCalls: 64, timeoutMs: 60_000 },
      resourcePolicy: {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 32, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 4,
          identicalCallNudgeThreshold: 2,
          noProgressTurnsBeforeReplan: 3,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      },
    });
    await seedRun(firstStorage, run);
    const firstBus = new EventBus(firstStorage.eventReader);
    const executions = new Map<string, number>();
    const firstRuntime = createRuntime(firstStorage, firstBus, async ({ identity }) => {
      executions.set(identity.externalCallId, (executions.get(identity.externalCallId) ?? 0) + 1);
      return { content: identity.externalCallId, details: {}, isError: false };
    });
    const calls = Array.from({ length: 18 }, (_, index) => ({
      id: `call-${String(index).padStart(2, "0")}`,
      name: "echo_value",
      input: {},
    }));
    let notifyFirstSegmentCommitted!: () => void;
    const firstSegmentCommitted = new Promise<void>((resolve) => {
      notifyFirstSegmentCommitted = resolve;
    });
    const crashAfterFirstSegment: ToolBatchCoordinator = {
      execute: async (request) => {
        const outcome = await firstRuntime.batch.execute(request);
        if (request.segment?.sourceOrdinalOffset === 0) {
          notifyFirstSegmentCommitted();
          // Simulate a process that disappeared after each Tool's terminal transaction committed,
          // but before the Run driver could receive the segment and advance its in-memory cursor.
          await new Promise<never>(() => undefined);
        }
        return outcome;
      },
    };
    const firstController = createController(
      firstStorage,
      firstBus,
      [turn("read these independent values", calls, "TOOL_CALLS")],
      { ...firstRuntime, batch: crashAfterFirstSegment },
    );

    void firstController.start(run.id);
    await firstSegmentCommitted;

    const committedPrefix = await firstStorage.toolInvocations.listByRun(run.id);
    expect(committedPrefix).toHaveLength(16);
    expect(committedPrefix.every((invocation) => invocation.status === "COMPLETED")).toBe(true);
    expect((await firstStorage.continuations.get(run.id))?.checkpoint.type).toBe(
      "WAITING_TOOL_RESULTS",
    );
    await firstStorage.close();

    const restarted = await openToolStorage({ path: databasePath });
    const secondBus = new EventBus(restarted.eventReader);
    const secondRuntime = createRuntime(restarted, secondBus, async ({ identity }) => {
      executions.set(identity.externalCallId, (executions.get(identity.externalCallId) ?? 0) + 1);
      return { content: identity.externalCallId, details: {}, isError: false };
    });
    const controller = createController(
      restarted,
      secondBus,
      [turn("all values are available", [], "STOP")],
      secondRuntime,
    );

    try {
      const result = await controller.recover(run.id);

      expect(result.run.status).toBe("COMPLETED");
      expect(await restarted.toolInvocations.listByRun(run.id)).toHaveLength(18);
      expect(executions.size).toBe(18);
      expect([...executions.values()].every((count) => count === 1)).toBe(true);
      expect(await restarted.observations.listByRun(run.id)).toHaveLength(18);
      expect(
        (await projectedMessages(restarted, run.id)).filter((message) => message.role === "tool"),
      ).toHaveLength(18);
    } finally {
      await restarted.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
