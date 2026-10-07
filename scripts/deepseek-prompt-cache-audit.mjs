import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePromptCacheArtifactDirectory } from "./browser-smoke-artifact-path.mjs";
import { evaluatePromptCacheAudit } from "./prompt-cache-audit.mjs";

export const STAGE7_LIMITS = Object.freeze({
  maxMainCalls: 42,
  maxProviderCalls: 48,
  maxScoredMissTokens: 500_000,
  maxOutputTokens: 25_000,
  maxConsecutiveUnexplainedResets: 2,
});

export const STAGE7_PURPOSES = Object.freeze([
  "MAIN_AGENT",
  "WARMUP",
  "RETRY",
  "COMPACTION",
  "TITLE",
  "OTHER",
]);

const RESET_REASONS = new Set([
  "INITIAL",
  "MODEL_CHANGED",
  "TOOL_SCHEMA_CHANGED",
  "STABLE_HEAD_CHANGED",
  "CACHE_SETTINGS_CHANGED",
  "COMPACTION_COMMITTED",
  "RECOVERY_INCOMPATIBLE",
]);

const MODES = new Set(["local-fixture", "probe", "run-42"]);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const AUDIT_RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/i;
const SCORING_PURPOSES = new Set(["MAIN_AGENT", "WARMUP"]);
const NANO_DOLLARS_PER_DOLLAR = 1_000_000_000n;
const BILLING_HIT_RATE_FLOOR_PERCENT = 90n;
const BILLING_HIT_RATE_NEAR_TARGET_PERCENT = 95n;
const BILLING_HIT_RATE_TARGET_PERCENT = 97n;
const MAX_WARMUP_HIT_DRIFT_TOKENS = 64;
const EXPECTED_PREFIX_SOURCES = new Set(["FIXTURE_EXACT", "HEURISTIC_ESTIMATE"]);
const PROVIDER_FAILURE_CLASSES = new Set([
  "RATE_LIMITED",
  "PROVIDER_SERVER_ERROR",
  "PROVIDER_REJECTED",
  "STREAM_FAILED",
  "TRANSPORT_OR_STREAM_FAILURE",
]);

// Prices are USD per million tokens from DeepSeek's V4.1 Flash pricing card.
// A cache write is billed in the cache-miss input bucket and is not added twice.
const RATE_CARD = Object.freeze({
  OFF_PEAK: Object.freeze({
    hitNanoDollarsPerToken: 3n,
    missNanoDollarsPerToken: 150n,
    outputNanoDollarsPerToken: 600n,
  }),
  PEAK: Object.freeze({
    hitNanoDollarsPerToken: 6n,
    missNanoDollarsPerToken: 300n,
    outputNanoDollarsPerToken: 1_200n,
  }),
});

const CHINA_PUBLIC_HOLIDAYS_2026 = Object.freeze([
  ["2026-01-01", "2026-01-03"],
  ["2026-02-15", "2026-02-23"],
  ["2026-04-04", "2026-04-06"],
  ["2026-05-01", "2026-05-05"],
  ["2026-06-19", "2026-06-21"],
  ["2026-09-25", "2026-09-27"],
  ["2026-10-01", "2026-10-07"],
]);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOTES_DIRECTORY = "D:\\Develop\\Caelush-work-notes\\prompt-cache-97";
const DEFAULT_AUDIT_RUN_ID = "optimization-1";
const PAID_ATTEMPT_LOCK_FILE = "deepseek-stage-7-paid-attempt.lock";
const TEST_FILE = resolve(
  REPO_ROOT,
  "apps/daemon/test/deepseek-prompt-cache-real-provider.test.ts",
);
const VITEST_ENTRY = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");

const ABORT_REASONS = new Set([
  "MAIN_CALL_LIMIT",
  "TOTAL_CALL_LIMIT",
  "SCORED_MISS_LIMIT",
  "OUTPUT_TOKEN_LIMIT",
  "UNKNOWN_USAGE",
  "CONSECUTIVE_UNEXPLAINED_RESET",
  "HIDDEN_PROVIDER_CALL",
  "PROVIDER_CALL_NOT_OBSERVED",
  "PROVIDER_REQUEST_FAILED",
  "PREPARE_FAILED",
  "DUPLICATE_CALL_ID",
  "INVALID_USAGE",
  "INVALID_PREFIX_USAGE",
  "CONFIGURATION_CHANGED",
  "IN_FLIGHT_REQUEST_NOT_RESENT",
  "CHECKPOINT_MISMATCH",
  "CHECKPOINT_UNREADABLE",
  "CHECKPOINT_WRITE_FAILED",
  "PROBE_NO_CACHE_HIT",
  "PROBE_USAGE_INCOMPLETE",
  "ROTATED_CREDENTIAL_MISSING",
  "PROBE_NOT_PASSED",
  "PROBE_ALREADY_ATTEMPTED",
  "RUN_ALREADY_ATTEMPTED",
  "PRICE_PERIOD_UNVERIFIED",
  "LOCAL_FIXTURE_FAILED",
  "PAID_ATTEMPT_LOCKED",
  "PROBE_CHECKPOINT_EXISTS",
]);

/** Hash a canonical JSON representation; the unhashed value is never returned. */
export function createIrreversibleFingerprint(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Return unique, external artifact names for one paid Stage 7 audit iteration. */
export function getAuditArtifactNames(runId = DEFAULT_AUDIT_RUN_ID) {
  if (typeof runId !== "string" || !AUDIT_RUN_ID_PATTERN.test(runId)) {
    throw new TypeError("Audit run identifier is invalid.");
  }
  return Object.freeze({
    probe: `deepseek-probe-stage-7-${runId}.json`,
    probeCheckpoint: `deepseek-probe-stage-7-${runId}.checkpoint.json`,
    run42: `deepseek-42-turn-stage-7-${runId}.json`,
    run42Checkpoint: `deepseek-42-turn-stage-7-${runId}.checkpoint.json`,
  });
}

/** Serialize provider request starts while exposing no request or credential data. */
export function createRequestStartPacer(options = {}) {
  const minimumIntervalMs = options.minimumIntervalMs ?? 0;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  if (!isSafeCount(minimumIntervalMs) || typeof now !== "function" || typeof sleep !== "function") {
    throw new TypeError("Provider request pacing configuration is invalid.");
  }
  let lastStartAt;
  let queue = Promise.resolve();
  return Object.freeze({
    waitForNextStart() {
      const scheduled = queue.then(async () => {
        const currentTime = now();
        if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
          throw new TypeError("Provider request pacing clock is invalid.");
        }
        if (lastStartAt !== undefined) {
          const elapsed = currentTime - lastStartAt;
          if (elapsed < minimumIntervalMs) await sleep(minimumIntervalMs - elapsed);
        }
        const startedAt = now();
        if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
          throw new TypeError("Provider request pacing clock is invalid.");
        }
        lastStartAt = startedAt;
      });
      queue = scheduled.catch(() => undefined);
      return scheduled;
    },
  });
}

function isExpectedPrefixSource(value) {
  return typeof value === "string" && EXPECTED_PREFIX_SOURCES.has(value);
}

/** The Stage 7 runtime uses only the daemon's DeepSeek-specific environment binding. */
export function getRotatedDeepSeekCredentialStatus(environment = process.env) {
  const providerMatches = environment.CAELUSH_PROVIDER_ID === "deepseek";
  const credentialPresent =
    typeof environment.CAELUSH_PROVIDER_API_KEY === "string" &&
    environment.CAELUSH_PROVIDER_API_KEY.trim().length > 0;
  return providerMatches && credentialPresent ? "PRESENT" : "MISSING";
}

/** Resolve the current official peak/off-peak schedule or fail closed if the calendar is unknown. */
export function getDeepSeekPricingPeriod(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "UNVERIFIED";
  const year = date.getUTCFullYear();
  if (year !== 2026) return "UNVERIFIED";
  const utcDate = date.toISOString().slice(0, 10);
  const weekday = date.getUTCDay();
  const utcHour = date.getUTCHours();
  const publicHoliday = CHINA_PUBLIC_HOLIDAYS_2026.some(
    ([start, end]) => utcDate >= start && utcDate <= end,
  );

  if (weekday === 0 || weekday === 6 || publicHoliday) return "OFF_PEAK";
  const isPeakWindow = (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
  return isPeakWindow ? "PEAK" : "OFF_PEAK";
}

/** Create a bounded, credential-free checkpoint envelope. */
export function createAuditCheckpoint({
  mode,
  configurationFingerprint,
  pricingPeriod,
  requestCount,
}) {
  if (!MODES.has(mode)) throw new TypeError("Audit mode is unsupported.");
  if (!isFingerprint(configurationFingerprint)) {
    throw new TypeError("Audit configuration fingerprint is invalid.");
  }
  if ((pricingPeriod !== "AUTO" && !isPricingPeriod(pricingPeriod)) || !isSafeCount(requestCount)) {
    throw new TypeError("Audit checkpoint metadata is invalid.");
  }

  return {
    schemaVersion: 1,
    mode,
    configurationFingerprint,
    pricingPeriod,
    requestCount,
    nextRequestIndex: 0,
    providerCallCount: 0,
    mainCallCount: 0,
    unknownUsageCount: 0,
    unknownPrefixCount: 0,
    unknownMissTokens: 0,
    unexplainedResetCount: 0,
    consecutiveUnexplainedResetCount: 0,
    duplicateSnapshotCount: 0,
    hiddenCallCount: 0,
    totalOutputTokens: 0,
    scoredMissTokens: 0,
    totalCostNanoDollars: "0",
    unpricedCallCount: 0,
    samples: [],
    seenCallIds: [],
    seenSnapshotFingerprints: [],
    lastEpochId: null,
    inFlight: null,
    abortReason: null,
  };
}

/** Atomic replace in the same directory so a partial JSON checkpoint is never authoritative. */
export async function writeAuditCheckpointAtomic(path, checkpoint) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const safeCheckpoint = sanitizeCheckpoint(checkpoint);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(safeCheckpoint)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("Audit checkpoint could not be committed atomically.");
  }
}

/** Execute a fixed request list sequentially, checkpointing intent and settlement around every call. */
export async function runAuditRequests(options) {
  const settings = normalizeRunOptions(options);
  const configurationFingerprint =
    settings.configurationFingerprint ??
    createIrreversibleFingerprint(
      settings.requests.map(
        ({ purpose, eligible, expectedReusablePrefixTokens, epochId, resetReason, ...rest }) => ({
          purpose,
          eligible,
          expectedReusablePrefixTokens,
          epochId,
          resetReason: resetReason ?? null,
          request: rest.request,
        }),
      ),
    );

  let checkpoint;
  try {
    checkpoint = await readCheckpoint(settings.checkpointPath);
    if (checkpoint === undefined) {
      checkpoint = createAuditCheckpoint({
        mode: settings.mode,
        configurationFingerprint,
        pricingPeriod: settings.pricingPeriodName,
        requestCount: settings.requests.length,
      });
      await writeAuditCheckpointAtomic(settings.checkpointPath, checkpoint);
    } else if (
      !isValidCheckpoint(checkpoint) ||
      checkpoint.mode !== settings.mode ||
      checkpoint.configurationFingerprint !== configurationFingerprint ||
      checkpoint.requestCount !== settings.requests.length ||
      checkpoint.pricingPeriod !== settings.pricingPeriodName
    ) {
      return { report: safeReportFromCheckpoint(checkpoint, settings, "CHECKPOINT_MISMATCH") };
    }
  } catch {
    return {
      report: createEmptySafeReport(settings, "CHECKPOINT_UNREADABLE"),
    };
  }

  if (checkpoint.inFlight !== null) {
    // The request may already have reached the Provider. Count it conservatively and never resend.
    checkpoint.providerCallCount += 1;
    if (SCORING_PURPOSES.has(checkpoint.inFlight.purpose)) checkpoint.mainCallCount += 1;
    checkpoint.unknownUsageCount += 1;
    checkpoint.unpricedCallCount += 1;
    checkpoint.hiddenCallCount += 1;
    checkpoint.abortReason = "IN_FLIGHT_REQUEST_NOT_RESENT";
    checkpoint.inFlight = null;
    await persistSafeCheckpoint(settings.checkpointPath, checkpoint);
    return { report: safeReportFromCheckpoint(checkpoint, settings) };
  }

  let settledThisInvocation = 0;
  while (
    checkpoint.nextRequestIndex < settings.requests.length &&
    checkpoint.abortReason === null
  ) {
    if (
      settings.maxRequestsThisInvocation !== undefined &&
      settledThisInvocation >= settings.maxRequestsThisInvocation
    ) {
      break;
    }
    if (
      checkpoint.mainCallCount >= settings.limits.maxMainCalls &&
      SCORING_PURPOSES.has(settings.requests[checkpoint.nextRequestIndex].purpose)
    ) {
      checkpoint.abortReason = "MAIN_CALL_LIMIT";
      break;
    }
    if (checkpoint.providerCallCount >= settings.limits.maxProviderCalls) {
      checkpoint.abortReason = "TOTAL_CALL_LIMIT";
      break;
    }

    const requestIndex = checkpoint.nextRequestIndex;
    const plannedRequest = settings.requests[requestIndex];
    let prepared;
    try {
      prepared = await settings.driver.prepare(plannedRequest, requestIndex);
    } catch {
      checkpoint.abortReason = "PREPARE_FAILED";
      break;
    }

    if (!isSafeCallId(prepared?.callId)) {
      checkpoint.abortReason = "PREPARE_FAILED";
      break;
    }
    const callIdFingerprint = createIrreversibleFingerprint(prepared.callId);
    if (checkpoint.seenCallIds.includes(callIdFingerprint)) {
      checkpoint.abortReason = "DUPLICATE_CALL_ID";
      break;
    }

    const prefixFingerprint = normalizeFingerprint(
      prepared.prefixFingerprint ?? plannedRequest.expectedReusablePrefixFingerprint,
    );
    if (prefixFingerprint === undefined) {
      checkpoint.unknownPrefixCount += 1;
      checkpoint.abortReason = "INVALID_PREFIX_USAGE";
      break;
    }
    const period = resolvePricingPeriod(settings.pricingPeriod, new Date());
    if (!isPricingPeriod(period)) {
      checkpoint.abortReason = "PRICE_PERIOD_UNVERIFIED";
      break;
    }

    checkpoint.inFlight = {
      callId: callIdFingerprint,
      purpose: plannedRequest.purpose,
      prefixFingerprint,
      expectedReusablePrefixTokens: plannedRequest.expectedReusablePrefixTokens,
      epochId: normalizeFingerprint(prepared.epochId ?? plannedRequest.epochId),
      resetReason: normalizeResetReason(prepared.resetReason ?? plannedRequest.resetReason),
      snapshotIdentityFingerprint: normalizeFingerprint(plannedRequest.snapshotIdentityFingerprint),
      requestIndex,
      intentAt: new Date().toISOString(),
    };
    try {
      await writeAuditCheckpointAtomic(settings.checkpointPath, checkpoint);
    } catch {
      checkpoint.abortReason = "CHECKPOINT_WRITE_FAILED";
      checkpoint.inFlight = null;
      break;
    }

    const callsBefore = settings.driver.getObservedProviderCallCount();
    let outcome;
    try {
      outcome = await prepared.dispatch();
    } catch {
      outcome = { success: false, safeFailureCode: "PROVIDER_REQUEST_FAILED" };
    }
    const callsAfter = settings.driver.getObservedProviderCallCount();
    const providerCallDelta =
      Number.isSafeInteger(callsAfter) &&
      Number.isSafeInteger(callsBefore) &&
      callsAfter >= callsBefore
        ? callsAfter - callsBefore
        : 0;

    if (providerCallDelta === 0) {
      checkpoint.inFlight = null;
      checkpoint.abortReason = "PROVIDER_CALL_NOT_OBSERVED";
      await persistSafeCheckpoint(settings.checkpointPath, checkpoint);
      break;
    }

    checkpoint.providerCallCount += providerCallDelta;
    if (SCORING_PURPOSES.has(plannedRequest.purpose)) checkpoint.mainCallCount += 1;
    const success = outcome?.success === true;
    const normalized = normalizeUsage(outcome?.usage);
    const expectedPrefixTokens = plannedRequest.expectedReusablePrefixTokens;
    const epochId = normalizeFingerprint(prepared.epochId ?? plannedRequest.epochId) ?? null;
    const resetReason = normalizeResetReason(prepared.resetReason ?? plannedRequest.resetReason);
    const sample = {
      callId: callIdFingerprint,
      purpose: plannedRequest.purpose,
      status: success ? "SETTLED" : "FAILED",
      success,
      eligible: plannedRequest.eligible === true,
      expectedReusablePrefixTokens: isSafeCount(expectedPrefixTokens) ? expectedPrefixTokens : null,
      expectedReusablePrefixSource: isExpectedPrefixSource(
        plannedRequest.expectedReusablePrefixSource,
      )
        ? plannedRequest.expectedReusablePrefixSource
        : null,
      expectedReusablePrefixFingerprint: prefixFingerprint,
      epochId,
      resetReason,
      latencyMs: isSafeCount(outcome?.latencyMs) ? outcome.latencyMs : null,
      httpStatus: normalizeHttpStatus(outcome?.httpStatus),
      failureClass: classifyProviderFailure(outcome?.httpStatus, success),
      pricePeriod: period,
      ...(normalized === undefined
        ? {
            inputTokens: null,
            hitTokens: null,
            missTokens: null,
            writeTokens: null,
            outputTokens: null,
            cacheStatus: "UNREPORTED",
            costNanoDollars: null,
          }
        : {
            inputTokens: normalized.inputTokens,
            hitTokens: normalized.hitTokens,
            missTokens: normalized.missTokens,
            writeTokens: normalized.writeTokens,
            outputTokens: normalized.outputTokens,
            cacheStatus: normalized.hitTokens > 0 ? "HIT" : "MISS",
            costNanoDollars: computeDeepSeekCostNanoDollars(normalized, period).toString(),
          }),
      snapshotIdentityFingerprint: normalizeFingerprint(plannedRequest.snapshotIdentityFingerprint),
    };

    checkpoint.seenCallIds.push(callIdFingerprint);
    checkpoint.samples.push(sample);
    checkpoint.nextRequestIndex += 1;
    checkpoint.inFlight = null;
    settledThisInvocation += 1;

    if (
      normalized === undefined ||
      normalized.inputTokens !== normalized.hitTokens + normalized.missTokens
    ) {
      checkpoint.unknownUsageCount += 1;
      checkpoint.unpricedCallCount += 1;
    } else {
      checkpoint.totalOutputTokens += normalized.outputTokens;
      checkpoint.totalCostNanoDollars = (
        BigInt(checkpoint.totalCostNanoDollars) + computeDeepSeekCostNanoDollars(normalized, period)
      ).toString();
      checkpoint.lastPricingPeriod = period;
      if (
        plannedRequest.purpose === "MAIN_AGENT" &&
        success &&
        plannedRequest.eligible === true &&
        !resetReason
      ) {
        checkpoint.scoredMissTokens += normalized.missTokens;
      }
    }

    updateResetAccounting(checkpoint, epochId, resetReason);
    updateSnapshotAccounting(checkpoint, sample.snapshotIdentityFingerprint);
    if (providerCallDelta > 1) {
      checkpoint.hiddenCallCount += providerCallDelta - 1;
      checkpoint.unpricedCallCount += providerCallDelta - 1;
    }

    const scoredSamples = checkpoint.samples.filter(
      (entry) =>
        entry.purpose === "MAIN_AGENT" && entry.success && entry.eligible && !entry.resetReason,
    ).length;
    if (
      normalized === undefined ||
      normalized.inputTokens !== normalized.hitTokens + normalized.missTokens
    ) {
      checkpoint.abortReason = "UNKNOWN_USAGE";
    } else if (!success) {
      checkpoint.abortReason = "PROVIDER_REQUEST_FAILED";
    } else if (checkpoint.hiddenCallCount > 0) {
      checkpoint.abortReason = "HIDDEN_PROVIDER_CALL";
    } else if (checkpoint.mainCallCount > settings.limits.maxMainCalls) {
      checkpoint.abortReason = "MAIN_CALL_LIMIT";
    } else if (checkpoint.providerCallCount > settings.limits.maxProviderCalls) {
      checkpoint.abortReason = "TOTAL_CALL_LIMIT";
    } else if (checkpoint.scoredMissTokens > settings.limits.maxScoredMissTokens) {
      checkpoint.abortReason = "SCORED_MISS_LIMIT";
    } else if (checkpoint.totalOutputTokens > settings.limits.maxOutputTokens) {
      checkpoint.abortReason = "OUTPUT_TOKEN_LIMIT";
    } else if (
      checkpoint.consecutiveUnexplainedResetCount >= settings.limits.maxConsecutiveUnexplainedResets
    ) {
      checkpoint.abortReason = "CONSECUTIVE_UNEXPLAINED_RESET";
    } else if (settings.mode === "probe" && scoredSamples !== 0) {
      checkpoint.abortReason = "INVALID_USAGE";
    }

    if (checkpoint.abortReason !== null)
      checkpoint.abortReason = normalizeAbortReason(checkpoint.abortReason);
    await persistSafeCheckpoint(settings.checkpointPath, checkpoint);
  }

  if (checkpoint.abortReason === null && checkpoint.nextRequestIndex === settings.requests.length) {
    if (settings.mode === "probe") {
      const probePassed =
        checkpoint.samples.length === 3 &&
        checkpoint.samples.every(
          (sample) =>
            Number.isSafeInteger(sample.hitTokens) && Number.isSafeInteger(sample.missTokens),
        ) &&
        checkpoint.samples.slice(1).some((sample) => sample.hitTokens > 0);
      if (!probePassed) checkpoint.abortReason = "PROBE_NO_CACHE_HIT";
    }
  }

  if (checkpoint.abortReason !== null)
    await persistSafeCheckpoint(settings.checkpointPath, checkpoint);
  const report = safeReportFromCheckpoint(checkpoint, settings);
  return { report };
}

/** Atomically write a final safe report outside the repository. */
export async function writeAuditReportAtomic(path, report) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("Audit report could not be committed atomically.");
  }
}

/** Reserve the shared paid-attempt slot with exclusive file creation. */
export async function acquireAuditAttemptLock(path) {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new TypeError("Audit attempt lock path is invalid.");
  }
  await mkdir(dirname(path), { recursive: true });
  const identity = randomUUID();
  const ownerPid = process.pid;
  try {
    await writeFile(
      path,
      `${JSON.stringify({ schemaVersion: 1, identity, ownerPid, startedAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw new Error("Audit attempt lock could not be acquired.", { cause: error });
  }

  let released = false;
  return {
    identity,
    async release() {
      if (released) return;
      released = true;
      let current;
      try {
        current = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw new Error("Audit attempt lock could not be verified for release.", { cause: error });
      }
      if (current?.identity !== identity || current?.ownerPid !== ownerPid) return;
      try {
        await unlink(path);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new Error("Audit attempt lock could not be released.", { cause: error });
        }
      }
    },
  };
}

/** Price one complete usage response in integer nanodollars (no floating-point rounding). */
export function computeDeepSeekCostNanoDollars(usage, pricingPeriod) {
  const rates = RATE_CARD[pricingPeriod];
  if (rates === undefined) throw new TypeError("DeepSeek pricing period is unsupported.");
  const normalized = normalizeUsage(usage);
  if (normalized === undefined) throw new TypeError("DeepSeek usage is incomplete.");
  return (
    BigInt(normalized.hitTokens) * rates.hitNanoDollarsPerToken +
    BigInt(normalized.missTokens) * rates.missNanoDollarsPerToken +
    BigInt(normalized.outputTokens) * rates.outputNanoDollarsPerToken
  );
}

function normalizeRunOptions(options) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Audit run options are invalid.");
  }
  const { mode, requests, driver, checkpointPath } = options;
  if (!MODES.has(mode) || !Array.isArray(requests) || typeof checkpointPath !== "string") {
    throw new TypeError("Audit run configuration is invalid.");
  }
  if (
    typeof driver?.prepare !== "function" ||
    typeof driver?.getObservedProviderCallCount !== "function"
  ) {
    throw new TypeError("Audit provider driver is invalid.");
  }
  for (const request of requests) {
    if (
      typeof request !== "object" ||
      request === null ||
      !STAGE7_PURPOSES.includes(request.purpose)
    ) {
      throw new TypeError("Audit request purpose is invalid.");
    }
  }
  if (mode === "probe" && requests.length !== 3) {
    throw new TypeError("The DeepSeek probe must contain exactly three requests.");
  }
  if (!isSafeCount(options.expectedScoredCount ?? 40)) {
    throw new TypeError("Expected scored request count is invalid.");
  }
  const limits = Object.freeze({
    ...STAGE7_LIMITS,
    ...(options.limits ?? {}),
  });
  for (const value of Object.values(limits)) {
    if (!isSafeCount(value)) throw new TypeError("Audit fuse limits are invalid.");
  }
  const pricingPeriodName =
    typeof options.pricingPeriod === "string" ? options.pricingPeriod : "AUTO";
  if (pricingPeriodName !== "AUTO" && !isPricingPeriod(pricingPeriodName)) {
    throw new TypeError("Audit pricing period is invalid.");
  }
  return {
    ...options,
    mode,
    requests,
    driver,
    checkpointPath,
    expectedScoredCount: options.expectedScoredCount ?? 40,
    limits,
    pricingPeriod: options.pricingPeriod ?? "AUTO",
    pricingPeriodName,
    maxRequestsThisInvocation: options.maxRequestsThisInvocation,
  };
}

function resolvePricingPeriod(input, date) {
  if (typeof input === "function") return input(date);
  if (input === "AUTO") return getDeepSeekPricingPeriod(date);
  return input;
}

function normalizeUsage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const inputTokens = value.inputTokens;
  const hitTokens = value.hitTokens ?? value.cachedInputTokens;
  const missTokens = value.missTokens ?? value.cacheMissInputTokens;
  const outputTokens = value.outputTokens;
  const writeTokens = value.writeTokens ?? value.cacheWriteInputTokens ?? 0;
  if (![inputTokens, hitTokens, missTokens, writeTokens, outputTokens].every(isSafeCount)) {
    return undefined;
  }
  return { inputTokens, hitTokens, missTokens, writeTokens, outputTokens };
}

function normalizeHttpStatus(value) {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function classifyProviderFailure(httpStatus, success) {
  if (success) return null;
  const status = normalizeHttpStatus(httpStatus);
  if (status === 429) return "RATE_LIMITED";
  if (status !== null && status >= 500) return "PROVIDER_SERVER_ERROR";
  if (status !== null && status >= 400) return "PROVIDER_REJECTED";
  if (status !== null) return "STREAM_FAILED";
  return "TRANSPORT_OR_STREAM_FAILURE";
}

function updateResetAccounting(checkpoint, epochId, resetReason) {
  if (checkpoint.lastEpochId === null) {
    checkpoint.lastEpochId = epochId;
    return;
  }
  const changed =
    epochId !== null && checkpoint.lastEpochId !== null && epochId !== checkpoint.lastEpochId;
  if (!changed) {
    checkpoint.consecutiveUnexplainedResetCount = 0;
    return;
  }
  if (resetReason === null || !RESET_REASONS.has(resetReason)) {
    checkpoint.unexplainedResetCount += 1;
    checkpoint.consecutiveUnexplainedResetCount += 1;
  } else {
    checkpoint.consecutiveUnexplainedResetCount = 0;
  }
  checkpoint.lastEpochId = epochId;
}

function updateSnapshotAccounting(checkpoint, snapshotFingerprint) {
  if (snapshotFingerprint === null || snapshotFingerprint === undefined) return;
  if (checkpoint.seenSnapshotFingerprints.includes(snapshotFingerprint)) {
    checkpoint.duplicateSnapshotCount += 1;
  } else {
    checkpoint.seenSnapshotFingerprints.push(snapshotFingerprint);
  }
}

function resolvePrefixAccounting(samples, mode) {
  const expectedPrefixTokensByIndex = Array.from({ length: samples.length }, () => null);
  const scoredIndexes = samples.flatMap((sample, index) =>
    sample.purpose === "MAIN_AGENT" &&
    sample.success === true &&
    sample.eligible === true &&
    !sample.resetReason
      ? [index]
      : [],
  );

  if (scoredIndexes.length === 0) {
    return {
      calibration: { source: "NOT_APPLICABLE", baselineTokens: null, valid: true, reason: null },
      calibrationInvalidCount: 0,
      expectedPrefixTokensByIndex,
      unexplainedMissTokens: 0n,
    };
  }

  const warmups = samples.filter((sample) => sample.purpose === "WARMUP");
  let calibration;
  if (mode === "run-42" && warmups.length > 0) {
    const [first, second] = warmups;
    const validWarmupUsage = [first, second].every(
      (sample) =>
        sample?.success === true &&
        isSafeCount(sample.inputTokens) &&
        isSafeCount(sample.hitTokens) &&
        isSafeCount(sample.missTokens) &&
        sample.inputTokens === sample.hitTokens + sample.missTokens &&
        sample.hitTokens > 0,
    );
    const identitiesMatch =
      warmups.length === 2 &&
      isFingerprint(first?.expectedReusablePrefixFingerprint) &&
      first.expectedReusablePrefixFingerprint === second?.expectedReusablePrefixFingerprint &&
      first.epochId === second?.epochId;
    const hitDriftTokens =
      validWarmupUsage && warmups.length === 2
        ? Math.abs(first.hitTokens - second.hitTokens)
        : null;
    const reason =
      warmups.length !== 2
        ? "WARMUP_COUNT"
        : !validWarmupUsage
          ? "WARMUP_USAGE_INCOMPLETE"
          : !identitiesMatch
            ? "WARMUP_PREFIX_IDENTITY_MISMATCH"
            : second.resetReason !== null
              ? "RESET_DURING_CALIBRATION"
              : hitDriftTokens > MAX_WARMUP_HIT_DRIFT_TOKENS
                ? "WARMUP_HIT_DRIFT"
                : null;
    const baselineTokens = reason === null ? Math.min(first.hitTokens, second.hitTokens) : null;
    const prefixExceedsScoredInput =
      reason === null &&
      scoredIndexes.some(
        (index) =>
          !isSafeCount(samples[index].inputTokens) || baselineTokens > samples[index].inputTokens,
      );
    calibration = {
      source: "MEASURED_WARMUP",
      baselineTokens,
      valid: reason === null && !prefixExceedsScoredInput,
      reason: prefixExceedsScoredInput ? "PREFIX_EXCEEDS_SCORED_INPUT" : reason,
      hitDriftTokens,
    };
    if (calibration.valid) {
      for (const index of scoredIndexes) expectedPrefixTokensByIndex[index] = baselineTokens;
    }
  } else {
    const fixturePrefixesAvailable =
      mode === "run-42" &&
      scoredIndexes.every((index) => {
        const sample = samples[index];
        return (
          sample.expectedReusablePrefixSource === "FIXTURE_EXACT" &&
          isSafeCount(sample.expectedReusablePrefixTokens) &&
          isSafeCount(sample.inputTokens) &&
          sample.expectedReusablePrefixTokens <= sample.inputTokens
        );
      });
    calibration = fixturePrefixesAvailable
      ? { source: "FIXTURE_EXACT", baselineTokens: null, valid: true, reason: null }
      : {
          source: mode === "run-42" ? "UNAVAILABLE" : "NOT_APPLICABLE",
          baselineTokens: null,
          valid: mode !== "run-42",
          reason: mode === "run-42" ? "MEASURED_OR_FIXTURE_PREFIX_REQUIRED" : null,
        };
    if (fixturePrefixesAvailable) {
      for (const index of scoredIndexes) {
        expectedPrefixTokensByIndex[index] = samples[index].expectedReusablePrefixTokens;
      }
    }
  }

  let unexplainedMissTokens = 0n;
  for (const index of scoredIndexes) {
    const sample = samples[index];
    const expectedPrefixTokens = expectedPrefixTokensByIndex[index];
    if (
      !isSafeCount(expectedPrefixTokens) ||
      !isSafeCount(sample.inputTokens) ||
      !isSafeCount(sample.missTokens)
    ) {
      unexplainedMissTokens = null;
      break;
    }
    const expectedNovelTokens = Math.max(0, sample.inputTokens - expectedPrefixTokens);
    unexplainedMissTokens += BigInt(Math.max(0, sample.missTokens - expectedNovelTokens));
  }

  return {
    calibration,
    calibrationInvalidCount: calibration.valid ? 0 : 1,
    expectedPrefixTokensByIndex,
    unexplainedMissTokens,
  };
}

function safeReportFromCheckpoint(checkpoint, settings, forcedAbortReason) {
  const samples = checkpoint.samples.map((sample) => ({ ...sample }));
  const prefixAccounting = resolvePrefixAccounting(samples, settings.mode);
  const auditSamples = samples.map((sample, index) => ({
    callId: isFingerprint(sample.callId)
      ? sample.callId
      : createIrreversibleFingerprint(String(sample.callId ?? "unknown")),
    purpose: sample.purpose,
    inputTokens: sample.inputTokens,
    hitTokens: sample.hitTokens,
    missTokens: sample.missTokens,
    writeTokens: sample.writeTokens,
    epochId: sample.epochId,
    resetReason: sample.resetReason,
    expectedReusablePrefixTokens: prefixAccounting.expectedPrefixTokensByIndex[index],
    eligible: sample.eligible,
    success: sample.success,
  }));
  let audited;
  try {
    audited = evaluatePromptCacheAudit(auditSamples, {
      expectedScoredCount: settings.expectedScoredCount,
      observedProviderCallCount: checkpoint.providerCallCount,
    });
  } catch {
    audited = {
      billingHitRate: "UNREPORTED",
      reusablePrefixEfficiency: "UNREPORTED",
      scoredCount: 0,
      totalCallCount: checkpoint.providerCallCount,
      unknownUsageCount: checkpoint.unknownUsageCount,
      duplicateCallIdCount: 0,
      missingCallIdCount: 0,
      hiddenCallCount: checkpoint.hiddenCallCount,
      totalInputTokens: "UNREPORTED",
      totalHitTokens: "UNREPORTED",
      totalMissTokens: "UNREPORTED",
      totalWriteTokens: "UNREPORTED",
      passed: false,
    };
  }

  const unknownUsageCount = Math.max(audited.unknownUsageCount, checkpoint.unknownUsageCount);
  const unexplainedCacheMissTokens =
    prefixAccounting.unexplainedMissTokens === null
      ? "UNREPORTED"
      : jsonExactInteger(prefixAccounting.unexplainedMissTokens);
  const probeStatus =
    settings.mode !== "probe"
      ? undefined
      : checkpoint.abortReason === null &&
          checkpoint.samples.length === 3 &&
          checkpoint.samples.slice(1).some((sample) => sample.hitTokens > 0)
        ? "PASS"
        : forcedAbortReason === "ROTATED_CREDENTIAL_MISSING"
          ? "BLOCKED_CREDENTIAL"
          : "PROBE_FAILED";
  const gateC =
    unknownUsageCount === 0 &&
    prefixAccounting.calibration.valid &&
    prefixAccounting.calibrationInvalidCount === 0 &&
    prefixAccounting.unexplainedMissTokens !== null &&
    prefixAccounting.unexplainedMissTokens === 0n &&
    checkpoint.unexplainedResetCount === 0 &&
    checkpoint.duplicateSnapshotCount === 0 &&
    checkpoint.hiddenCallCount === 0 &&
    audited.hiddenCallCount === 0 &&
    audited.duplicateCallIdCount === 0 &&
    audited.missingCallIdCount === 0;
  const complete =
    checkpoint.nextRequestIndex === checkpoint.requestCount && checkpoint.inFlight === null;
  const noUnknownAccounting = unknownUsageCount === 0 && checkpoint.unpricedCallCount === 0;
  const providerInventoryComplete =
    checkpoint.providerCallCount === samples.length &&
    audited.hiddenCallCount === 0 &&
    audited.duplicateCallIdCount === 0 &&
    audited.missingCallIdCount === 0;
  const allTokenTotalsReported = noUnknownAccounting && providerInventoryComplete;
  const billingHitNumerator = exactTokenSum(
    samples,
    "hitTokens",
    (sample) =>
      sample.purpose === "MAIN_AGENT" && sample.success && sample.eligible && !sample.resetReason,
  );
  const billingMissNumerator = exactTokenSum(
    samples,
    "missTokens",
    (sample) =>
      sample.purpose === "MAIN_AGENT" && sample.success && sample.eligible && !sample.resetReason,
  );
  const reusablePrefixNumerator = auditSamples.reduce((total, sample) => {
    if (
      sample.purpose !== "MAIN_AGENT" ||
      !sample.success ||
      !sample.eligible ||
      sample.resetReason ||
      !isSafeCount(sample.hitTokens) ||
      !isSafeCount(sample.expectedReusablePrefixTokens)
    )
      return total;
    return total + BigInt(Math.min(sample.hitTokens, sample.expectedReusablePrefixTokens));
  }, 0n);
  const reusablePrefixDenominator = exactTokenSum(
    auditSamples,
    "expectedReusablePrefixTokens",
    (sample) =>
      sample.purpose === "MAIN_AGENT" && sample.success && sample.eligible && !sample.resetReason,
  );
  const billingHitDenominator = billingHitNumerator + billingMissNumerator;
  const billingHitRate = ratioFromExactCounts(billingHitNumerator, billingHitDenominator);
  const reusablePrefixEfficiency = ratioFromExactCounts(
    reusablePrefixNumerator,
    reusablePrefixDenominator,
  );
  const gateA =
    audited.scoredCount === settings.expectedScoredCount &&
    billingHitDenominator > 0n &&
    billingHitNumerator * 100n > billingHitDenominator * BILLING_HIT_RATE_FLOOR_PERCENT;
  const billingHitRateTargetMet =
    audited.scoredCount === settings.expectedScoredCount &&
    billingHitDenominator > 0n &&
    billingHitNumerator * 100n >= billingHitDenominator * BILLING_HIT_RATE_TARGET_PERCENT;
  const billingHitRateNearTargetMet =
    audited.scoredCount === settings.expectedScoredCount &&
    billingHitDenominator > 0n &&
    billingHitNumerator * 100n >= billingHitDenominator * BILLING_HIT_RATE_NEAR_TARGET_PERCENT;
  const gateB =
    reusablePrefixDenominator > 0n &&
    reusablePrefixNumerator * 100n >= reusablePrefixDenominator * 99n;
  const gates = {
    A: {
      passed: gateA,
      billingHitRate,
      hardFloorPercent: Number(BILLING_HIT_RATE_FLOOR_PERCENT),
      nearTargetMet: billingHitRateNearTargetMet,
      nearTargetPercent: Number(BILLING_HIT_RATE_NEAR_TARGET_PERCENT),
      targetMet: billingHitRateTargetMet,
      targetPercent: Number(BILLING_HIT_RATE_TARGET_PERCENT),
    },
    B: {
      passed: gateB,
      reusablePrefixEfficiency,
      calibrationSource: prefixAccounting.calibration.source,
    },
    C: {
      passed: gateC,
      unknownUsageCount,
      unexplainedCacheMissTokens,
      calibrationInvalidCount: prefixAccounting.calibrationInvalidCount,
      unexplainedResetCount: checkpoint.unexplainedResetCount,
      duplicateSnapshotCount: checkpoint.duplicateSnapshotCount,
      hiddenCallCount: Math.max(checkpoint.hiddenCallCount, audited.hiddenCallCount),
    },
  };
  const costSummary = buildCostSummary(checkpoint, samples);
  const exitGatePassed =
    settings.mode === "run-42" &&
    checkpoint.abortReason === null &&
    forcedAbortReason === undefined &&
    complete &&
    checkpoint.mainCallCount === 42 &&
    checkpoint.mainCallCount <= settings.limits.maxMainCalls &&
    checkpoint.providerCallCount <= settings.limits.maxProviderCalls &&
    checkpoint.scoredMissTokens <= settings.limits.maxScoredMissTokens &&
    checkpoint.totalOutputTokens <= settings.limits.maxOutputTokens &&
    checkpoint.unknownUsageCount === 0 &&
    checkpoint.consecutiveUnexplainedResetCount < settings.limits.maxConsecutiveUnexplainedResets &&
    audited.scoredCount === 40 &&
    gateA &&
    gateB &&
    gateC &&
    costSummary.reconciled &&
    checkpoint.providerCallCount === samples.length;
  const report = {
    schemaVersion: 2,
    mode: settings.mode,
    provider: "deepseek",
    model: "deepseek-flash",
    configurationFingerprint: checkpoint.configurationFingerprint,
    credentialStatus: settings.credentialStatus ?? "NOT_CHECKED",
    providerCallCount: checkpoint.providerCallCount,
    mainCallCount: checkpoint.mainCallCount,
    auxiliaryCallCount: Math.max(0, checkpoint.providerCallCount - checkpoint.mainCallCount),
    scoredCount: audited.scoredCount,
    abortReason: normalizeAbortReason(forcedAbortReason ?? checkpoint.abortReason),
    completed: complete,
    resumable:
      !complete &&
      checkpoint.abortReason === null &&
      checkpoint.inFlight === null &&
      forcedAbortReason === undefined,
    probeStatus,
    billingHitRate,
    billingHitRateRaw: {
      numerator: jsonExactInteger(billingHitNumerator),
      denominator: jsonExactInteger(billingHitDenominator),
      value: billingHitRate,
    },
    reusablePrefixEfficiency,
    reusablePrefixEfficiencyRaw: {
      numerator: jsonExactInteger(reusablePrefixNumerator),
      denominator: jsonExactInteger(reusablePrefixDenominator),
      value: reusablePrefixEfficiency,
    },
    warmPrefixCalibration: prefixAccounting.calibration,
    calibrationInvalidCount: prefixAccounting.calibrationInvalidCount,
    totalInputTokens: allTokenTotalsReported
      ? jsonExactInteger(exactTokenSum(samples, "inputTokens"))
      : "UNREPORTED",
    totalHitTokens: allTokenTotalsReported
      ? jsonExactInteger(exactTokenSum(samples, "hitTokens"))
      : "UNREPORTED",
    totalMissTokens: allTokenTotalsReported
      ? jsonExactInteger(exactTokenSum(samples, "missTokens"))
      : "UNREPORTED",
    totalWriteTokens: allTokenTotalsReported
      ? jsonExactInteger(exactTokenSum(samples, "writeTokens"))
      : "UNREPORTED",
    totalOutputTokens: noUnknownAccounting ? checkpoint.totalOutputTokens : "UNREPORTED",
    scoredMissTokens: checkpoint.scoredMissTokens,
    unknownUsageCount,
    unexplainedCacheMissTokens,
    unknownMissTokens: unexplainedCacheMissTokens,
    unexplainedResetCount: checkpoint.unexplainedResetCount,
    consecutiveUnexplainedResetCount: checkpoint.consecutiveUnexplainedResetCount,
    duplicateSnapshotCount: checkpoint.duplicateSnapshotCount,
    hiddenCallCount: Math.max(checkpoint.hiddenCallCount, audited.hiddenCallCount),
    duplicateCallIdCount: audited.duplicateCallIdCount,
    missingCallIdCount: audited.missingCallIdCount,
    costSummary,
    gates,
    exitGatePassed,
    billingHitRateTargetMet,
    exitGateStatus: !exitGatePassed
      ? "FAIL"
      : billingHitRateTargetMet
        ? "TARGET_MET"
        : billingHitRateNearTargetMet
          ? "PASS_NEAR_TARGET"
          : "PASS_ABOVE_FLOOR",
    samples: samples.map((sample, index) => ({
      callIdFingerprint: isFingerprint(sample.callId)
        ? sample.callId
        : createIrreversibleFingerprint(String(sample.callId ?? "unknown")),
      purpose: STAGE7_PURPOSES.includes(sample.purpose) ? sample.purpose : "OTHER",
      status:
        sample.success === true && audited.sampleStatuses?.[index]?.status === "SCORED"
          ? "SCORED"
          : sample.success === true
            ? "UNSCORED"
            : "FAILED",
      success: sample.success === true,
      eligible: sample.eligible === true,
      expectedReusablePrefixTokens: isSafeCount(prefixAccounting.expectedPrefixTokensByIndex[index])
        ? prefixAccounting.expectedPrefixTokensByIndex[index]
        : null,
      expectedReusablePrefixSource:
        prefixAccounting.calibration.source === "MEASURED_WARMUP" &&
        sample.purpose === "MAIN_AGENT" &&
        sample.success === true &&
        sample.eligible === true
          ? "MEASURED_WARMUP"
          : sample.expectedReusablePrefixSource,
      expectedReusablePrefixFingerprint:
        normalizeFingerprint(sample.expectedReusablePrefixFingerprint) ?? null,
      epochFingerprint: normalizeFingerprint(sample.epochId) ?? null,
      resetReason: normalizeResetReason(sample.resetReason),
      latencyMs: isSafeCount(sample.latencyMs) ? sample.latencyMs : null,
      httpStatus: normalizeHttpStatus(sample.httpStatus),
      failureClass: PROVIDER_FAILURE_CLASSES.has(sample.failureClass) ? sample.failureClass : null,
      pricePeriod: isPricingPeriod(sample.pricePeriod) ? sample.pricePeriod : null,
      inputTokens: isSafeCount(sample.inputTokens) ? sample.inputTokens : null,
      hitTokens: isSafeCount(sample.hitTokens) ? sample.hitTokens : null,
      missTokens: isSafeCount(sample.missTokens) ? sample.missTokens : null,
      writeTokens: isSafeCount(sample.writeTokens) ? sample.writeTokens : null,
      outputTokens: isSafeCount(sample.outputTokens) ? sample.outputTokens : null,
      cacheStatus: ["HIT", "MISS", "UNREPORTED"].includes(sample.cacheStatus)
        ? sample.cacheStatus
        : "UNREPORTED",
      costNanoDollars:
        typeof sample.costNanoDollars === "string" && /^\d+$/u.test(sample.costNanoDollars)
          ? sample.costNanoDollars
          : null,
      snapshotIdentityFingerprint: normalizeFingerprint(sample.snapshotIdentityFingerprint) ?? null,
    })),
  };
  return report;
}

function buildCostSummary(checkpoint, samples = []) {
  const known = checkpoint.unpricedCallCount === 0;
  const total = BigInt(checkpoint.totalCostNanoDollars);
  return {
    currency: "USD",
    pricingBasis:
      "DeepSeek V4.1 Flash official peak/off-peak rates; cache writes are included in cache-miss input.",
    pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/",
    rateCardUsdPerMillionTokens: {
      OFF_PEAK: { hit: "0.003", miss: "0.15", output: "0.6" },
      PEAK: { hit: "0.006", miss: "0.3", output: "1.2" },
    },
    pricingPeriods: [
      ...new Set(samples.map((sample) => sample.pricePeriod).filter(isPricingPeriod)),
    ],
    totalCostNanoDollars: known ? total.toString() : "UNREPORTED",
    totalCostUsd: known ? formatNanoDollars(total) : "UNREPORTED",
    unpricedCallCount: checkpoint.unpricedCallCount,
    reconciled: known && checkpoint.providerCallCount === checkpoint.samples.length,
  };
}

function createEmptySafeReport(settings, abortReason) {
  return {
    schemaVersion: 2,
    mode: settings.mode,
    provider: "deepseek",
    model: "deepseek-flash",
    availability: abortReason === "ROTATED_CREDENTIAL_MISSING" ? "UNAVAILABLE" : "NOT_CHECKED",
    credentialStatus: settings.credentialStatus ?? "NOT_CHECKED",
    providerCallCount: 0,
    mainCallCount: 0,
    scoredCount: 0,
    abortReason: normalizeAbortReason(abortReason),
    completed: false,
    resumable: false,
    exitGatePassed: false,
    probeStatus: settings.mode === "probe" ? "BLOCKED_CREDENTIAL" : undefined,
    billingHitRate: "UNREPORTED",
    billingHitRateRaw: { numerator: 0, denominator: 0, value: "UNREPORTED" },
    reusablePrefixEfficiency: "UNREPORTED",
    reusablePrefixEfficiencyRaw: { numerator: 0, denominator: 0, value: "UNREPORTED" },
    warmPrefixCalibration: {
      source: "NOT_APPLICABLE",
      baselineTokens: null,
      valid: false,
      reason: "NO_PROVIDER_USAGE",
    },
    calibrationInvalidCount: settings.mode === "run-42" ? 1 : 0,
    unknownUsageCount: 0,
    unknownMissTokens: "UNREPORTED",
    unexplainedCacheMissTokens: "UNREPORTED",
    unexplainedResetCount: 0,
    duplicateSnapshotCount: 0,
    hiddenCallCount: 0,
    costSummary: {
      currency: "USD",
      pricingBasis:
        "DeepSeek V4.1 Flash official peak/off-peak rates; cache writes are included in cache-miss input.",
      pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/",
      totalCostNanoDollars: "0",
      totalCostUsd: "0.000000000",
      unpricedCallCount: 0,
      reconciled: true,
    },
    gates: {
      A: {
        passed: false,
        billingHitRate: "UNREPORTED",
        hardFloorPercent: Number(BILLING_HIT_RATE_FLOOR_PERCENT),
        nearTargetMet: false,
        nearTargetPercent: Number(BILLING_HIT_RATE_NEAR_TARGET_PERCENT),
        targetMet: false,
        targetPercent: Number(BILLING_HIT_RATE_TARGET_PERCENT),
      },
      B: {
        passed: false,
        reusablePrefixEfficiency: "UNREPORTED",
        calibrationSource: "NOT_APPLICABLE",
      },
      C: {
        passed: false,
        unknownUsageCount: 0,
        unknownMissTokens: "UNREPORTED",
        unexplainedCacheMissTokens: "UNREPORTED",
        calibrationInvalidCount: settings.mode === "run-42" ? 1 : 0,
        unexplainedResetCount: 0,
        duplicateSnapshotCount: 0,
        hiddenCallCount: 0,
      },
    },
    samples: [],
    billingHitRateTargetMet: false,
    exitGateStatus: "FAIL",
  };
}

function sanitizeCheckpoint(checkpoint) {
  const flight = checkpoint.inFlight;
  const inFlight =
    flight === null || typeof flight !== "object"
      ? null
      : {
          callId: isFingerprint(flight.callId)
            ? flight.callId
            : createIrreversibleFingerprint(String(flight.callId ?? "unknown")),
          purpose: STAGE7_PURPOSES.includes(flight.purpose) ? flight.purpose : "OTHER",
          prefixFingerprint: normalizeFingerprint(flight.prefixFingerprint) ?? "0".repeat(64),
          expectedReusablePrefixTokens: isSafeCount(flight.expectedReusablePrefixTokens)
            ? flight.expectedReusablePrefixTokens
            : null,
          expectedReusablePrefixSource: isExpectedPrefixSource(flight.expectedReusablePrefixSource)
            ? flight.expectedReusablePrefixSource
            : null,
          epochId: normalizeFingerprint(flight.epochId) ?? null,
          resetReason: normalizeResetReason(flight.resetReason),
          snapshotIdentityFingerprint:
            normalizeFingerprint(flight.snapshotIdentityFingerprint) ?? null,
          requestIndex: isSafeCount(flight.requestIndex) ? flight.requestIndex : 0,
        };

  return {
    schemaVersion: checkpoint.schemaVersion,
    mode: checkpoint.mode,
    configurationFingerprint: checkpoint.configurationFingerprint,
    pricingPeriod: checkpoint.pricingPeriod,
    requestCount: checkpoint.requestCount,
    nextRequestIndex: checkpoint.nextRequestIndex,
    providerCallCount: checkpoint.providerCallCount,
    mainCallCount: checkpoint.mainCallCount,
    unknownUsageCount: checkpoint.unknownUsageCount,
    unknownPrefixCount: checkpoint.unknownPrefixCount,
    unknownMissTokens: checkpoint.unknownMissTokens,
    unexplainedResetCount: checkpoint.unexplainedResetCount,
    consecutiveUnexplainedResetCount: checkpoint.consecutiveUnexplainedResetCount,
    duplicateSnapshotCount: checkpoint.duplicateSnapshotCount,
    hiddenCallCount: checkpoint.hiddenCallCount,
    totalOutputTokens: checkpoint.totalOutputTokens,
    scoredMissTokens: checkpoint.scoredMissTokens,
    totalCostNanoDollars: checkpoint.totalCostNanoDollars,
    unpricedCallCount: checkpoint.unpricedCallCount,
    samples: Array.isArray(checkpoint.samples)
      ? checkpoint.samples.map((sample) => ({
          callId: isFingerprint(sample.callId)
            ? sample.callId
            : createIrreversibleFingerprint(String(sample.callId ?? "unknown")),
          purpose: sample.purpose,
          status: sample.status,
          success: sample.success === true,
          eligible: sample.eligible === true,
          expectedReusablePrefixTokens: isSafeCount(sample.expectedReusablePrefixTokens)
            ? sample.expectedReusablePrefixTokens
            : null,
          expectedReusablePrefixSource: isExpectedPrefixSource(sample.expectedReusablePrefixSource)
            ? sample.expectedReusablePrefixSource
            : null,
          expectedReusablePrefixFingerprint:
            normalizeFingerprint(sample.expectedReusablePrefixFingerprint) ?? null,
          epochId: normalizeFingerprint(sample.epochId) ?? null,
          resetReason: normalizeResetReason(sample.resetReason),
          latencyMs: isSafeCount(sample.latencyMs) ? sample.latencyMs : null,
          httpStatus: normalizeHttpStatus(sample.httpStatus),
          failureClass: PROVIDER_FAILURE_CLASSES.has(sample.failureClass)
            ? sample.failureClass
            : null,
          pricePeriod: isPricingPeriod(sample.pricePeriod) ? sample.pricePeriod : null,
          inputTokens: isSafeCount(sample.inputTokens) ? sample.inputTokens : null,
          hitTokens: isSafeCount(sample.hitTokens) ? sample.hitTokens : null,
          missTokens: isSafeCount(sample.missTokens) ? sample.missTokens : null,
          writeTokens: isSafeCount(sample.writeTokens) ? sample.writeTokens : null,
          outputTokens: isSafeCount(sample.outputTokens) ? sample.outputTokens : null,
          cacheStatus: ["HIT", "MISS", "UNREPORTED"].includes(sample.cacheStatus)
            ? sample.cacheStatus
            : "UNREPORTED",
          costNanoDollars:
            typeof sample.costNanoDollars === "string" && /^\d+$/u.test(sample.costNanoDollars)
              ? sample.costNanoDollars
              : null,
          snapshotIdentityFingerprint:
            normalizeFingerprint(sample.snapshotIdentityFingerprint) ?? null,
        }))
      : [],
    seenCallIds: Array.isArray(checkpoint.seenCallIds)
      ? checkpoint.seenCallIds.map((callId) =>
          isFingerprint(callId) ? callId : createIrreversibleFingerprint(String(callId)),
        )
      : [],
    seenSnapshotFingerprints: Array.isArray(checkpoint.seenSnapshotFingerprints)
      ? checkpoint.seenSnapshotFingerprints.filter(isFingerprint)
      : [],
    lastEpochId: normalizeFingerprint(checkpoint.lastEpochId) ?? null,
    inFlight,
    abortReason: normalizeAbortReason(checkpoint.abortReason),
  };
}

function isSafeSample(sample) {
  return (
    typeof sample === "object" &&
    sample !== null &&
    isSafeCallId(sample.callId) &&
    STAGE7_PURPOSES.includes(sample.purpose) &&
    ["SETTLED", "FAILED"].includes(sample.status)
  );
}

function isValidCheckpoint(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.schemaVersion === 1 &&
    MODES.has(value.mode) &&
    isFingerprint(value.configurationFingerprint) &&
    (value.pricingPeriod === "AUTO" || isPricingPeriod(value.pricingPeriod)) &&
    isSafeCount(value.requestCount) &&
    isSafeCount(value.nextRequestIndex) &&
    value.nextRequestIndex <= value.requestCount &&
    isSafeCount(value.providerCallCount) &&
    isSafeCount(value.mainCallCount) &&
    Array.isArray(value.samples) &&
    value.samples.every(isSafeSample) &&
    (value.inFlight === null || isSafeInFlight(value.inFlight))
  );
}

function isSafeInFlight(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    isSafeCallId(value.callId) &&
    STAGE7_PURPOSES.includes(value.purpose) &&
    isFingerprint(value.prefixFingerprint) &&
    isSafeCount(value.requestIndex)
  );
}

async function readCheckpoint(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Audit checkpoint is unreadable.", { cause: error });
  }
}

async function persistSafeCheckpoint(path, checkpoint) {
  try {
    await writeAuditCheckpointAtomic(path, checkpoint);
  } catch {
    checkpoint.abortReason = "CHECKPOINT_WRITE_FAILED";
  }
}

function exactTokenSum(samples, field, predicate = () => true) {
  return samples.reduce((total, sample) => {
    const value = sample[field];
    return predicate(sample) && isSafeCount(value) ? total + BigInt(value) : total;
  }, 0n);
}

function jsonExactInteger(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function ratioFromExactCounts(numerator, denominator) {
  return denominator > 0n ? Number(numerator) / Number(denominator) : "UNREPORTED";
}

function normalizeResetReason(value) {
  if (value === undefined || value === null || value === "") return null;
  return RESET_REASONS.has(value) ? value : "UNEXPLAINED";
}

function normalizeFingerprint(value) {
  if (isFingerprint(value)) return value;
  if (value === undefined || value === null) return undefined;
  return createIrreversibleFingerprint(value);
}

function normalizeAbortReason(value) {
  return typeof value === "string" && ABORT_REASONS.has(value) ? value : null;
}

function isPricingPeriod(value) {
  return value === "OFF_PEAK" || value === "PEAK";
}

function isFingerprint(value) {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function isSafeCallId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function formatNanoDollars(value) {
  const whole = value / NANO_DOLLARS_PER_DOLLAR;
  const fraction = (value % NANO_DOLLARS_PER_DOLLAR).toString().padStart(9, "0");
  return `${whole.toString()}.${fraction}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
    .join(",")}}`;
}

async function externalNotesDirectory() {
  const path = await resolvePromptCacheArtifactDirectory(REPO_ROOT, NOTES_DIRECTORY);
  await mkdir(path, { recursive: true });
  return path;
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("Audit artifact path could not be inspected safely.", { cause: error });
  }
}

async function readSafeReport(path) {
  try {
    const report = JSON.parse(await readFile(path, "utf8"));
    if (typeof report !== "object" || report === null || report.provider !== "deepseek")
      return undefined;
    return report;
  } catch {
    return undefined;
  }
}

function printSummary(report) {
  const summary = {
    mode: report.mode,
    credentialStatus: report.credentialStatus,
    providerCallCount: report.providerCallCount,
    mainCallCount: report.mainCallCount,
    scoredCount: report.scoredCount,
    abortReason: report.abortReason,
    probeStatus: report.probeStatus,
    exitGatePassed: report.exitGatePassed,
    exitGateStatus: report.exitGateStatus,
    billingHitRate: report.billingHitRate,
    billingHitRateTargetMet: report.billingHitRateTargetMet,
    billingHitRateNearTargetMet: report.gates?.A?.nearTargetMet,
    reusablePrefixEfficiency: report.reusablePrefixEfficiency,
    warmPrefixCalibration: report.warmPrefixCalibration,
    unexplainedCacheMissTokens: report.unexplainedCacheMissTokens,
    gates: report.gates,
    costSummary: report.costSummary,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function runVitest(mode, outputPath, checkpointPath, probeFingerprint, dispatchToken, runId) {
  const args = [VITEST_ENTRY, "run", TEST_FILE];
  if (mode !== "local-fixture") args.push("-t", "explicit paid audit mode");
  const childEnvironment = { ...process.env, CAELUSH_PROMPT_CACHE_AUDIT_MODE: mode };
  childEnvironment.CAELUSH_PROMPT_CACHE_AUDIT_RUN_ID = runId;
  if (outputPath === undefined) delete childEnvironment.CAELUSH_PROMPT_CACHE_AUDIT_OUTPUT_PATH;
  else childEnvironment.CAELUSH_PROMPT_CACHE_AUDIT_OUTPUT_PATH = outputPath;
  if (checkpointPath === undefined)
    delete childEnvironment.CAELUSH_PROMPT_CACHE_AUDIT_CHECKPOINT_PATH;
  else childEnvironment.CAELUSH_PROMPT_CACHE_AUDIT_CHECKPOINT_PATH = checkpointPath;
  if (probeFingerprint === undefined)
    delete childEnvironment.CAELUSH_PROMPT_CACHE_PROBE_FINGERPRINT;
  else childEnvironment.CAELUSH_PROMPT_CACHE_PROBE_FINGERPRINT = probeFingerprint;
  delete childEnvironment.CAELUSH_PROMPT_CACHE_AUDIT_DISPATCH_TOKEN;
  if (mode !== "local-fixture") {
    childEnvironment.CAELUSH_PROMPT_CACHE_AUDIT_DISPATCH_TOKEN = dispatchToken;
  }
  delete childEnvironment.DEEPSEEK_API_KEY;
  if (mode === "local-fixture") {
    delete childEnvironment.CAELUSH_PROVIDER_ID;
    delete childEnvironment.CAELUSH_PROVIDER_API_KEY;
  }
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: childEnvironment,
    stdio: "pipe",
  });
  return result;
}

async function runLocalFixtureMode() {
  const result = runVitest("local-fixture");
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status === 0 ? 0 : 1;
}

async function runProbeMode(runId) {
  return withPaidAttemptLock(async (directory, dispatchToken) => {
    const artifacts = getAuditArtifactNames(runId);
    const reportPath = resolve(directory, artifacts.probe);
    const checkpointPath = resolve(directory, artifacts.probeCheckpoint);
    const credentialStatus = getRotatedDeepSeekCredentialStatus(process.env);
    const checkpointExists = await pathExists(checkpointPath);
    if (await pathExists(reportPath)) {
      const existing = await readSafeReport(reportPath);
      const safeToStartFirstProbe =
        existing?.abortReason === "ROTATED_CREDENTIAL_MISSING" &&
        existing.providerCallCount === 0 &&
        credentialStatus === "PRESENT";
      if (!safeToStartFirstProbe) {
        if (
          credentialStatus === "MISSING" &&
          checkpointExists &&
          existing?.abortReason === "ROTATED_CREDENTIAL_MISSING"
        ) {
          process.stdout.write('{"abortReason":"PROBE_CHECKPOINT_EXISTS"}\n');
        } else if (existing !== undefined) printSummary(existing);
        else process.stdout.write('{"abortReason":"PROBE_ALREADY_ATTEMPTED"}\n');
        process.exitCode = 2;
        return;
      }
    }

    if (credentialStatus === "MISSING") {
      if (checkpointExists) {
        process.stdout.write('{"abortReason":"PROBE_CHECKPOINT_EXISTS"}\n');
        process.exitCode = 2;
        return;
      }
      const settings = {
        mode: "probe",
        expectedScoredCount: 0,
        credentialStatus,
      };
      const report = createEmptySafeReport(settings, "ROTATED_CREDENTIAL_MISSING");
      await writeAuditReportAtomic(reportPath, report);
      printSummary(report);
      process.exitCode = 2;
      return;
    }

    const result = runVitest("probe", reportPath, checkpointPath, undefined, dispatchToken, runId);
    const report = await readSafeReport(reportPath);
    if (report !== undefined) printSummary(report);
    else process.stdout.write('{"abortReason":"PROVIDER_REQUEST_FAILED"}\n');
    process.exitCode = result.status === 0 && report?.probeStatus === "PASS" ? 0 : 2;
  });
}

async function run42Mode(runId) {
  return withPaidAttemptLock(async (directory, dispatchToken) => {
    const artifacts = getAuditArtifactNames(runId);
    const probePath = resolve(directory, artifacts.probe);
    const outputPath = resolve(directory, artifacts.run42);
    if (await pathExists(outputPath)) {
      const existing = await readSafeReport(outputPath);
      if (existing !== undefined) printSummary(existing);
      else process.stdout.write('{"abortReason":"RUN_ALREADY_ATTEMPTED"}\n');
      process.exitCode = 2;
      return;
    }

    const probe = await readSafeReport(probePath);
    if (
      probe?.probeStatus !== "PASS" ||
      probe.providerCallCount !== 3 ||
      !isFingerprint(probe.configurationFingerprint)
    ) {
      process.stdout.write('{"abortReason":"PROBE_NOT_PASSED"}\n');
      process.exitCode = 2;
      return;
    }

    const credentialStatus = getRotatedDeepSeekCredentialStatus(process.env);
    if (credentialStatus === "MISSING") {
      process.stdout.write('{"abortReason":"ROTATED_CREDENTIAL_MISSING"}\n');
      process.exitCode = 2;
      return;
    }

    const checkpointPath = resolve(directory, artifacts.run42Checkpoint);
    const result = runVitest(
      "run-42",
      outputPath,
      checkpointPath,
      probe.configurationFingerprint,
      dispatchToken,
      runId,
    );
    const report = await readSafeReport(outputPath);
    if (report !== undefined) printSummary(report);
    else process.stdout.write('{"abortReason":"PROVIDER_REQUEST_FAILED"}\n');
    process.exitCode = result.status === 0 && report?.exitGatePassed === true ? 0 : 2;
  });
}

async function withPaidAttemptLock(action) {
  const directory = await externalNotesDirectory();
  const releaseLock = await acquireAuditAttemptLock(resolve(directory, PAID_ATTEMPT_LOCK_FILE));
  if (releaseLock === null) {
    process.stdout.write('{"abortReason":"PAID_ATTEMPT_LOCKED"}\n');
    process.exitCode = 2;
    return;
  }
  try {
    await action(directory, releaseLock.identity);
  } finally {
    await releaseLock.release();
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--local-fixture") return runLocalFixtureMode();
  const requestedRunId = process.argv[3] ?? DEFAULT_AUDIT_RUN_ID;
  if (!AUDIT_RUN_ID_PATTERN.test(requestedRunId)) {
    process.stderr.write("Audit run identifier is invalid.\n");
    process.exitCode = 2;
    return;
  }
  if (mode === "--probe") return runProbeMode(requestedRunId);
  if (mode === "--run-42") return run42Mode(requestedRunId);
  process.stderr.write("Expected one of: --local-fixture, --probe [run-id], --run-42 [run-id].\n");
  process.exitCode = 2;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch {
    process.stderr.write("DeepSeek prompt cache audit could not complete safely.\n");
    process.exitCode = 2;
  }
}
