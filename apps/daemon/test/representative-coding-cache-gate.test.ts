import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import {
  agentTextPart,
  createContextContributionPipeline,
  createStandardAgentMessageProjectorRegistry,
  projectPromptSurface,
  userMessageSource,
} from "@caelush/agent";
import { createStepId, createTimestampMs } from "@caelush/protocol";
import {
  applyToolEffectsToAgentState,
  createCodingToolSettlementExtensionDecoder,
  effectsChangeAgentState,
} from "@caelush/coding-agent";
import { createInjectedReplayKeyProvider, createReplayProtection } from "@caelush/security";
import { openCaelushStorage, toHostToolEffectsPort } from "@caelush/storage";
import type { CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { makeRun, makeSession, makeStep } from "../../../packages/storage/test/support/fixtures.js";
import {
  composeDaemon,
  createProviderInvocationAccountingObserver,
} from "../src/daemon-composition.js";
import type { DaemonComposition } from "../src/daemon-composition.js";
import { createDaemonV2ContextEngine } from "../src/context/v2-context-composition.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  writeOpenAIChunk,
} from "./support/controllable-provider-server.js";
import type { ControllableProviderServer } from "./support/controllable-provider-server.js";
import {
  fingerprintRepresentativeScenario,
  representativeCodingFixtureFiles,
  representativeCodingScenarioManifests,
  REPRESENTATIVE_COST_STATUS,
  REPRESENTATIVE_METRIC_PROVENANCE,
  REPRESENTATIVE_REAL_PROVIDER_DISPATCH,
  type RepresentativeCodingScenarioManifest,
  type RepresentativeScenarioId,
} from "./support/representative-coding-cache.js";

const MODEL_ID = "deepseek-reasoner";
const API_ID = "openai-compatible-chat";
const FIXTURE_REASONING_PREFIX = "C5_PRIVATE_REASONING_";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: DaemonComposition | undefined;
let provider: ControllableProviderServer | undefined;

afterEach(async () => {
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  await provider?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  composition = undefined;
  provider = undefined;
});

interface ScriptedTurn {
  readonly kind: "TOOL" | "ANSWER" | "VERIFICATION";
  readonly id?: string;
  readonly toolName?: string;
  readonly rawArguments?: string;
  readonly reasoning?: string;
  readonly text?: string;
  readonly inputTokens?: number;
  readonly cacheHitTokens?: number;
}

function deepSeekModelSource(
  contextWindowTokens = 64_000,
  maxOutputTokens = 16_384,
): ModelDescriptorSourcePort {
  const descriptor: ModelDescriptor = {
    ref: { provider: "deepseek", model: MODEL_ID },
    api: API_ID,
    limits: { contextWindowTokens, maxOutputTokens },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "SUPPORTED",
      reasoningSummary: "UNKNOWN",
      promptCaching: "SUPPORTED",
      usageReporting: "SUPPORTED",
    },
    reasoning: { supportedLevels: ["HIGH"], supportsSummary: "UNKNOWN" },
    cache: { supportedRetentions: ["SHORT", "LONG"], defaultRetention: "LONG" },
    source: "CONFIGURATION",
    adapterMetadata: {
      "openai-compatible": {
        cacheDialect: "AUTOMATIC",
        requiresReasoningReplayWithTools: true,
      },
    },
  };
  return {
    id: "c5-representative-coding-fixture",
    priority: 100,
    resolve: (ref) =>
      ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
        ? descriptor
        : undefined,
  };
}

function scriptedProvider(
  turns: readonly ScriptedTurn[],
  manifest: RepresentativeCodingScenarioManifest,
) {
  return createControllableProviderServer(async (request, response) => {
    if (!request.path.endsWith("/chat/completions") || request.method !== "POST") {
      throw new Error("C5 loopback fixture received an unexpected request route.");
    }
    if (request.index >= manifest.maxModelCalls) {
      throw new Error("C5 model-call fuse opened before dispatch.");
    }
    const turn = turns[request.index];
    if (turn === undefined) throw new Error("C5 scripted Provider exhausted its fixed turns.");
    sendScriptedTurn(response, turn, request.index);
  });
}

function sendScriptedTurn(response: ServerResponse, turn: ScriptedTurn, index: number): void {
  beginOpenAISse(response);
  if (turn.kind === "TOOL") {
    if (
      turn.id === undefined ||
      turn.toolName === undefined ||
      turn.rawArguments === undefined ||
      turn.reasoning === undefined
    ) {
      throw new Error("C5 Tool script is incomplete.");
    }
    writeOpenAIChunk(response, {
      model: MODEL_ID,
      delta: { reasoning_content: turn.reasoning },
    });
    writeOpenAIChunk(response, {
      model: MODEL_ID,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: turn.id,
            type: "function",
            function: { name: turn.toolName, arguments: turn.rawArguments },
          },
        ],
      },
      finishReason: "tool_calls",
    });
  } else {
    writeOpenAIChunk(response, {
      model: MODEL_ID,
      delta: {
        ...(turn.reasoning === undefined ? {} : { reasoning_content: turn.reasoning }),
        content: turn.text ?? "",
      },
      finishReason: "stop",
    });
  }
  const inputTokens = turn.inputTokens ?? 10_000 + index * 500;
  const cacheHitTokens = turn.cacheHitTokens ?? (index === 0 ? 0 : 7_000 + index * 300);
  response.write(
    "data: " +
      JSON.stringify({
        id: `c5-loopback-${String(index)}`,
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL_ID,
        choices: [],
        usage: {
          prompt_tokens: inputTokens,
          prompt_tokens_details: { cached_tokens: cacheHitTokens },
          prompt_cache_hit_tokens: cacheHitTokens,
          prompt_cache_miss_tokens: inputTokens - cacheHitTokens,
          completion_tokens: 24,
          total_tokens: inputTokens + 24,
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      }) +
      "\n\n",
  );
  response.end("data: [DONE]\n\n");
}

function toolTurn(id: string, toolName: string, rawArguments: string, index: number): ScriptedTurn {
  return {
    kind: "TOOL",
    id,
    toolName,
    rawArguments,
    reasoning: `${FIXTURE_REASONING_PREFIX}${String(index)}`,
  };
}

function answer(
  text: string,
  index: number,
  usage: Pick<ScriptedTurn, "inputTokens" | "cacheHitTokens"> = {},
): ScriptedTurn {
  return {
    kind: "ANSWER",
    text,
    reasoning: `${FIXTURE_REASONING_PREFIX}${String(index)}`,
    ...usage,
  };
}

function verifier(usage: Pick<ScriptedTurn, "inputTokens" | "cacheHitTokens"> = {}): ScriptedTurn {
  return {
    kind: "VERIFICATION",
    text: JSON.stringify({ verdict: "PASS", summary: "verified" }),
    ...usage,
  };
}

async function prepareWorkspace(scenarioId: RepresentativeScenarioId): Promise<{
  readonly workspacePath: string;
  readonly databasePath: string;
  readonly workspaceRef: { readonly id: string; readonly path: string };
}> {
  directory = await mkdtemp(join(tmpdir(), "caelush-c5-representative-"));
  const workspacePath = join(directory, "workspace");
  const databasePath = join(directory, "caelush.db");
  await mkdir(workspacePath, { recursive: true });
  const files = representativeCodingFixtureFiles(scenarioId);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(workspacePath, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  initializeFixtureGit(workspacePath);
  storage = await openStore(databasePath);
  const workspace = await new WorkspaceService({
    repository: storage.workspaces,
  }).registerWorkspace({
    path: workspacePath,
  });
  return {
    workspacePath,
    databasePath,
    workspaceRef: {
      id: workspace.workspace.id,
      path: workspace.workspace.canonicalPath,
    },
  };
}

function initializeFixtureGit(workspacePath: string): void {
  execFileSync("git", ["-C", workspacePath, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspacePath, "config", "user.name", "Caelush C5 Fixture"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", workspacePath, "config", "user.email", "c5@example.invalid"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", workspacePath, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspacePath, "commit", "-m", "representative fixture baseline"], {
    stdio: "ignore",
  });
}

async function openStore(databasePath: string): Promise<CaelushStorage> {
  return openCaelushStorage({
    path: databasePath,
    replayProtection: createReplayProtection(
      createInjectedReplayKeyProvider("c5-fixture-key", Buffer.alloc(32, 0x5c)),
    ),
    toolSettlementExtension: createCodingToolSettlementExtensionDecoder({
      effects: toHostToolEffectsPort({
        changesState: effectsChangeAgentState,
        apply: applyToolEffectsToAgentState,
      }),
    }),
  });
}

function composeFixture(input: {
  readonly explicitPaths: readonly string[];
  readonly publicEvents: unknown[];
  readonly contextWindowTokens?: number;
  readonly failAfterToolResults?: number;
  readonly toolResultCount?: { value: number };
  readonly clock: { now(): ReturnType<typeof createTimestampMs> };
}): Promise<DaemonComposition> {
  let observedToolResults = input.toolResultCount ?? { value: 0 };
  return composeDaemon({
    storage: storage!,
    notifier: {
      notifyCommitted(events) {
        input.publicEvents.push(...events);
        if (input.failAfterToolResults === undefined) return;
        for (const event of events) {
          if (
            event.type === "conversation.message.committed" &&
            event.payload.messageType === "TOOL_RESULT"
          ) {
            observedToolResults.value += 1;
            if (observedToolResults.value === input.failAfterToolResults) {
              throw new Error("C5 restart boundary after committed Tool Result.");
            }
          }
        }
      },
      emitTransient(event) {
        input.publicEvents.push(event);
      },
    },
    modelSources: [deepSeekModelSource(input.contextWindowTokens)],
    providers: [
      {
        provider: "deepseek",
        baseUrl: provider!.endpoint,
        apiKey: "fixture-only",
        allowedModels: [MODEL_ID],
      },
    ],
    defaultModel: { provider: "deepseek", model: MODEL_ID },
    toolExposure: "AVAILABLE",
    clock: input.clock,
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt:
          "Use repository instructions and current file evidence. Keep edits minimal and verify results with Tools.",
        explicitPaths: input.explicitPaths,
        modelSettings: {
          maxOutputTokens: 2_048,
          temperature: 0.2,
          reasoning: { level: "HIGH" },
          cache: {
            retention: "LONG",
            key: "caelush-c5-representative-v1",
          },
        },
      }),
    },
  });
}

async function createRunForScenario(input: {
  readonly workspaceRef: { readonly id: string; readonly path: string };
  readonly goal: string;
  readonly createdAt?: ReturnType<typeof createTimestampMs>;
}) {
  const session = makeSession({
    workspaceId: input.workspaceRef.id as ReturnType<typeof makeSession>["workspaceId"],
    defaultWorkspace: input.workspaceRef,
  });
  const run = makeRun(session.id, {
    goal: input.goal,
    workspace: input.workspaceRef,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    model: { provider: "deepseek", model: MODEL_ID },
    reasoningLevel: "HIGH",
    runtime: { id: "local", kind: "local" },
    permissionProfile: "FULL_ACCESS",
    approvalPolicy: "NEVER_ASK",
    limits: { maxSteps: 24, maxToolCalls: 12, timeoutMs: 90_000 },
  });
  await storage!.sessions.insert(session);
  await storage!.runs.insert(run);
  return { session, run };
}

async function readSurface(runId: Parameters<CaelushStorage["promptSurface"]["getCurrent"]>[0]) {
  const current = await storage!.promptSurface.getCurrent(runId);
  if (current === undefined) throw new Error("C5 Prompt Surface epoch is missing.");
  const surface = await storage!.promptSurface.readEpoch(runId, current.epochId);
  if (surface === undefined) throw new Error("C5 Prompt Surface epoch could not be loaded.");
  return surface;
}

function surfaceSectionSets(
  records: readonly {
    readonly updates: readonly { readonly op: string; readonly content?: string }[];
  }[],
  label: string,
): string[] {
  return records.flatMap((record) =>
    record.updates.flatMap((update) =>
      update.op === "SET" && update.content?.includes(`label="${label}"`) === true
        ? [update.content]
        : [],
    ),
  );
}

function assertStableWireHeadAndToolOrder(
  requests: readonly { readonly body: Readonly<Record<string, unknown>> }[],
): void {
  const bodies = requests.map(({ body }) => body);
  const reference = bodies[0];
  if (reference === undefined) throw new Error("C5 captured no Provider request.");
  const referenceMessages = reference["messages"] as readonly Record<string, unknown>[];
  const referenceSystem = referenceMessages.find((message) => message.role === "system");
  const referenceTools = JSON.stringify(reference["tools"]);
  const referenceSettings = JSON.stringify(
    Object.fromEntries(Object.entries(reference).filter(([key]) => key !== "messages")),
  );

  for (const body of bodies) {
    const messages = body["messages"] as readonly Record<string, unknown>[];
    expect(messages.find((message) => message.role === "system")).toEqual(referenceSystem);
    expect(JSON.stringify(body["tools"])).toBe(referenceTools);
    expect(
      JSON.stringify(
        Object.fromEntries(Object.entries(body).filter(([key]) => key !== "messages")),
      ),
    ).toBe(referenceSettings);
    assertToolExchangeOrder(messages);
    expect(
      messages
        .filter((message) => message.role === "assistant")
        .every((message) => typeof message["reasoning_content"] === "string"),
    ).toBe(true);
  }
  for (let requestIndex = 1; requestIndex < bodies.length; requestIndex += 1) {
    const previous = bodies[requestIndex - 1]?.["messages"] as
      readonly Record<string, unknown>[] | undefined;
    const current = bodies[requestIndex]?.["messages"] as
      readonly Record<string, unknown>[] | undefined;
    if (previous === undefined || current === undefined) {
      throw new Error("C5 adjacent Provider request is missing its message sequence.");
    }
    let currentIndex = 0;
    for (const message of previous) {
      const serialized = JSON.stringify(message);
      const matchingIndex = current.findIndex(
        (candidate, index) => index >= currentIndex && JSON.stringify(candidate) === serialized,
      );
      expect(matchingIndex).toBeGreaterThanOrEqual(currentIndex);
      currentIndex = matchingIndex + 1;
    }
  }
}

function assertToolExchangeOrder(messages: readonly Record<string, unknown>[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    if (assistant?.role !== "assistant" || !Array.isArray(assistant["tool_calls"])) continue;
    const calls = assistant["tool_calls"] as readonly { readonly id?: string }[];
    let priorResult = index;
    for (const call of calls) {
      const resultIndex = messages.findIndex(
        (message, candidate) =>
          candidate > priorResult && message.role === "tool" && message["tool_call_id"] === call.id,
      );
      expect(call.id).toEqual(expect.any(String));
      expect(resultIndex).toBeGreaterThan(priorResult);
      priorResult = resultIndex;
    }
  }
}

function allRawCalls(
  requests: readonly { readonly body: Readonly<Record<string, unknown>> }[],
): Array<{
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly reasoning: unknown;
}> {
  const calls: Array<{ id: string; name: string; arguments: string; reasoning: unknown }> = [];
  for (const { body } of requests) {
    const messages = body["messages"] as readonly Record<string, unknown>[];
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message["tool_calls"])) continue;
      for (const value of message["tool_calls"] as readonly Record<string, unknown>[]) {
        const fn = value["function"] as Record<string, unknown>;
        if (
          typeof value["id"] !== "string" ||
          typeof fn["name"] !== "string" ||
          typeof fn["arguments"] !== "string"
        ) {
          throw new Error("C5 Provider wire contained a malformed historical Tool call.");
        }
        calls.push({
          id: value["id"],
          name: fn["name"],
          arguments: fn["arguments"],
          reasoning: message["reasoning_content"],
        });
      }
    }
  }
  return calls;
}

function safeWireDiagnostic(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
) {
  const leftMessages = left["messages"] as readonly Record<string, unknown>[];
  const rightMessages = right["messages"] as readonly Record<string, unknown>[];
  let firstDifferencePath = "none";
  let firstDifferenceCategory = "NONE";
  let prefixMatch = true;
  for (let index = 0; index < Math.min(leftMessages.length, rightMessages.length); index += 1) {
    if (JSON.stringify(leftMessages[index]) === JSON.stringify(rightMessages[index])) continue;
    prefixMatch = false;
    firstDifferencePath = `messages[${String(index)}].role-or-content`;
    firstDifferenceCategory = "VALUE_CHANGED";
    break;
  }
  if (prefixMatch && leftMessages.length !== rightMessages.length) {
    firstDifferencePath = "messages";
    firstDifferenceCategory = "ARRAY_LENGTH_CHANGED";
  }
  return {
    firstDifferenceCategory,
    firstDifferencePath,
    prefixMatchStatus: prefixMatch ? "PREFIX_MATCH" : "PREFIX_CHANGED_AT_FIRST_DIFFERENCE",
    roleShape: rightMessages.map(({ role }) => (typeof role === "string" ? role : "unknown")),
    messageCount: rightMessages.length,
    toolSchemaFingerprint:
      "sha256:" + createHash("sha256").update(JSON.stringify(right["tools"])).digest("hex"),
  };
}

function safeNumericTrajectory(
  requests: readonly { readonly body: Readonly<Record<string, unknown>> }[],
  records: readonly {
    readonly inputTokens?: number;
    readonly cacheHitInputTokens?: number;
    readonly cacheMissInputTokens?: number;
  }[],
): readonly {
  readonly requestIndex: number;
  readonly inputTokens: number;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly totalContextBytes: number;
  readonly newContextDeltaBytes: number;
  readonly conversationMessageCount: number;
  readonly toolResultCount: number;
}[] {
  if (requests.length !== records.length) {
    throw new Error("C5 numeric trajectory must pair every wire request with one Usage record.");
  }
  let previousMessages: readonly Record<string, unknown>[] = [];
  return Object.freeze(
    requests.map(({ body }, requestIndex) => {
      const messages = body["messages"];
      if (!Array.isArray(messages)) throw new Error("C5 request has no message list.");
      const safeMessages = messages as readonly Record<string, unknown>[];
      const record = records[requestIndex];
      if (
        record?.inputTokens === undefined ||
        record.cacheHitInputTokens === undefined ||
        record.cacheMissInputTokens === undefined
      ) {
        throw new Error("C5 numeric trajectory encountered incomplete synthetic Usage.");
      }
      let previousIndex = 0;
      let newContextDeltaBytes = 0;
      for (const message of safeMessages) {
        const serialized = JSON.stringify(message) ?? "";
        let matchedIndex = -1;
        for (let index = previousIndex; index < previousMessages.length; index += 1) {
          if (JSON.stringify(previousMessages[index]) === serialized) {
            matchedIndex = index;
            break;
          }
        }
        if (matchedIndex < 0) {
          newContextDeltaBytes += Buffer.byteLength(serialized, "utf8");
        } else {
          previousIndex = matchedIndex + 1;
        }
      }
      previousMessages = safeMessages;
      return Object.freeze({
        requestIndex,
        inputTokens: record.inputTokens,
        cacheHitTokens: record.cacheHitInputTokens,
        cacheMissTokens: record.cacheMissInputTokens,
        totalContextBytes: safeMessages.reduce(
          (total, message) => total + Buffer.byteLength(JSON.stringify(message) ?? "", "utf8"),
          0,
        ),
        newContextDeltaBytes,
        conversationMessageCount: safeMessages.filter((message) =>
          ["user", "assistant", "tool"].includes(String(message.role)),
        ).length,
        toolResultCount: safeMessages.filter((message) => message.role === "tool").length,
      });
    }),
  );
}

async function assertSyntheticUsageAndSafeReport(
  runId: Parameters<CaelushStorage["providerInvocationUsage"]["listByRun"]>[0],
  manifest: RepresentativeCodingScenarioManifest,
  providerCalls: number,
  requireWarmMainAgent = true,
  expectedVerificationCalls = 1,
): Promise<void> {
  expect(providerCalls).toBeLessThanOrEqual(manifest.maxModelCalls);
  const records = await storage!.providerInvocationUsage.listByRun(runId);
  expect(records).toHaveLength(providerCalls);
  expect(new Set(records.map(({ callId }) => callId)).size).toBe(providerCalls);
  expect(records.every(({ status }) => status === "COMPLETE")).toBe(true);
  expect(
    records.every(
      ({ inputTokens, cacheHitInputTokens, cacheMissInputTokens }) =>
        inputTokens !== undefined &&
        cacheHitInputTokens !== undefined &&
        cacheMissInputTokens !== undefined &&
        inputTokens === cacheHitInputTokens + cacheMissInputTokens,
    ),
  ).toBe(true);
  expect(
    records.reduce((total, record) => total + (record.outputTokens ?? 0), 0),
  ).toBeLessThanOrEqual(manifest.maxOutputTokens);
  const totalMissTokens = records.reduce(
    (total, record) => total + (record.cacheMissInputTokens ?? 0),
    0,
  );
  expect(totalMissTokens).toBeLessThanOrEqual(manifest.maxMissTokens);
  const usage = await composition!.contextUsage.getContextUsage(String(runId));
  const metrics = usage?.promptCache?.metricsV2;
  expect(metrics).toBeDefined();
  expect(metrics?.usageCoverage).toMatchObject({
    observedRequestCount: providerCalls,
    completeCacheUsageCount: providerCalls,
    incompleteOrUnknownCount: 0,
    coverageRate: 1,
    status: "REPORTED",
  });
  expect(metrics?.fullRun.mainAgent.requestCount).toBeGreaterThan(0);
  if (requireWarmMainAgent) {
    expect(metrics?.warm.mainAgent.requestCount).toBeGreaterThan(0);
  }
  expect(metrics?.fullRun.allPurposes.requestCount).toBe(providerCalls);
  expect(metrics?.rolling.windowSize).toBe(10);
  expect(metrics?.rolling.allPurposes.requestCount).toBe(Math.min(providerCalls, 10));
  expect(
    (metrics?.fullRun.allPurposes.accountedTokens ?? 0) -
      (metrics?.fullRun.allPurposes.hitTokens ?? 0),
  ).toBe(totalMissTokens);
  const latestRecord = records.at(-1);
  expect(metrics?.latestRequest).toMatchObject({
    inputTokens: latestRecord?.inputTokens,
    hitTokens: latestRecord?.cacheHitInputTokens,
    missTokens: latestRecord?.cacheMissInputTokens,
    cacheUsageReported: true,
  });
  for (const view of [
    metrics?.fullRun.mainAgent,
    metrics?.fullRun.allPurposes,
    metrics?.warm.mainAgent,
    metrics?.warm.allPurposes,
    metrics?.rolling.mainAgent,
    metrics?.rolling.allPurposes,
  ]) {
    if (view === undefined) continue;
    expect(view.hitRate).toBe(
      view.accountedTokens === 0 ? undefined : view.hitTokens / view.accountedTokens,
    );
  }
  expect(records.filter(({ purpose }) => purpose === "VERIFICATION_LLM")).toHaveLength(
    expectedVerificationCalls,
  );
  expect(metrics?.surfaceDelta.availability).toBe("AVAILABLE");
  expect(REPRESENTATIVE_METRIC_PROVENANCE).toBe("SYNTHETIC");
  expect(REPRESENTATIVE_COST_STATUS).toBe("COST_UNVERIFIED");
  expect(REPRESENTATIVE_REAL_PROVIDER_DISPATCH).toBe("DISABLED");
}

describe("representative coding cache gate manifests", () => {
  it("freezes the three representative task identities and offline dispatch policy", () => {
    expect(representativeCodingScenarioManifests.map(({ scenarioId }) => scenarioId)).toEqual([
      "SCENARIO_A_SIMPLE_LOGIN_EDIT",
      "SCENARIO_B_MULTI_FILE_FEATURE",
      "SCENARIO_C_LONG_TASK_RECOVERY",
    ]);
    expect(representativeCodingScenarioManifests.every(Object.isFrozen)).toBe(true);
  });

  it("changes benchmark identity when fixed cache settings change", () => {
    const manifest = representativeCodingScenarioManifests[0];
    if (manifest === undefined) throw new Error("Scenario A manifest is missing.");
    const changed = {
      ...manifest,
      cacheSettings: { ...manifest.cacheSettings, retention: "SHORT" as const },
    };

    expect(fingerprintRepresentativeScenario(changed)).not.toBe(
      fingerprintRepresentativeScenario(manifest),
    );
  });
});

describe("REPRESENTATIVE_CODING production cache gate", () => {
  it("runs Scenario A through the production Run path with a 10 KB login edit", async () => {
    const manifest = representativeCodingScenarioManifests[0];
    if (manifest === undefined) throw new Error("Scenario A manifest is missing.");
    const fixture = await prepareWorkspace(manifest.scenarioId);
    expect(
      Buffer.byteLength(
        representativeCodingFixtureFiles(manifest.scenarioId)["src/login.html"] ?? "",
        "utf8",
      ),
    ).toBe(10_240);

    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/login.html",
      "@@",
      '   <main class="login-shell">',
      '+    <h1 id="login-title">Sign in</h1>',
      '-    <form class="login-form">',
      '+    <form class="login-form" aria-labelledby="login-title">',
      "*** Update File: src/login.css",
      "@@",
      " .login-button { background: #2852a6; color: white; }",
      "+.login-button:focus-visible { outline: 3px solid #f0b429; outline-offset: 2px; }",
      "*** End Patch",
    ].join("\n");
    const turns: ScriptedTurn[] = [
      toolTurn("c5-a-1", "read_file", '{"path":"AGENTS.md"}', 1),
      toolTurn("c5-a-2", "read_file", '{"path":"README.md"}', 2),
      toolTurn("c5-a-3", "read_file", '{"path":"src/login.html"}', 3),
      toolTurn("c5-a-4", "read_file", '{"path":"src/login.css"}', 4),
      toolTurn("c5-a-5", "apply_patch", JSON.stringify({ patch: patchText }), 5),
      toolTurn("c5-a-6", "read_file", '{"path":"src/login.html"}', 6),
      toolTurn("c5-a-7", "read_file", '{"path":"src/login.css"}', 7),
      toolTurn("c5-a-8", "exec_command", '{"cmd":"git diff --check"}', 8),
      answer(
        "Added an accessible login heading and visible keyboard focus style; both files passed Tool verification.",
        9,
      ),
      verifier(),
    ];
    provider = await scriptedProvider(turns, manifest);
    const publicEvents: unknown[] = [];
    let tick = 100;
    const clock = { now: () => createTimestampMs(tick++) };
    const { session, run } = await createRunForScenario({
      workspaceRef: fixture.workspaceRef,
      goal: "Inspect the login page and add a clear heading and visible keyboard focus styling.",
    });
    composition = await composeFixture({
      explicitPaths: ["src/login.html", "src/login.css"],
      publicEvents,
      clock,
    });

    const result = await composition.controller.start(run.id);
    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    const html = await readFile(join(fixture.workspacePath, "src/login.html"), "utf8");
    const css = await readFile(join(fixture.workspacePath, "src/login.css"), "utf8");
    expect(html).toContain('<form class="login-form" aria-labelledby="login-title">');
    expect(html).toContain('<h1 id="login-title">Sign in</h1>');
    expect(css).toContain(".login-button:focus-visible");
    expect(provider.requests.length).toBe(10);
    expect(provider.requests.every(({ path }) => path.endsWith("/chat/completions"))).toBe(true);
    expect(new URL(provider.endpoint).hostname).toBe("127.0.0.1");
    expect(
      provider.requests
        .slice(0, 9)
        .every(({ body }) => (body["max_tokens"] ?? body["max_completion_tokens"]) === 2_048),
    ).toBe(true);
    expect(
      provider.requests[9]?.body["max_tokens"] ??
        provider.requests[9]?.body["max_completion_tokens"],
    ).toBe(8_192);

    const mainRequests = provider.requests.slice(0, 9);
    assertStableWireHeadAndToolOrder(mainRequests);
    const surface = await readSurface(run.id);
    const htmlSets = surfaceSectionSets(surface.records ?? [], "src/login.html");
    const cssSets = surfaceSectionSets(surface.records ?? [], "src/login.css");
    expect(htmlSets).toHaveLength(2);
    expect(cssSets).toHaveLength(2);
    expect(htmlSets[0]).toContain("login-form");
    expect(htmlSets[1]).toContain("aria-labelledby");
    const metrics = (await composition.contextUsage.getContextUsage(String(run.id)))?.promptCache
      ?.metricsV2;
    expect(metrics?.surfaceDelta).toMatchObject({
      availability: "AVAILABLE",
      unchangedSectionReemissionCount: 0,
    });
    expect(metrics?.fullRun.mainAgent.accountedTokens).toBeGreaterThan(0);
    expect(
      (metrics?.fullRun.mainAgent.accountedTokens ?? 0) -
        (metrics?.fullRun.mainAgent.hitTokens ?? 0),
    ).toBeGreaterThan(0);
    expect(metrics?.warm.mainAgent.requestCount).toBeGreaterThan(0);

    const firstRequest = provider.requests[0]?.body;
    const finalRequest = provider.requests[8]?.body;
    if (firstRequest === undefined || finalRequest === undefined) {
      throw new Error("C5 wire capture is incomplete.");
    }
    const diagnostic = safeWireDiagnostic(firstRequest, finalRequest);
    expect(JSON.stringify(diagnostic)).not.toContain(FIXTURE_REASONING_PREFIX);
    expect(diagnostic).toMatchObject({
      firstDifferenceCategory: expect.any(String),
      firstDifferencePath: expect.any(String),
      roleShape: expect.any(Array),
      messageCount: expect.any(Number),
      toolSchemaFingerprint: expect.stringMatching(/^sha256:/),
    });
    const replayedCalls = allRawCalls(provider.requests.slice(5, 9));
    expect(
      replayedCalls.some(
        (call) => call.id === "c5-a-5" && call.arguments === JSON.stringify({ patch: patchText }),
      ),
    ).toBe(true);
    expect(
      replayedCalls
        .filter((call) => call.id.startsWith("c5-a-"))
        .every((call) => typeof call.reasoning === "string"),
    ).toBe(true);

    const invocations = await storage!.toolInvocations.listByRun(run.id);
    expect(invocations.map(({ toolName }) => toolName)).toEqual([
      "read_file",
      "read_file",
      "read_file",
      "read_file",
      "apply_patch",
      "read_file",
      "read_file",
      "exec_command",
    ]);
    const snapshot = await composition.messages.conversation.loadSnapshot({
      sessionId: session.id,
      currentRunId: run.id,
    });
    const stored = snapshot.turns.flatMap((turn) => turn.messages);
    const transcript = stored.flatMap((message) =>
      composition!.transcriptProjectors.project(message),
    );
    const safePublicJson = JSON.stringify({ publicEvents, transcript, result });
    expect(safePublicJson).not.toContain(FIXTURE_REASONING_PREFIX);
    expect(safePublicJson).not.toContain("fixture-only");
    expect(safePublicJson).not.toContain(patchText);
    expect(manifest.maxToolCalls).toBeGreaterThanOrEqual(invocations.length);
    await assertSyntheticUsageAndSafeReport(run.id, manifest, provider.requests.length);
    const trajectory = safeNumericTrajectory(
      provider.requests,
      await storage!.providerInvocationUsage.listByRun(run.id),
    );
    expect(trajectory).toHaveLength(provider.requests.length);
    expect(trajectory[0]?.newContextDeltaBytes).toBe(trajectory[0]?.totalContextBytes);
    expect(
      trajectory.every(
        ({ totalContextBytes, newContextDeltaBytes }) =>
          totalContextBytes >= 0 && newContextDeltaBytes >= 0,
      ),
    ).toBe(true);
  }, 60_000);

  it("runs Scenario B as a multi-file feature with changing Work Commentary", async () => {
    const manifest = representativeCodingScenarioManifests[1];
    if (manifest === undefined) throw new Error("Scenario B manifest is missing.");
    const fixture = await prepareWorkspace(manifest.scenarioId);
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/app.js",
      "@@",
      ' const output = document.querySelector("#welcome-output");',
      '+output.setAttribute("aria-live", "polite");',
      "*** Update File: src/utils.js",
      "@@",
      " export function formatWelcome(name) {",
      "-  return `Hello, ${name}!`;",
      "+  const normalized = name.trim();",
      '+  return `Hello, ${normalized || "friend"}!`;',
      "*** End Patch",
    ].join("\n");
    const turns: ScriptedTurn[] = [
      toolTurn("c5-b-1", "read_file", '{"path":"AGENTS.md"}', 1),
      toolTurn("c5-b-2", "search_text", '{"pattern":"formatWelcome","path":"src"}', 2),
      toolTurn("c5-b-3", "read_file", '{"path":"src/app.js"}', 3),
      toolTurn("c5-b-4", "read_file", '{"path":"src/utils.js"}', 4),
      toolTurn("c5-b-5", "apply_patch", JSON.stringify({ patch: patchText }), 5),
      toolTurn("c5-b-6", "read_file", '{"path":"src/app.js"}', 6),
      toolTurn("c5-b-7", "read_file", '{"path":"src/utils.js"}', 7),
      toolTurn("c5-b-8", "exec_command", '{"cmd":"node --check src/app.js"}', 8),
      toolTurn("c5-b-9", "exec_command", '{"cmd":"node --check src/utils.js"}', 9),
      toolTurn("c5-b-10", "git_status", '{"path":"."}', 10),
      answer(
        "The empty-name welcome now has a safe fallback, the output announces updates accessibly, and both files pass syntax checks.",
        11,
      ),
      verifier(),
    ];
    provider = await scriptedProvider(turns, manifest);
    const publicEvents: unknown[] = [];
    let tick = 200;
    const clock = { now: () => createTimestampMs(tick++) };
    const { session, run } = await createRunForScenario({
      workspaceRef: fixture.workspaceRef,
      goal: "Improve the welcome feature for empty names and announce its result accessibly.",
    });
    composition = await composeFixture({
      explicitPaths: ["src/app.js", "src/utils.js", "src/styles.css"],
      publicEvents,
      clock,
    });

    const result = await composition.controller.start(run.id);
    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    expect(provider.requests).toHaveLength(12);
    expect(provider.requests.slice(0, 11).every(({ body }) => body["max_tokens"] === 2_048)).toBe(
      true,
    );
    expect(provider.requests[11]?.body["max_tokens"]).toBe(8_192);
    assertStableWireHeadAndToolOrder(provider.requests.slice(0, 11));

    const app = await readFile(join(fixture.workspacePath, "src/app.js"), "utf8");
    const utility = await readFile(join(fixture.workspacePath, "src/utils.js"), "utf8");
    expect(app).toContain('output.setAttribute("aria-live", "polite")');
    expect(utility).toContain('normalized || "friend"');
    expect(
      execFileSync("git", ["-C", fixture.workspacePath, "status", "--short"], {
        encoding: "utf8",
      }),
    ).toContain("src/app.js");
    expect(
      execFileSync("git", ["-C", fixture.workspacePath, "status", "--short"], {
        encoding: "utf8",
      }),
    ).toContain("src/utils.js");
    const invocations = await storage!.toolInvocations.listByRun(run.id);
    expect(invocations.map(({ toolName, status }) => [toolName, status])).toEqual([
      ["read_file", "COMPLETED"],
      ["search_text", "COMPLETED"],
      ["read_file", "COMPLETED"],
      ["read_file", "COMPLETED"],
      ["apply_patch", "COMPLETED"],
      ["read_file", "COMPLETED"],
      ["read_file", "COMPLETED"],
      ["exec_command", "COMPLETED"],
      ["exec_command", "COMPLETED"],
      ["git_status", "COMPLETED"],
    ]);

    const surface = await readSurface(run.id);
    expect(surface.records?.filter(({ kind }) => kind === "BASELINE")).toHaveLength(1);
    expect(surface.records?.filter(({ kind }) => kind === "DELTA").length).toBeGreaterThan(0);
    expect(surfaceSectionSets(surface.records ?? [], "src/app.js")).toHaveLength(2);
    expect(surfaceSectionSets(surface.records ?? [], "src/utils.js")).toHaveLength(2);
    expect(surfaceSectionSets(surface.records ?? [], "src/styles.css")).toHaveLength(1);
    const workProgress = surfaceSectionSets(surface.records ?? [], "work progress");
    expect(workProgress.length).toBeGreaterThanOrEqual(3);
    expect(new Set(workProgress).size).toBeGreaterThanOrEqual(3);
    const projected = projectPromptSurface(surface);
    const visibleRecordCount = surface.records?.filter(({ kind }) => kind !== "NOOP").length ?? 0;
    expect(projected).toHaveLength(visibleRecordCount);
    expect(
      projected.every(
        ({ source }) =>
          source.kind === "RUNTIME_CONTEXT_BASELINE" || source.kind === "RUNTIME_CONTEXT_DELTA",
      ),
    ).toBe(true);
    const metrics = (await composition.contextUsage.getContextUsage(String(run.id)))?.promptCache
      ?.metricsV2;
    expect(metrics?.surfaceDelta.unchangedSectionReemissionCount).toBe(0);
    expect(metrics?.fullRun.allPurposes.requestCount).toBe(12);
    await assertSyntheticUsageAndSafeReport(run.id, manifest, provider.requests.length);
    const trajectory = safeNumericTrajectory(
      provider.requests,
      await storage!.providerInvocationUsage.listByRun(run.id),
    );
    expect(trajectory).toHaveLength(provider.requests.length);
    expect(
      trajectory.every(
        ({ inputTokens, cacheHitTokens, cacheMissTokens }) =>
          inputTokens === cacheHitTokens + cacheMissTokens,
      ),
    ).toBe(true);

    const snapshot = await composition.messages.conversation.loadSnapshot({
      sessionId: session.id,
      currentRunId: run.id,
    });
    const transcript = snapshot.turns
      .flatMap((turn) => turn.messages)
      .flatMap((message) => composition!.transcriptProjectors.project(message));
    const safePublicJson = JSON.stringify({ publicEvents, transcript, result });
    expect(safePublicJson).not.toContain(FIXTURE_REASONING_PREFIX);
    expect(safePublicJson).not.toContain("fixture-only");
    expect(safePublicJson).not.toContain(patchText);
  }, 60_000);

  it("recovers Scenario C from SQLite and selects legal same-session prior-run history", async () => {
    const manifest = representativeCodingScenarioManifests[2];
    if (manifest === undefined) throw new Error("Scenario C manifest is missing.");
    const fixture = await prepareWorkspace(manifest.scenarioId);
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/utils.js",
      "@@",
      "   // TODO: normalize empty and whitespace-only names.",
      "-  return `Hello, ${name}!`;",
      "+  const normalized = name.trim();",
      '+  return `Hello, ${normalized || "friend"}!`;',
      "*** End Patch",
    ].join("\n");
    const firstGoal =
      "Review the documented greeting behavior, normalize whitespace-only names, and verify the utility change.";
    const secondGoal = "Continue from the verified utility work in this session.";
    const turns: ScriptedTurn[] = [
      toolTurn("c5-c-1", "read_file", '{"path":"AGENTS.md"}', 1),
      toolTurn("c5-c-2", "read_file", '{"path":"README.md"}', 2),
      toolTurn("c5-c-3", "search_text", '{"pattern":"TODO","path":"src"}', 3),
      toolTurn("c5-c-4", "read_file", '{"path":"src/utils.js"}', 4),
      toolTurn("c5-c-5", "read_file", '{"path":"src/app.js"}', 5),
      toolTurn("c5-c-6", "apply_patch", JSON.stringify({ patch: patchText }), 6),
      toolTurn("c5-c-7", "read_file", '{"path":"src/utils.js"}', 7),
      toolTurn("c5-c-8", "git_status", '{"path":"."}', 8),
      toolTurn("c5-c-9", "exec_command", '{"cmd":"node --check src/utils.js"}', 9),
      answer("The empty-name behavior is updated and the source syntax check passed.", 10),
      verifier(),
      answer("The verified greeting utility keeps its API and handles blank names safely.", 11, {
        inputTokens: 16_000,
        cacheHitTokens: 0,
      }),
      verifier(),
    ];
    provider = await scriptedProvider(turns, manifest);
    const publicEvents: unknown[] = [];
    const toolResultCount = { value: 0 };
    let tick = 300;
    const clock = { now: () => createTimestampMs(tick++) };
    const { session, run } = await createRunForScenario({
      workspaceRef: fixture.workspaceRef,
      goal: firstGoal,
      createdAt: createTimestampMs(100),
    });
    composition = await composeFixture({
      explicitPaths: ["src/utils.js"],
      publicEvents,
      contextWindowTokens: manifest.contextWindowTokens,
      failAfterToolResults: 2,
      toolResultCount,
      clock,
    });

    await expect(composition.controller.start(run.id)).rejects.toThrow(
      "C5 restart boundary after committed Tool Result.",
    );
    expect(toolResultCount.value).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(await storage!.providerInvocationUsage.listByRun(run.id)).toHaveLength(2);

    await composition.dispose();
    composition = undefined;
    await storage!.close();
    storage = await openStore(fixture.databasePath);
    composition = await composeFixture({
      explicitPaths: ["src/utils.js"],
      publicEvents,
      contextWindowTokens: manifest.contextWindowTokens,
      toolResultCount,
      clock,
    });

    const recoveredUsageBefore = await storage.providerInvocationUsage.listByRun(run.id);
    expect(recoveredUsageBefore).toHaveLength(2);
    const recovered = await composition.controller.recover(run.id);
    if (recovered.status !== "TERMINAL") {
      throw new Error(
        `C5 first-run recovery diagnostics: ${JSON.stringify({
          status: recovered.status,
          error: recovered.status === "FAILED" ? recovered.error : undefined,
          requestCount: provider.requests.length,
        })}`,
      );
    }
    expect(recovered.status).toBe("TERMINAL");
    expect(recovered.run.status).toBe("COMPLETED");
    expect(provider.requests).toHaveLength(11);
    const updatedUtility = await readFile(join(fixture.workspacePath, "src/utils.js"), "utf8");
    expect(updatedUtility).toContain('normalized || "friend"');
    const utilityModule = (await import(
      pathToFileURL(join(fixture.workspacePath, "src/utils.js")).href
    )) as { readonly formatWelcome?: (name: string) => string };
    if (typeof utilityModule.formatWelcome !== "function") {
      throw new Error("C5 Scenario C utility export is missing after recovery.");
    }
    for (const name of ["Ada", "Grace Hopper", "Linus", "Katherine Johnson"]) {
      expect(utilityModule.formatWelcome(`  ${name}  `)).toBe(`Hello, ${name}!`);
    }
    expect(utilityModule.formatWelcome(" \t ")).toBe("Hello, friend!");
    const invocations = await storage.toolInvocations.listByRun(run.id);
    expect(invocations).toHaveLength(9);
    expect(invocations.every(({ status }) => status === "COMPLETED")).toBe(true);
    const recoveredRecords = await storage.providerInvocationUsage.listByRun(run.id);
    expect(new Set(recoveredRecords.map(({ callId }) => callId)).size).toBe(11);
    expect(recoveredRecords.filter(({ purpose }) => purpose === "VERIFICATION_LLM")).toHaveLength(
      1,
    );

    const postRecoveryWire = provider.requests.slice(2, 10);
    assertStableWireHeadAndToolOrder(postRecoveryWire);
    const replayed = allRawCalls(postRecoveryWire);
    expect(
      replayed.some(
        ({ id, arguments: rawArguments }) =>
          id === "c5-c-6" && rawArguments === JSON.stringify({ patch: patchText }),
      ),
    ).toBe(true);
    for (const id of [
      "c5-c-1",
      "c5-c-2",
      "c5-c-3",
      "c5-c-4",
      "c5-c-5",
      "c5-c-6",
      "c5-c-7",
      "c5-c-8",
    ]) {
      expect(replayed.some((call) => call.id === id && typeof call.reasoning === "string")).toBe(
        true,
      );
    }
    const firstRunSurface = await readSurface(run.id);
    expect(firstRunSurface.records?.filter(({ kind }) => kind === "BASELINE")).toHaveLength(1);
    expect(firstRunSurface.records?.filter(({ kind }) => kind === "DELTA").length).toBeGreaterThan(
      0,
    );
    const firstRunMetrics = (await composition.contextUsage.getContextUsage(String(run.id)))
      ?.promptCache?.metricsV2;
    expect(firstRunMetrics?.fullRun.allPurposes.requestCount).toBe(11);
    expect(firstRunMetrics?.fullRun.mainAgent.requestCount).toBe(10);
    const firstRunUsage = await storage.providerInvocationUsage.listByRun(run.id);
    const preCompactionMainRecords = firstRunUsage.filter(
      ({ purpose }) => purpose === "MAIN_AGENT",
    );
    expect(preCompactionMainRecords).toHaveLength(10);

    const crossRun = makeRun(session.id, {
      createdAt: clock.now(),
      goal: secondGoal,
      workspace: fixture.workspaceRef,
      model: { provider: "deepseek", model: MODEL_ID },
      reasoningLevel: "HIGH",
      runtime: { id: "local", kind: "local" },
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 12, maxToolCalls: 10, timeoutMs: 90_000 },
    });
    await storage.runs.insert(crossRun);
    const crossRunUser = composition.messages.factory.createUser({
      runId: crossRun.id,
      sessionId: crossRun.sessionId,
      conversationTurnId: composition.messages.turns.forRun(crossRun.id),
      source: userMessageSource("FOLLOW_UP"),
      content: [agentTextPart(crossRun.goal)],
    });
    await composition.messages.conversation.append(crossRun.id, [
      composition.messages.codecs.encode(crossRunUser),
    ]);
    expect(provider.requests).toHaveLength(11);
    const crossRunResult = await composition.controller.start(crossRun.id);
    expect(crossRunResult.status).toBe("TERMINAL");
    expect(crossRunResult.run.status).toBe("COMPLETED");
    const crossRunRequestIndex = 11;
    expect(provider.requests).toHaveLength(crossRunRequestIndex + 2);
    const crossRunUsage = await storage.providerInvocationUsage.listByRun(crossRun.id);
    expect(crossRunUsage).toHaveLength(2);
    expect(crossRunUsage.filter(({ purpose }) => purpose === "VERIFICATION_LLM")).toHaveLength(1);
    expect(provider.requests.length).toBeLessThanOrEqual(manifest.maxModelCalls);
    const scenarioRecords = [...firstRunUsage, ...crossRunUsage];
    expect(new Set(scenarioRecords.map(({ callId }) => callId)).size).toBe(scenarioRecords.length);
    expect(
      scenarioRecords.reduce((total, record) => total + (record.cacheMissInputTokens ?? 0), 0),
    ).toBeLessThanOrEqual(manifest.maxMissTokens);
    const trajectory = safeNumericTrajectory(provider.requests, scenarioRecords);
    expect(trajectory).toHaveLength(provider.requests.length);
    expect(trajectory.at(-2)?.cacheHitTokens).toBe(0);

    const crossRunMetrics = (await composition.contextUsage.getContextUsage(String(crossRun.id)))
      ?.promptCache?.metricsV2;
    expect(crossRunMetrics?.fullRun.allPurposes.requestCount).toBe(crossRunUsage.length);
    expect(crossRunMetrics?.surfaceDelta.unchangedSectionReemissionCount).toBe(0);
    expect(provider.requests[crossRunRequestIndex]?.body["max_tokens"]).toBe(2_048);
    expect(provider.requests[crossRunRequestIndex + 1]?.body["max_tokens"]).toBe(8_192);

    const crossRunMessages = provider.requests[crossRunRequestIndex]?.body["messages"] as
      readonly Record<string, unknown>[] | undefined;
    expect(crossRunMessages).toBeDefined();
    const crossRunMessageText = (crossRunMessages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(crossRunMessageText).toContain(secondGoal);
    const toolResultIndex =
      crossRunMessages?.findIndex(
        (message) => message.role === "tool" && message.tool_call_id === "c5-c-9",
      ) ?? -1;
    expect(toolResultIndex).toBeGreaterThan(0);
    const toolResult = crossRunMessages?.[toolResultIndex];
    const precedingAssistant = (crossRunMessages ?? [])
      .slice(0, toolResultIndex)
      .reverse()
      .find((message) => message.role === "assistant");
    const precedingCalls = Array.isArray(precedingAssistant?.tool_calls)
      ? (precedingAssistant.tool_calls as readonly Record<string, unknown>[])
      : [];
    expect(precedingCalls.some((call) => call.id === toolResult?.tool_call_id)).toBe(true);
    const followUpUserIndex = (crossRunMessages ?? []).findIndex(
      (message, index) =>
        index > toolResultIndex &&
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes(secondGoal),
    );
    expect(followUpUserIndex).toBeGreaterThan(toolResultIndex);

    const conversation = await composition.messages.conversation.loadSnapshot({
      sessionId: session.id,
      currentRunId: crossRun.id,
    });
    expect(conversation.turns.map(({ runId }) => runId)).toContain(run.id);
    expect(conversation.turns.map(({ runId }) => runId)).toContain(crossRun.id);
    expect(
      conversation.turns
        .find(({ runId }) => runId === crossRun.id)
        ?.messages.some(({ message }) => message.type === "ASSISTANT"),
    ).toBe(true);
    const crossSurface = await readSurface(crossRun.id);
    const currentEpoch = await storage.promptSurface.getCurrent(crossRun.id);
    expect(currentEpoch?.resetReason).toBe("INITIAL");
    expect(crossSurface.records?.every(({ runId }) => runId === crossRun.id)).toBe(true);
    await assertSyntheticUsageAndSafeReport(run.id, manifest, 11);
    await assertSyntheticUsageAndSafeReport(crossRun.id, manifest, crossRunUsage.length, false, 1);

    // The controlled compaction fixture uses a separate offline-only Context budget and a fresh
    // Run surface. It follows the completed coding Runs, so the completed same-session history is
    // eligible for a real production Context checkpoint without inserting a Step into an active Run.
    const compactionRun = makeRun(session.id, {
      createdAt: clock.now(),
      goal: "Exercise the controlled offline compaction recovery boundary.",
      workspace: fixture.workspaceRef,
      model: { provider: "deepseek", model: MODEL_ID },
      reasoningLevel: "HIGH",
      runtime: { id: "local", kind: "local" },
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 4, maxToolCalls: 2, timeoutMs: 90_000 },
    });
    await storage.runs.insert(compactionRun);
    const compactionUser = composition.messages.factory.createUser({
      runId: compactionRun.id,
      sessionId: compactionRun.sessionId,
      conversationTurnId: composition.messages.turns.forRun(compactionRun.id),
      source: userMessageSource("FOLLOW_UP"),
      content: [agentTextPart(compactionRun.goal)],
    });
    await composition.messages.conversation.append(compactionRun.id, [
      composition.messages.codecs.encode(compactionUser),
    ]);
    const compactionConversation = await composition.messages.conversation.loadSnapshot({
      sessionId: session.id,
      currentRunId: compactionRun.id,
    });
    const contextEngine = createDaemonV2ContextEngine({
      input: {
        run: compactionRun,
        identity: composition.resolveTurnIdentity(compactionRun),
        runMode: "EXECUTE",
        baseSystemPrompt:
          "Use repository instructions and current file evidence. Keep edits minimal and verify results with Tools.",
        cwd: fixture.workspacePath,
        explicitPaths: ["src/utils.js"],
        modelSettings: {
          maxOutputTokens: 2_048,
          temperature: 0.2,
          reasoning: { level: "HIGH" },
          cache: { retention: "LONG", key: "caelush-c5-representative-v1" },
        },
      },
      storage,
      promptSurfaceStore: storage.promptSurface,
      runtime: composition.runtime,
      gateway: composition.ai.gateway,
      invocationObserverFactory: (runId) =>
        createProviderInvocationAccountingObserver({
          storage: storage!,
          runId,
          purpose: "CONTEXT_COMPACTION",
          clock,
        }),
      messageProjectors: createStandardAgentMessageProjectorRegistry(),
      notifier: composition.events,
      contributionPipeline: createContextContributionPipeline(),
      clock,
      activeToolNames: composition.toolRegistry.names(),
    });
    const compactionModel: ModelDescriptor = {
      ...composition.ai.models.resolve(compactionRun.model),
      limits: {
        contextWindowTokens: manifest.offlineCompactionContextWindowTokens ?? 8_192,
        maxOutputTokens: 2_048,
      },
    };
    const compactionStep = makeStep(compactionRun.id, {
      id: createStepId(),
      sequence: 1,
      startedAt: clock.now(),
    });
    await storage.steps.insert(compactionStep);
    await contextEngine.prepare({
      identity: composition.resolveTurnIdentity(compactionRun),
      turn: { stepId: compactionStep.id, sequence: compactionStep.sequence },
      conversation: compactionConversation,
      input: { kind: "USER_INPUT", userMessageId: compactionUser.id },
      model: compactionModel,
      tools: composition.toolRegistry.modelSpecs(),
      mode: "FORCED_RECOVERY",
      signal: new AbortController().signal,
    });
    const compactionSurface = await readSurface(compactionRun.id);
    const compactionEpoch = await storage.promptSurface.getCurrent(compactionRun.id);
    expect(compactionEpoch?.resetReason).toBe("COMPACTION_COMMITTED");
    expect(compactionSurface.records?.map(({ kind }) => kind)).toEqual(["BASELINE"]);
    expect(
      (await composition.contextUsage.getContextUsage(String(compactionRun.id)))?.compactionCount,
    ).toBe(1);
    const compactionProviderRecords = await storage.providerInvocationUsage.listByRun(
      compactionRun.id,
    );
    expect(compactionProviderRecords).toHaveLength(0);
    expect(provider.requests).toHaveLength(crossRunRequestIndex + 2);

    const compactionSegments = {
      preCompactionMainCalls:
        preCompactionMainRecords.length +
        crossRunUsage.filter(({ purpose }) => purpose === "MAIN_AGENT").length,
      compactionProviderCalls: compactionProviderRecords.length,
      postCompactionMainCalls: 0,
      postCompactionVerificationCalls: 0,
      crossRunMainCalls: crossRunUsage.filter(({ purpose }) => purpose === "MAIN_AGENT").length,
      crossRunVerificationCalls: crossRunUsage.filter(
        ({ purpose }) => purpose === "VERIFICATION_LLM",
      ).length,
      checkpoints:
        (await storage.contextCheckpointsV2.getLatestByRun(compactionRun.id)) === undefined ? 0 : 1,
      resetReason: compactionEpoch?.resetReason,
    };
    expect(compactionSegments).toMatchObject({
      preCompactionMainCalls: 11,
      compactionProviderCalls: 0,
      postCompactionMainCalls: 0,
      postCompactionVerificationCalls: 0,
      crossRunMainCalls: 1,
      crossRunVerificationCalls: 1,
      checkpoints: 1,
      resetReason: "COMPACTION_COMMITTED",
    });
    const safePublicJson = JSON.stringify({
      publicEvents,
      transcript: conversation.turns
        .flatMap((turn) => turn.messages)
        .flatMap((message) => composition!.transcriptProjectors.project(message)),
      recovered,
      crossRunResult,
      compactionEpoch,
    });
    expect(safePublicJson).not.toContain(FIXTURE_REASONING_PREFIX);
    expect(safePublicJson).not.toContain("fixture-only");
    expect(safePublicJson).not.toContain(patchText);
  }, 90_000);
});
