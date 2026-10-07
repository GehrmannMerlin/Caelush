import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAISubsystem,
  type AIMessage,
  type AIProviderBinding,
  type AIModelRequest,
  type AIToolSpec,
  type ModelDescriptor,
} from "@caelush/ai";
import { createOpenAICompatibleApiAdapter } from "@caelush/ai/adapters/openai-compatible";

import {
  STAGE7_LIMITS,
  createIrreversibleFingerprint,
  createRequestStartPacer,
  createStage7AuditRequests,
  getAuditArtifactNames,
  createAuditCheckpoint,
  acquireAuditAttemptLock,
  getDeepSeekPricingPeriod,
  pathExists,
  getRotatedDeepSeekCredentialStatus,
  runAuditRequests,
  writeAuditReportAtomic,
  writeAuditCheckpointAtomic,
} from "../../../scripts/deepseek-prompt-cache-audit.mjs";
import { createCuratedModelDescriptorSources } from "../src/providers/curated-model-metadata.js";
import {
  listBuiltinProviderPresets,
  toProviderPresetBinding,
} from "../src/providers/provider-presets.js";
import type { RuntimeProviderCredentialAuthority } from "../src/providers/credential-authority.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  sendRateLimit,
} from "./support/controllable-provider-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function usage(
  input: {
    readonly inputTokens?: number;
    readonly hitTokens?: number;
    readonly missTokens?: number;
    readonly outputTokens?: number;
    readonly writeTokens?: number;
  } = {},
) {
  const hitTokens = input.hitTokens ?? 95;
  const missTokens = input.missTokens ?? 5;
  return {
    inputTokens: input.inputTokens ?? hitTokens + missTokens,
    hitTokens,
    missTokens,
    writeTokens: input.writeTokens ?? 0,
    outputTokens: input.outputTokens ?? 1,
  };
}

function request(
  index: number,
  purpose: string = "MAIN_AGENT",
  overrides: Record<string, unknown> = {},
) {
  return {
    purpose,
    request: {
      prompt: `DO_NOT_EMIT_PROMPT_${index}`,
      toolArguments: `DO_NOT_EMIT_ARGUMENTS_${index}`,
      credential: `DO_NOT_EMIT_CREDENTIAL_${index}`,
      endpoint: `DO_NOT_EMIT_ENDPOINT_${index}`,
      providerResponseBody: `DO_NOT_EMIT_RESPONSE_${index}`,
      ...overrides,
    },
    eligible: true,
    expectedReusablePrefixTokens: 100,
    expectedReusablePrefixSource: "FIXTURE_EXACT",
    expectedReusablePrefixFingerprint: "a".repeat(64),
    epochId: "stage7-test-epoch-a",
    snapshotIdentityFingerprint: `snapshot-${index}`,
  };
}

function fakeDriver(
  outcomes: readonly Record<string, unknown>[] = [],
  options: { readonly extraCalls?: ReadonlyMap<number, number> } = {},
) {
  const calls: Array<{ index: number; purpose: string }> = [];
  let providerCallCount = 0;
  return {
    calls,
    getObservedProviderCallCount: () => providerCallCount,
    async prepare(entry: ReturnType<typeof request>, index: number) {
      return {
        callId: `fixture-call-${index + 1}`,
        prefixFingerprint: entry.expectedReusablePrefixFingerprint,
        epochId: entry.epochId,
        resetReason: entry.resetReason,
        async dispatch() {
          calls.push({ index, purpose: entry.purpose });
          providerCallCount += options.extraCalls?.get(index) ?? 1;
          return {
            success: true,
            usage: usage(),
            latencyMs: 5,
            assistantText: `DO_NOT_EMIT_ASSISTANT_${index}`,
            ...outcomes[index],
          };
        },
      };
    },
  };
}

async function checkpointPath() {
  const directory = await mkdtemp(join(tmpdir(), "caelush-stage7-fixture-"));
  temporaryDirectories.push(directory);
  return join(directory, "deepseek-42-turn-fixture.checkpoint.json");
}

const STAGE7_MODE = process.env.CAELUSH_PROMPT_CACHE_AUDIT_MODE;
const STAGE7_RUN_ID = process.env.CAELUSH_PROMPT_CACHE_AUDIT_RUN_ID ?? "optimization-1";
const STAGE7_ARTIFACT_NAMES = getAuditArtifactNames(STAGE7_RUN_ID);
const PAID_DISPATCH_TOKEN = process.env.CAELUSH_PROMPT_CACHE_AUDIT_DISPATCH_TOKEN;
const APPROVED_NOTES_DIRECTORY = String.raw`D:\Develop\Caelush-work-notes\prompt-cache-97`;
const HAS_PAID_DISPATCH_TOKEN =
  typeof PAID_DISPATCH_TOKEN === "string" && /^[a-f0-9-]{36}$/iu.test(PAID_DISPATCH_TOKEN);
const STABLE_HEAD = Array.from(
  { length: 160 },
  (_, index) =>
    "始终遵守稳定上下文规则：保护用户数据与凭据，遵循既有项目约定，回答当前任务，不泄露内部信息。规则编号：" +
    String(index + 1).padStart(3, "0"),
).join("\n");
const STAGE7_TOOL: AIToolSpec = {
  name: "record_audit_note",
  description: "记录一条简短的审计状态，不执行外部操作。",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: ["ok"] } },
    required: ["status"],
    additionalProperties: false,
  },
};
const STAGE7_SETTINGS = Object.freeze({
  temperature: 0,
  maxOutputTokens: 64,
  reasoning: { level: "XHIGH" as const },
  cache: { retention: "SHORT" as const },
});
const REAL_PROVIDER_MINIMUM_REQUEST_INTERVAL_MS = 2_000;

function deepSeekPreset() {
  const preset = listBuiltinProviderPresets().find((entry) => entry.id === "deepseek");
  if (preset === undefined) throw new Error("DeepSeek preset is unavailable.");
  return preset;
}

function createCredentialAuthority(
  resolveApiKey: () => string,
): RuntimeProviderCredentialAuthority {
  return {
    async describe(providerId) {
      return { providerId, configured: true, source: "ENVIRONMENT", writable: false };
    },
    async resolve(providerId) {
      if (providerId !== "deepseek") throw new Error("Unexpected provider binding.");
      const apiKey = resolveApiKey();
      if (apiKey.trim().length === 0) throw new Error("Provider credential is missing.");
      return { apiKey };
    },
    async set(providerId) {
      return { providerId, configured: true, source: "ENVIRONMENT", writable: false };
    },
    async unset() {},
  };
}

function createDeepSeekGatewayDriver(options: {
  readonly endpoint?: string;
  readonly resolveApiKey: () => string;
}) {
  let observedProviderCallCount = 0;
  let latestHttpStatus: number | null = null;
  const requestStartPacer = createRequestStartPacer({
    minimumIntervalMs:
      options.endpoint === undefined ? REAL_PROVIDER_MINIMUM_REQUEST_INTERVAL_MS : 0,
  });
  const preset = deepSeekPreset();
  const sources = createCuratedModelDescriptorSources([preset]);
  const model = sources.curated.resolve({ provider: "deepseek", model: "deepseek-flash" });
  if (model === undefined) throw new Error("Curated DeepSeek Flash descriptor is unavailable.");

  const countedFetch: typeof fetch = async (input, init) => {
    observedProviderCallCount += 1;
    latestHttpStatus = null;
    const response = await globalThis.fetch(input, init);
    latestHttpStatus = response.status;
    return response;
  };
  const productionBinding = toProviderPresetBinding(
    preset,
    createCredentialAuthority(options.resolveApiKey),
  );
  const provider: AIProviderBinding = {
    ...productionBinding,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    transport: { fetch: countedFetch },
  };
  const ai = createAISubsystem({
    modelSources: [sources.curated],
    providers: [provider],
    adapters: [createOpenAICompatibleApiAdapter()],
    defaultTimeoutMs: 60_000,
  });

  return {
    model,
    ai,
    getObservedProviderCallCount: () => observedProviderCallCount,
    async prepare(entry: ReturnType<typeof createStage7AuditRequests>[number]) {
      await requestStartPacer.waitForNextStart();
      latestHttpStatus = null;
      const startedAt = Date.now();
      const stream = await ai.gateway.stream(entry.request);
      return {
        callId: stream.callId,
        prefixFingerprint: entry.expectedReusablePrefixFingerprint,
        epochId: entry.epochId,
        resetReason: entry.resetReason,
        async dispatch() {
          let finalUsage:
            | {
                readonly inputTokens?: number;
                readonly cachedInputTokens?: number;
                readonly cacheMissInputTokens?: number;
                readonly cacheWriteInputTokens?: number;
                readonly outputTokens?: number;
              }
            | undefined;
          let succeeded = false;
          try {
            for await (const event of stream.events) {
              if (event.type === "stream.finish") {
                finalUsage = event.payload.finalUsage;
                succeeded = true;
              } else if (event.type === "stream.error") {
                succeeded = false;
              }
            }
          } catch {
            succeeded = false;
          }
          return {
            success: succeeded,
            usage:
              finalUsage === undefined
                ? undefined
                : {
                    inputTokens: finalUsage.inputTokens,
                    hitTokens: finalUsage.cachedInputTokens,
                    missTokens: finalUsage.cacheMissInputTokens,
                    writeTokens: finalUsage.cacheWriteInputTokens ?? 0,
                    outputTokens: finalUsage.outputTokens,
                  },
            httpStatus: latestHttpStatus,
            latencyMs: Date.now() - startedAt,
          };
        },
      };
    },
  };
}

function stage7ConfigurationFingerprint(model: ModelDescriptor): string {
  const stableHeadFingerprint = createIrreversibleFingerprint(STABLE_HEAD);
  const toolFingerprint = createIrreversibleFingerprint(STAGE7_TOOL);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  return createIrreversibleFingerprint({
    provider: "deepseek",
    model: model.ref,
    endpoint: deepSeekPreset().endpoint,
    stableHeadFingerprint,
    toolFingerprint,
    settings: STAGE7_SETTINGS,
    stableHeadCommit: head,
    metricPolicyVersion: 2,
    prefixCalibrationVersion: 1,
    snapshotAccountingVersion: 1,
    requestStartPacingVersion: 1,
    minimumProviderRequestIntervalMs: REAL_PROVIDER_MINIMUM_REQUEST_INTERVAL_MS,
  });
}

export function createStage7AuditRequests(
  model: ModelDescriptor,
  mode: "probe" | "run-42",
  configurationFingerprint: string,
) {
  const expectedReusablePrefixFingerprint = createIrreversibleFingerprint({
    stableHead: createIrreversibleFingerprint(STABLE_HEAD),
    toolCatalog: createIrreversibleFingerprint(STAGE7_TOOL),
    model: model.ref,
    cache: STAGE7_SETTINGS.cache,
  });
  const count = mode === "probe" ? 3 : 42;
  return Array.from({ length: count }, (_, index) => {
    const purpose = mode === "probe" || index < 2 ? "WARMUP" : "MAIN_AGENT";
    const messages: readonly AIMessage[] = [
      { role: "system", content: STABLE_HEAD },
      { role: "user", content: "请简短确认审计回合 " + String(index + 1) + "。" },
    ];
    const request: AIModelRequest = {
      model: model.ref,
      messages,
      tools: [STAGE7_TOOL],
      settings: STAGE7_SETTINGS,
    };
    return {
      purpose,
      request,
      eligible: purpose === "MAIN_AGENT",
      expectedReusablePrefixFingerprint,
      epochId: "stage-7-" + configurationFingerprint,
      resetReason: index === 0 ? "INITIAL" : undefined,
    };
  });
}

describe("DeepSeek Stage 7 local audit harness", () => {
  it("keeps the exact main-call and total-call caps and does not dispatch the over-limit call", async () => {
    const mainCalls = fakeDriver();
    const mainRun = await runAuditRequests({
      mode: "run-42",
      requests: Array.from({ length: 43 }, (_, index) => request(index)),
      driver: mainCalls,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 40,
    });

    expect(mainCalls.calls).toHaveLength(42);
    expect(mainRun.report.mainCallCount).toBe(42);
    expect(mainRun.report.providerCallCount).toBe(42);
    expect(mainRun.report.abortReason).toBe("MAIN_CALL_LIMIT");
    expect(STAGE7_LIMITS.maxMainCalls).toBe(42);

    const totalCalls = fakeDriver();
    const mixedRequests = [
      ...Array.from({ length: 42 }, (_, index) => request(index)),
      ...Array.from({ length: 7 }, (_, index) => request(index + 42, "RETRY")),
    ];
    const totalRun = await runAuditRequests({
      mode: "run-42",
      requests: mixedRequests,
      driver: totalCalls,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 40,
    });

    expect(totalCalls.calls).toHaveLength(48);
    expect(totalRun.report.providerCallCount).toBe(48);
    expect(totalRun.report.abortReason).toBe("TOTAL_CALL_LIMIT");
    expect(STAGE7_LIMITS.maxProviderCalls).toBe(48);
  });

  it("opens the miss-token fuse immediately after settled scored usage exceeds 500,000", async () => {
    const driver = fakeDriver([
      { usage: usage({ inputTokens: 500_001, hitTokens: 0, missTokens: 500_001 }) },
    ]);
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [request(0)],
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(result.report.scoredMissTokens).toBe(500_001);
    expect(result.report.abortReason).toBe("SCORED_MISS_LIMIT");
    expect(driver.calls).toHaveLength(1);
  });

  it("opens the output-token fuse immediately after settled usage exceeds 25,000", async () => {
    const driver = fakeDriver([
      { usage: usage({ outputTokens: 25_001 }) },
      { usage: usage({ outputTokens: 25_001 }) },
    ]);
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [request(0, "WARMUP"), request(1)],
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(result.report.totalOutputTokens).toBe(25_001);
    expect(result.report.abortReason).toBe("OUTPUT_TOKEN_LIMIT");
    expect(driver.calls).toHaveLength(1);
  });

  it("counts incomplete usage as unknown and stops before another provider call", async () => {
    const driver = fakeDriver([
      { usage: { inputTokens: 100, missTokens: 100, outputTokens: 1 } },
      { usage: usage() },
    ]);
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [request(0), request(1)],
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 2,
    });

    expect(result.report.unknownUsageCount).toBe(1);
    expect(result.report.abortReason).toBe("UNKNOWN_USAGE");
    expect(driver.calls).toHaveLength(1);
  });

  it("stops on the second consecutive unexplained epoch reset", async () => {
    const requests = [
      { ...request(0, "WARMUP"), epochId: "epoch-a", resetReason: "INITIAL" },
      { ...request(1), epochId: "epoch-b" },
      { ...request(2), epochId: "epoch-c" },
      request(3),
    ];
    const driver = fakeDriver();
    const result = await runAuditRequests({
      mode: "run-42",
      requests,
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 3,
    });

    expect(result.report.unexplainedResetCount).toBe(2);
    expect(result.report.consecutiveUnexplainedResetCount).toBe(2);
    expect(result.report.abortReason).toBe("CONSECUTIVE_UNEXPLAINED_RESET");
    expect(driver.calls).toHaveLength(3);
  });

  it("scores only successful MAIN_AGENT turns and keeps warm-up, retry, and title calls in totals", async () => {
    const requests = [
      request(0, "WARMUP"),
      request(1, "WARMUP"),
      ...Array.from({ length: 40 }, (_, index) => request(index + 2)),
      request(42, "RETRY"),
      request(43, "TITLE"),
    ];
    const driver = fakeDriver();
    const result = await runAuditRequests({
      mode: "run-42",
      requests,
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 40,
    });

    expect(result.report.scoredCount).toBe(40);
    expect(result.report.mainCallCount).toBe(42);
    expect(result.report.providerCallCount).toBe(44);
    expect(
      result.report.samples.filter((sample: { status: string }) => sample.status === "SCORED"),
    ).toHaveLength(40);
    expect(
      result.report.samples.filter((sample: { purpose: string }) => sample.purpose === "RETRY"),
    ).toHaveLength(1);
    expect(
      result.report.samples.filter((sample: { purpose: string }) => sample.purpose === "TITLE"),
    ).toHaveLength(1);
  });

  it("never passes the exit gate when the final completed turn trips a fuse", async () => {
    const outcomes = Array.from({ length: 42 }, () => ({
      usage: usage({ inputTokens: 100, hitTokens: 100, missTokens: 0, outputTokens: 1 }),
    }));
    outcomes[41] = {
      usage: usage({ inputTokens: 100, hitTokens: 100, missTokens: 0, outputTokens: 25_000 }),
    };
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [
        request(0, "WARMUP"),
        request(1, "WARMUP"),
        ...Array.from({ length: 40 }, (_, index) => request(index + 2)),
      ],
      driver: fakeDriver(outcomes),
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 40,
    });

    expect(result.report.completed).toBe(true);
    expect(result.report.abortReason).toBe("OUTPUT_TOKEN_LIMIT");
    expect(result.report.gates.A.passed).toBe(true);
    expect(result.report.gates.B.passed).toBe(true);
    expect(result.report.gates.C.passed).toBe(true);
    expect(result.report.exitGatePassed).toBe(false);
  });

  it("does not score a failed request and does not retry it automatically", async () => {
    const driver = fakeDriver([
      { success: false, usage: usage(), error: new Error("DO_NOT_EMIT_PROVIDER_ERROR") },
      { success: true, usage: usage() },
    ]);
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [request(0), request(1, "RETRY")],
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(result.report.scoredCount).toBe(0);
    expect(result.report.abortReason).toBe("PROVIDER_REQUEST_FAILED");
    expect(driver.calls).toHaveLength(1);
    expect(JSON.stringify(result.report)).not.toContain("DO_NOT_EMIT_PROVIDER_ERROR");
  });

  it("detects a hidden transport request beyond the identified gateway call", async () => {
    const driver = fakeDriver([], { extraCalls: new Map([[0, 2]]) });
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [request(0), request(1)],
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 2,
    });

    expect(result.report.providerCallCount).toBe(2);
    expect(result.report.hiddenCallCount).toBe(1);
    expect(result.report.abortReason).toBe("HIDDEN_PROVIDER_CALL");
    expect(driver.calls).toHaveLength(1);
  });

  it("runs exactly three probe requests and requires a later non-zero hit", async () => {
    const driver = fakeDriver([
      { usage: usage({ hitTokens: 0, missTokens: 100 }) },
      { usage: usage({ hitTokens: 0, missTokens: 100 }) },
      { usage: usage({ hitTokens: 70, missTokens: 30 }) },
      { usage: usage() },
    ]);
    const result = await runAuditRequests({
      mode: "probe",
      requests: Array.from({ length: 3 }, (_, index) => request(index, "WARMUP")),
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 0,
    });

    expect(driver.calls).toHaveLength(3);
    expect(result.report.providerCallCount).toBe(3);
    expect(result.report.probeStatus).toBe("PASS");
  });

  it("marks the probe failed when all three complete usage snapshots report zero hits", async () => {
    const driver = fakeDriver(
      Array.from({ length: 3 }, () => ({ usage: usage({ hitTokens: 0, missTokens: 100 }) })),
    );
    const result = await runAuditRequests({
      mode: "probe",
      requests: Array.from({ length: 3 }, (_, index) => request(index, "WARMUP")),
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 0,
    });

    expect(result.report.probeStatus).toBe("PROBE_FAILED");
    expect(result.report.abortReason).toBe("PROBE_NO_CACHE_HIT");
    expect(driver.calls).toHaveLength(3);
  });

  it("keeps unknown miss accounting separate from the immediate usage fuse", async () => {
    const driver = fakeDriver([
      { usage: usage({ inputTokens: 100, hitTokens: 0, missTokens: 100 }) },
    ]);
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [request(0)],
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(result.report.abortReason).toBeNull();
    expect(result.report.unknownMissTokens).toBe(100);
    expect(result.report.gates.C.passed).toBe(false);
  });

  it("calibrates reusable prefix from warm-up usage instead of a larger heuristic estimate", async () => {
    const measuredUsage = usage({
      inputTokens: 5_437,
      hitTokens: 5_248,
      missTokens: 189,
      outputTokens: 64,
    });
    const requests = [
      { ...request(0, "WARMUP"), expectedReusablePrefixTokens: null },
      { ...request(1, "WARMUP"), expectedReusablePrefixTokens: null },
      {
        ...request(2),
        expectedReusablePrefixTokens: 8_373,
        expectedReusablePrefixSource: "HEURISTIC_ESTIMATE",
      },
      {
        ...request(3),
        expectedReusablePrefixTokens: 8_373,
        expectedReusablePrefixSource: "HEURISTIC_ESTIMATE",
      },
    ];
    const result = await runAuditRequests({
      mode: "run-42",
      requests,
      driver: fakeDriver(requests.map(() => ({ usage: measuredUsage }))),
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 2,
    });

    expect(result.report.warmPrefixCalibration).toMatchObject({
      source: "MEASURED_WARMUP",
      baselineTokens: 5_248,
      valid: true,
    });
    expect(result.report.reusablePrefixEfficiencyRaw).toEqual({
      numerator: 10_496,
      denominator: 10_496,
      value: 1,
    });
    expect(result.report.unexplainedCacheMissTokens).toBe(0);
    expect(result.report.gates.A.targetMet).toBe(false);
    expect(result.report.gates.A.nearTargetMet).toBe(true);
    expect(result.report.gates.B.passed).toBe(true);
    expect(result.report.gates.C.passed).toBe(true);
  });

  it("marks unstable warm-up calibration invalid instead of choosing the better hit sample", async () => {
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [
        { ...request(0, "WARMUP"), expectedReusablePrefixTokens: null },
        { ...request(1, "WARMUP"), expectedReusablePrefixTokens: null },
        { ...request(2), expectedReusablePrefixTokens: null },
      ],
      driver: fakeDriver([
        { usage: usage({ inputTokens: 5_437, hitTokens: 5_248, missTokens: 189 }) },
        { usage: usage({ inputTokens: 5_437, hitTokens: 5_120, missTokens: 317 }) },
        { usage: usage({ inputTokens: 5_437, hitTokens: 5_248, missTokens: 189 }) },
      ]),
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(result.report.warmPrefixCalibration).toMatchObject({
      source: "MEASURED_WARMUP",
      valid: false,
    });
    expect(result.report.calibrationInvalidCount).toBe(1);
    expect(result.report.reusablePrefixEfficiency).toBe("UNREPORTED");
    expect(result.report.unexplainedCacheMissTokens).toBe("UNREPORTED");
    expect(result.report.gates.B.passed).toBe(false);
    expect(result.report.gates.C.passed).toBe(false);
  });

  it("preserves the unrounded 97/100 billing gate boundary", async () => {
    const driver = fakeDriver([
      { usage: usage({ inputTokens: 100, hitTokens: 97, missTokens: 3 }) },
    ]);
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [{ ...request(0), expectedReusablePrefixTokens: 97 }],
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(result.report.billingHitRateRaw).toEqual({
      numerator: 97,
      denominator: 100,
      value: 0.97,
    });
    expect(result.report.reusablePrefixEfficiencyRaw).toEqual({
      numerator: 97,
      denominator: 97,
      value: 1,
    });
    expect(result.report.gates.A.passed).toBe(true);
    expect(result.report.gates.A.targetMet).toBe(true);
    expect(result.report.costSummary).toMatchObject({
      totalCostNanoDollars: "1341",
      totalCostUsd: "0.000001341",
      reconciled: true,
    });
  });

  it("requires billing hit rate to be strictly greater than 90 percent", async () => {
    const atFloor = await runAuditRequests({
      mode: "run-42",
      requests: [{ ...request(0), expectedReusablePrefixTokens: 90 }],
      driver: fakeDriver([{ usage: usage({ inputTokens: 100, hitTokens: 90, missTokens: 10 }) }]),
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });
    const aboveFloor = await runAuditRequests({
      mode: "run-42",
      requests: [{ ...request(0), expectedReusablePrefixTokens: 91 }],
      driver: fakeDriver([{ usage: usage({ inputTokens: 100, hitTokens: 91, missTokens: 9 }) }]),
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(atFloor.report.gates.A.passed).toBe(false);
    expect(atFloor.report.gates.A.targetMet).toBe(false);
    expect(aboveFloor.report.gates.A.passed).toBe(true);
    expect(aboveFloor.report.gates.A.targetMet).toBe(false);
    expect(aboveFloor.report.gates.A.nearTargetMet).toBe(false);
  });

  it("preserves exact aggregate token totals beyond JavaScript's safe integer range", async () => {
    const nearMaximum = Number.MAX_SAFE_INTEGER;
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [
        { ...request(0), expectedReusablePrefixTokens: nearMaximum },
        { ...request(1), expectedReusablePrefixTokens: nearMaximum },
      ],
      driver: fakeDriver([
        {
          usage: usage({
            inputTokens: nearMaximum,
            hitTokens: nearMaximum,
            missTokens: 0,
            outputTokens: 0,
          }),
        },
        {
          usage: usage({
            inputTokens: nearMaximum,
            hitTokens: nearMaximum,
            missTokens: 0,
            outputTokens: 0,
          }),
        },
      ]),
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 2,
    });

    expect(result.report.billingHitRateRaw).toEqual({
      numerator: "18014398509481982",
      denominator: "18014398509481982",
      value: 1,
    });
    expect(result.report.reusablePrefixEfficiencyRaw).toEqual({
      numerator: "18014398509481982",
      denominator: "18014398509481982",
      value: 1,
    });
    expect(result.report.totalInputTokens).toBe("18014398509481982");
    expect(result.report.totalHitTokens).toBe("18014398509481982");
  });

  it("detects duplicate runtime snapshot identity without exposing its fingerprint source", async () => {
    const driver = fakeDriver();
    const requests = [
      { ...request(0, "WARMUP"), snapshotIdentityFingerprint: "b".repeat(64) },
      { ...request(1, "MAIN_AGENT"), snapshotIdentityFingerprint: "b".repeat(64) },
    ];
    const result = await runAuditRequests({
      mode: "run-42",
      requests,
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(result.report.duplicateSnapshotCount).toBe(1);
    expect(result.report.gates.C.passed).toBe(false);
  });

  it("does not count absent optional snapshot identities as duplicates", async () => {
    const result = await runAuditRequests({
      mode: "local-fixture",
      requests: Array.from({ length: 3 }, (_, index) => ({
        ...request(index),
        snapshotIdentityFingerprint: undefined,
      })),
      driver: fakeDriver(),
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 3,
    });

    expect(result.report.duplicateSnapshotCount).toBe(0);
  });

  it("writes sanitized checkpoints atomically and resumes after settled calls without replay", async () => {
    const path = await checkpointPath();
    const driver = fakeDriver();
    const requests = [request(0), request(1)];
    const first = await runAuditRequests({
      mode: "run-42",
      requests,
      driver,
      checkpointPath: path,
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 2,
      maxRequestsThisInvocation: 1,
    });
    const persisted = await readFile(path, "utf8");

    expect(first.report.resumable).toBe(true);
    expect(persisted).not.toContain("DO_NOT_EMIT");
    expect(persisted).not.toContain("assistantText");
    expect(persisted).not.toContain("providerResponseBody");

    const resumed = await runAuditRequests({
      mode: "run-42",
      requests,
      driver,
      checkpointPath: path,
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 2,
    });

    expect(driver.calls.map(({ index }) => index)).toEqual([0, 1]);
    expect(resumed.report.providerCallCount).toBe(2);
    expect(resumed.report.completed).toBe(true);
  });

  it("reserves the shared paid-attempt lock exclusively and releases only its own reservation", async () => {
    const path = (await checkpointPath()) + ".attempt.lock";
    const firstReservation = await acquireAuditAttemptLock(path);
    expect(firstReservation).toMatchObject({ identity: expect.any(String) });

    const concurrentReservation = await acquireAuditAttemptLock(path);
    expect(concurrentReservation).toBeNull();

    await firstReservation?.release();
    const nextReservation = await acquireAuditAttemptLock(path);
    expect(nextReservation).not.toBeNull();
    await nextReservation?.release();
  });

  it("does not replay an unresolved in-flight request after interruption", async () => {
    const path = await checkpointPath();
    const checkpoint = createAuditCheckpoint({
      mode: "run-42",
      configurationFingerprint: "c".repeat(64),
      pricingPeriod: "OFF_PEAK",
      requestCount: 1,
    });
    checkpoint.inFlight = {
      callId: "fixture-call-in-flight",
      purpose: "MAIN_AGENT",
      prefixFingerprint: "d".repeat(64),
      requestIndex: 0,
    };
    await writeAuditCheckpointAtomic(path, checkpoint);
    const driver = fakeDriver();
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [request(0)],
      driver,
      checkpointPath: path,
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
      configurationFingerprint: "c".repeat(64),
    });

    expect(result.report.abortReason).toBe("IN_FLIGHT_REQUEST_NOT_RESENT");
    expect(driver.calls).toHaveLength(0);
  });

  it("keeps reports free of prompts, arguments, credentials, endpoints, provider bodies, and assistant output", async () => {
    const driver = fakeDriver();
    const result = await runAuditRequests({
      mode: "local-fixture",
      requests: [request(0)],
      driver,
      checkpointPath: await checkpointPath(),
      pricingPeriod: "OFF_PEAK",
      expectedScoredCount: 1,
    });
    const serialized = JSON.stringify(result.report);

    expect(serialized).not.toContain("DO_NOT_EMIT");
    expect(serialized).not.toContain("assistantText");
    expect(serialized).not.toContain("providerResponseBody");
    expect(serialized).not.toContain("fixture-call-1");
    expect(result.report.samples[0]).toMatchObject({ purpose: "MAIN_AGENT", status: "SCORED" });
  });

  it("uses presence-only status for the approved rotated runtime credential", () => {
    expect(getRotatedDeepSeekCredentialStatus({})).toBe("MISSING");
    expect(
      getRotatedDeepSeekCredentialStatus({
        CAELUSH_PROVIDER_ID: "deepseek",
        CAELUSH_PROVIDER_API_KEY: "configured-only-for-presence-test",
      }),
    ).toBe("PRESENT");
    expect(
      getRotatedDeepSeekCredentialStatus({
        CAELUSH_PROVIDER_ID: "openai",
        CAELUSH_PROVIDER_API_KEY: "configured-only-for-presence-test",
      }),
    ).toBe("MISSING");
  });

  it("fails closed when an artifact path cannot be inspected", async () => {
    const blockedParentPath = await checkpointPath();
    expect(await pathExists(join(blockedParentPath, "..", "missing.json"))).toBe(false);

    await expect(pathExists(blockedParentPath + "\u0000invalid")).rejects.toThrow(
      "Audit artifact path could not be inspected safely.",
    );
  });

  it("prices by the verified UTC schedule and fails closed outside its year", () => {
    expect(getDeepSeekPricingPeriod(new Date("2026-10-06T02:00:00.000Z"))).toBe("OFF_PEAK");
    expect(getDeepSeekPricingPeriod(new Date("2026-02-02T02:00:00.000Z"))).toBe("PEAK");
    expect(getDeepSeekPricingPeriod(new Date("2027-01-03T02:00:00.000Z"))).toBe("UNVERIFIED");
  });

  it("allocates separate path-safe artifacts for each paid audit iteration", () => {
    expect(getAuditArtifactNames("optimization-2")).toEqual({
      probe: "deepseek-probe-stage-7-optimization-2.json",
      probeCheckpoint: "deepseek-probe-stage-7-optimization-2.checkpoint.json",
      run42: "deepseek-42-turn-stage-7-optimization-2.json",
      run42Checkpoint: "deepseek-42-turn-stage-7-optimization-2.checkpoint.json",
    });
    expect(() => getAuditArtifactNames("../overwrite-stage-7.json")).toThrow(
      "Audit run identifier is invalid.",
    );
  });

  it("allows AUTO pricing checkpoints and records each call's resolved price period", async () => {
    const path = await checkpointPath();
    const result = await runAuditRequests({
      mode: "run-42",
      requests: [request(0)],
      driver: fakeDriver(),
      checkpointPath: path,
      pricingPeriod: () => "OFF_PEAK",
      expectedScoredCount: 1,
    });

    expect(result.report.samples[0]?.pricePeriod).toBe("OFF_PEAK");
    expect(JSON.parse(await readFile(path, "utf8")).pricingPeriod).toBe("AUTO");
  });

  it("runs the Caelush AI Gateway and OpenAI-compatible adapter against a loopback provider", async () => {
    const savedCheckpointPath = await checkpointPath();
    const requestHadDurableIntent: boolean[] = [];
    const server = await createControllableProviderServer(async (captured, response) => {
      const checkpoint = JSON.parse(await readFile(savedCheckpointPath, "utf8")) as {
        readonly inFlight: unknown;
        readonly nextRequestIndex: number;
      };
      requestHadDurableIntent.push(
        checkpoint.inFlight !== null && checkpoint.nextRequestIndex === captured.index,
      );
      const inputTokens = 12_000;
      const hitTokens = captured.index === 0 ? 0 : 11_776;
      const missTokens = inputTokens - hitTokens;
      beginOpenAISse(response);
      response.write(
        "data: " +
          JSON.stringify({
            id: "loopback-stage7",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-flash",
            choices: [
              {
                index: 0,
                delta: { content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: inputTokens,
              prompt_tokens_details: { cached_tokens: hitTokens },
              prompt_cache_hit_tokens: hitTokens,
              prompt_cache_miss_tokens: missTokens,
              completion_tokens: 2,
              total_tokens: inputTokens + 2,
            },
          }) +
          "\n\n",
      );
      response.end("data: [DONE]\n\n");
    });
    try {
      const driver = createDeepSeekGatewayDriver({
        endpoint: server.endpoint + "/v1",
        resolveApiKey: () => "offline-loopback-placeholder",
      });
      const configurationFingerprint = stage7ConfigurationFingerprint(driver.model);
      const requests = createStage7AuditRequests(driver.model, "probe", configurationFingerprint);
      const result = await runAuditRequests({
        mode: "probe",
        requests,
        driver,
        checkpointPath: savedCheckpointPath,
        pricingPeriod: "OFF_PEAK",
        expectedScoredCount: 0,
        configurationFingerprint,
      });

      expect(server.requests).toHaveLength(3);
      expect(requestHadDurableIntent).toEqual([true, true, true]);
      expect(server.requests.every((entry) => entry.path === "/v1/chat/completions")).toBe(true);
      const firstBody = server.requests[0]?.body;
      const secondBody = server.requests[1]?.body;
      if (firstBody === undefined || secondBody === undefined) {
        throw new Error("The loopback provider did not capture complete requests.");
      }
      expect(firstBody["messages"]).toMatchObject([
        { role: "system", content: STABLE_HEAD },
        { role: "user" },
      ]);
      expect(firstBody["tools"]).toEqual(secondBody["tools"]);
      expect(result.report.probeStatus).toBe("PASS");
      expect(result.report.providerCallCount).toBe(3);
      expect(result.report.samples[0]).toMatchObject({
        purpose: "WARMUP",
        inputTokens: 12_000,
        hitTokens: 0,
        missTokens: 12_000,
      });
      expect(result.report.samples[1]).toMatchObject({ hitTokens: 11_776, cacheStatus: "HIT" });
      expect(JSON.stringify(result.report)).not.toContain(STABLE_HEAD);
      expect(JSON.stringify(result.report)).not.toContain("offline-loopback-placeholder");
    } finally {
      await server.close();
    }
  });

  it("does not treat benchmark turns as runtime snapshots or score heuristic prefixes", () => {
    const driver = createDeepSeekGatewayDriver({ resolveApiKey: () => "" });
    const requests = createStage7AuditRequests(driver.model, "run-42", "c".repeat(64));

    expect(requests).toHaveLength(42);
    expect(requests.every((entry) => entry.expectedReusablePrefixTokens === undefined)).toBe(true);
    expect(requests.every((entry) => entry.snapshotIdentityFingerprint === undefined)).toBe(true);
    expect(
      new Set(
        requests.map((entry) => {
          const messages = entry.request.messages;
          return messages[messages.length - 1]?.role === "user"
            ? messages[messages.length - 1]?.content
            : undefined;
        }),
      ).size,
    ).toBe(42);
  });

  it("records only the safe HTTP status class when a provider rejects a request", async () => {
    const server = await createControllableProviderServer((_captured, response) => {
      sendRateLimit(response, "1");
    });
    try {
      const driver = createDeepSeekGatewayDriver({
        endpoint: server.endpoint + "/v1",
        resolveApiKey: () => "offline-loopback-placeholder",
      });
      const configurationFingerprint = stage7ConfigurationFingerprint(driver.model);
      const planned = createStage7AuditRequests(
        driver.model,
        "run-42",
        configurationFingerprint,
      )[0];
      if (planned === undefined) throw new Error("The loopback request fixture is missing.");
      const savedCheckpointPath = await checkpointPath();
      const result = await runAuditRequests({
        mode: "run-42",
        requests: [planned],
        driver,
        checkpointPath: savedCheckpointPath,
        pricingPeriod: "OFF_PEAK",
        expectedScoredCount: 0,
        configurationFingerprint,
      });

      expect(result.report.samples[0]).toMatchObject({
        success: false,
        httpStatus: 429,
        failureClass: "RATE_LIMITED",
      });
      expect(result.report.abortReason).toBe("UNKNOWN_USAGE");
      expect(result.report.costSummary.unpricedCallCount).toBe(1);
      expect(JSON.stringify(result.report)).not.toContain("fixture rate limit");
      expect(JSON.stringify(result.report)).not.toContain("retry-after");
      const savedCheckpoint = await readFile(savedCheckpointPath, "utf8");
      expect(JSON.parse(savedCheckpoint).samples[0]).toMatchObject({
        httpStatus: 429,
        failureClass: "RATE_LIMITED",
      });
      expect(savedCheckpoint).not.toContain("fixture rate limit");
    } finally {
      await server.close();
    }
  });

  it("paces provider request starts using elapsed time without delaying local fixtures", async () => {
    let now = 0;
    const waits: number[] = [];
    const pacer = createRequestStartPacer({
      minimumIntervalMs: 2_000,
      now: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });

    await pacer.waitForNextStart();
    now += 500;
    await pacer.waitForNextStart();
    now += 2_300;
    await pacer.waitForNextStart();

    expect(waits).toEqual([1_500]);
    expect(now).toBe(4_300);
  });

  it.skipIf(
    (STAGE7_MODE !== "probe" && STAGE7_MODE !== "run-42") ||
      getRotatedDeepSeekCredentialStatus(process.env) !== "PRESENT" ||
      !HAS_PAID_DISPATCH_TOKEN,
  )(
    "explicit paid audit mode",
    async () => {
      const mode = STAGE7_MODE;
      if (mode !== "probe" && mode !== "run-42") throw new Error("Paid audit mode is invalid.");
      const outputPath = process.env.CAELUSH_PROMPT_CACHE_AUDIT_OUTPUT_PATH;
      const checkpointPath = process.env.CAELUSH_PROMPT_CACHE_AUDIT_CHECKPOINT_PATH;
      if (outputPath === undefined || checkpointPath === undefined) {
        throw new Error("The external audit output paths are not configured.");
      }
      const expectedOutputPath = join(
        APPROVED_NOTES_DIRECTORY,
        mode === "probe" ? STAGE7_ARTIFACT_NAMES.probe : STAGE7_ARTIFACT_NAMES.run42,
      );
      const expectedCheckpointPath = join(
        APPROVED_NOTES_DIRECTORY,
        mode === "probe"
          ? STAGE7_ARTIFACT_NAMES.probeCheckpoint
          : STAGE7_ARTIFACT_NAMES.run42Checkpoint,
      );
      if (
        resolve(outputPath) !== resolve(expectedOutputPath) ||
        resolve(checkpointPath) !== resolve(expectedCheckpointPath)
      ) {
        throw new Error("Paid audit output paths are outside the approved artifact locations.");
      }
      const attemptLockPath = join(APPROVED_NOTES_DIRECTORY, "deepseek-stage-7-paid-attempt.lock");
      let attemptLock: { readonly identity?: string };
      try {
        attemptLock = JSON.parse(await readFile(attemptLockPath, "utf8")) as {
          readonly identity?: string;
        };
      } catch {
        throw new Error("Paid audit dispatch was not authorized by the Stage 7 runner.");
      }
      if (attemptLock.identity !== PAID_DISPATCH_TOKEN) {
        throw new Error("Paid audit dispatch was not authorized by the Stage 7 runner.");
      }

      const driver = createDeepSeekGatewayDriver({
        resolveApiKey: () => process.env.CAELUSH_PROVIDER_API_KEY ?? "",
      });
      const configurationFingerprint = stage7ConfigurationFingerprint(driver.model);
      if (
        mode === "run-42" &&
        process.env.CAELUSH_PROMPT_CACHE_PROBE_FINGERPRINT !== configurationFingerprint
      ) {
        throw new Error("The passed probe does not match the fixed audit configuration.");
      }
      if (mode === "run-42") {
        let probe: Record<string, unknown>;
        try {
          probe = JSON.parse(
            await readFile(join(APPROVED_NOTES_DIRECTORY, STAGE7_ARTIFACT_NAMES.probe), "utf8"),
          ) as Record<string, unknown>;
        } catch {
          throw new Error("The approved probe result is unavailable.");
        }
        if (
          probe["probeStatus"] !== "PASS" ||
          probe["providerCallCount"] !== 3 ||
          probe["configurationFingerprint"] !== configurationFingerprint
        ) {
          throw new Error("The approved three-request probe did not pass for this configuration.");
        }
      }

      const auditRequests = createStage7AuditRequests(driver.model, mode, configurationFingerprint);
      const result = await runAuditRequests({
        mode,
        requests: auditRequests,
        driver,
        checkpointPath,
        pricingPeriod: "AUTO",
        expectedScoredCount: mode === "probe" ? 0 : 40,
        configurationFingerprint,
        credentialStatus: "PRESENT",
      });
      const report = {
        ...result.report,
        availability: result.report.providerCallCount > 0 ? "AVAILABLE" : "UNAVAILABLE",
      };
      await writeAuditReportAtomic(outputPath, report);

      if (mode === "probe") {
        expect(report.providerCallCount).toBe(3);
        expect(report.probeStatus).toBe("PASS");
      } else {
        expect(report.exitGatePassed).toBe(true);
      }
    },
    60 * 60 * 1000,
  );
});
