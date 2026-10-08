import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const PURPOSES = new Set([
  "MAIN_AGENT",
  "VERIFICATION_LLM",
  "CONTEXT_COMPACTION",
  "WARMUP",
  "RETRY",
  "COMPACTION",
  "TITLE",
  "OTHER",
]);
const USAGE_FIELDS = ["inputTokens", "hitTokens", "missTokens", "writeTokens"];
const UNREPORTED = "UNREPORTED";
const ROLLING_WINDOW_SIZE = 10;

/**
 * Evaluate provider usage against the prompt-cache acceptance contract.
 *
 * The returned object contains only bounded counters, rates, and sample indexes. It never copies
 * sample identifiers or arbitrary sample fields into the report.
 */
export function evaluatePromptCacheAudit(samples, options) {
  if (!Array.isArray(samples)) {
    throw new TypeError("Prompt cache audit samples must be an array.");
  }
  const settings = normalizeOptions(options);
  const statuses = [];
  const scored = [];
  const identifiedSamples = [];
  const callIds = new Set();
  let unknownUsageCount = 0;
  let duplicateCallIdCount = 0;
  let missingCallIdCount = 0;
  let scoredUsageReported = true;
  let allSamplesUsageReported = true;
  let inputTotal = 0;
  let hitTotal = 0;
  let missTotal = 0;
  let writeTotal = 0;
  let inputTotalReported = true;
  let hitTotalReported = true;
  let missTotalReported = true;
  let writeTotalReported = true;

  for (const [index, sample] of samples.entries()) {
    if (typeof sample !== "object" || sample === null || Array.isArray(sample)) {
      throw new TypeError("Prompt cache audit sample is invalid.");
    }
    if (!PURPOSES.has(sample.purpose)) {
      throw new TypeError("Prompt cache audit purpose is unsupported.");
    }

    if (typeof sample.callId !== "string" || sample.callId.trim().length === 0) {
      missingCallIdCount += 1;
      statuses.push({ index, status: UNREPORTED });
      continue;
    }
    if (callIds.has(sample.callId)) {
      duplicateCallIdCount += 1;
      statuses.push({ index, status: "DUPLICATE" });
      continue;
    }
    callIds.add(sample.callId);
    identifiedSamples.push({ index, sample });

    const shouldScore =
      sample.purpose === "MAIN_AGENT" &&
      sample.success === true &&
      sample.eligible === true &&
      !hasResetReason(sample.resetReason);

    const reported = Object.fromEntries(
      USAGE_FIELDS.map((field) => [field, isTokenCount(sample[field])]),
    );
    for (const field of USAGE_FIELDS) {
      if (!reported[field]) {
        if (field === "inputTokens") inputTotalReported = false;
        if (field === "hitTokens") hitTotalReported = false;
        if (field === "missTokens") missTotalReported = false;
        if (field === "writeTokens") writeTotalReported = false;
      }
    }
    if (reported.inputTokens) inputTotal += sample.inputTokens;
    if (reported.hitTokens) hitTotal += sample.hitTokens;
    if (reported.missTokens) missTotal += sample.missTokens;
    if (reported.writeTokens) writeTotal += sample.writeTokens;

    const usageComplete = USAGE_FIELDS.every((field) => reported[field]);
    if (!usageComplete) {
      unknownUsageCount += 1;
      allSamplesUsageReported = false;
      if (shouldScore && (!reported.hitTokens || !reported.missTokens)) {
        scoredUsageReported = false;
      }
      statuses.push({ index, status: UNREPORTED });
    } else if (!shouldScore) {
      statuses.push({ index, status: "EXCLUDED" });
    } else {
      statuses.push({ index, status: "SCORED" });
    }

    if (shouldScore) {
      if (!reported.hitTokens || !reported.missTokens) scoredUsageReported = false;
      else scored.push({ hitTokens: sample.hitTokens, missTokens: sample.missTokens });
    }
  }

  const hitMissTotal = scored.reduce(
    (total, sample) => total + sample.hitTokens + sample.missTokens,
    0,
  );
  const identityIntegrityFailure = duplicateCallIdCount > 0 || missingCallIdCount > 0;
  const billingHitRate =
    !scoredUsageReported || identityIntegrityFailure || hitMissTotal === 0
      ? UNREPORTED
      : scoredHitTotal(scored) / hitMissTotal;
  const metricsV2 = projectOfflineCacheMetricsV2(identifiedSamples, missingCallIdCount);
  const identifiedCallCount = callIds.size;
  const hiddenCallCount = Math.max(0, settings.observedProviderCallCount - identifiedCallCount);
  const unaccountedSampleCount = Math.max(
    0,
    identifiedCallCount - settings.observedProviderCallCount,
  );
  const providerInventoryComplete =
    hiddenCallCount === 0 &&
    unaccountedSampleCount === 0 &&
    duplicateCallIdCount === 0 &&
    missingCallIdCount === 0;
  const passed =
    scored.length === settings.expectedScoredCount &&
    typeof billingHitRate === "number" &&
    billingHitRate >= settings.minimumBillingHitRate &&
    unknownUsageCount === 0 &&
    duplicateCallIdCount === 0 &&
    missingCallIdCount === 0 &&
    hiddenCallCount === 0 &&
    unaccountedSampleCount === 0;
  const totalsReported = providerInventoryComplete && allSamplesUsageReported;

  return {
    billingHitRate,
    metricsV2,
    ...(settings.legacyFixtureCompatibility ? { compatibilityMode: "LEGACY_FIXTURE_INPUTS" } : {}),
    scoredCount: scored.length,
    totalCallCount: settings.observedProviderCallCount,
    unknownUsageCount,
    duplicateCallIdCount,
    missingCallIdCount,
    hiddenCallCount,
    unaccountedSampleCount,
    totalInputTokens: inputTotalReported && totalsReported ? inputTotal : UNREPORTED,
    totalHitTokens: hitTotalReported && totalsReported ? hitTotal : UNREPORTED,
    totalMissTokens: missTotalReported && totalsReported ? missTotal : UNREPORTED,
    totalWriteTokens: writeTotalReported && totalsReported ? writeTotal : UNREPORTED,
    sampleStatuses: statuses,
    passed,
  };
}

function normalizeOptions(options) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Prompt cache audit options are invalid.");
  }
  const expectedScoredCount = options.expectedScoredCount ?? 40;
  const observedProviderCallCount = options.observedProviderCallCount;
  const minimumBillingHitRate = options.minimumBillingHitRate ?? 0.97;
  const legacyFixtureCompatibility = options.legacyFixtureCompatibility ?? false;

  if (!isTokenCount(expectedScoredCount) || !isTokenCount(observedProviderCallCount)) {
    throw new TypeError("Prompt cache audit request counts are invalid.");
  }
  if (!isRate(minimumBillingHitRate) || typeof legacyFixtureCompatibility !== "boolean") {
    throw new TypeError("Prompt cache audit thresholds are invalid.");
  }

  return {
    expectedScoredCount,
    observedProviderCallCount,
    minimumBillingHitRate,
    legacyFixtureCompatibility,
  };
}

function isTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function hasResetReason(value) {
  return value !== undefined && value !== null && value !== "";
}

function scoredHitTotal(samples) {
  return samples.reduce((total, sample) => total + sample.hitTokens, 0);
}

function projectOfflineCacheMetricsV2(identifiedSamples, unidentifiedRequestCount) {
  const ordered = [...identifiedSamples].sort((left, right) => {
    const leftTime = safeObservedAt(left.sample);
    const rightTime = safeObservedAt(right.sample);
    if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    // Captured array order is the durable request order when timestamps tie or are absent.
    return left.index - right.index;
  });
  const samples = ordered.map(({ sample }) => sample);
  const complete = samples.filter(hasCompleteCacheUsage);
  const main = samples.filter((sample) => sample.purpose === "MAIN_AGENT");
  const warm = selectWarmSamples(samples);
  const warmMain = warm.filter((sample) => sample.purpose === "MAIN_AGENT");
  const rolling = complete.filter(hasPositiveCacheDenominator).slice(-ROLLING_WINDOW_SIZE);
  const rollingMain = complete
    .filter((sample) => sample.purpose === "MAIN_AGENT" && hasPositiveCacheDenominator(sample))
    .slice(-ROLLING_WINDOW_SIZE);
  const completeCacheUsageCount = complete.length;
  const observedRequestCount = samples.length;
  const providerUsageUnreportedCount = samples.filter(
    (sample) => !hasAnyProviderUsage(sample),
  ).length;
  const providerUsageWithoutCacheBreakdownCount = samples.filter(
    (sample) => hasAnyProviderUsage(sample) && !hasCompleteCacheUsage(sample),
  ).length;
  return {
    fullRun: { mainAgent: rateView(main), allPurposes: rateView(samples) },
    warm: { mainAgent: rateView(warmMain), allPurposes: rateView(warm) },
    rolling: {
      windowSize: ROLLING_WINDOW_SIZE,
      mainAgent: rateView(rollingMain),
      allPurposes: rateView(rolling),
    },
    latestRequest: projectLatestRequest(samples.at(-1)),
    previousInputCoverageProxy: projectPreviousInputCoverageProxy(main),
    usageCoverage: {
      observedRequestCount,
      completeCacheUsageCount,
      incompleteOrUnknownCount: observedRequestCount - completeCacheUsageCount,
      providerUsageUnreportedCount,
      providerUsageWithoutCacheBreakdownCount,
      failedOrCancelledWithoutUsageCount: samples.filter(
        (sample) => sample.success === false && !hasAnyProviderUsage(sample),
      ).length,
      inProgressInvocationCount: 0,
      missingInvocationRecordCount: 0,
      legacyWithoutCacheBreakdownCount: 0,
      unidentifiedLegacySampleCount: unidentifiedRequestCount,
      ...(observedRequestCount === 0
        ? {}
        : { coverageRate: completeCacheUsageCount / observedRequestCount }),
      status:
        observedRequestCount === 0
          ? UNREPORTED
          : completeCacheUsageCount === observedRequestCount
            ? "REPORTED"
            : completeCacheUsageCount === 0
              ? UNREPORTED
              : "PARTIAL",
    },
  };
}

function rateView(samples) {
  let requestCount = 0;
  let hitTokens = 0;
  let accountedTokens = 0;
  for (const sample of samples) {
    if (!hasCompleteCacheUsage(sample)) continue;
    const hit = sample.hitTokens;
    const miss = sample.missTokens;
    const denominator = safeCountSum(hit, miss);
    if (denominator === 0) continue;
    requestCount += 1;
    hitTokens = safeCountSum(hitTokens, hit);
    accountedTokens = safeCountSum(accountedTokens, denominator);
  }
  return {
    requestCount,
    hitTokens,
    accountedTokens,
    ...(accountedTokens === 0 ? {} : { hitRate: hitTokens / accountedTokens }),
  };
}

function selectWarmSamples(samples) {
  const boundaryByEpoch = new Map();
  for (const [index, sample] of samples.entries()) {
    if (
      sample.purpose !== "MAIN_AGENT" ||
      sample.eligible !== true ||
      typeof sample.epochId !== "string" ||
      sample.epochId.length === 0
    ) {
      continue;
    }
    const epochKey = `${sample.continuityGroup ?? ""}\u0000${sample.epochId}`;
    if (!boundaryByEpoch.has(epochKey) || hasResetReason(sample.resetReason)) {
      boundaryByEpoch.set(epochKey, index);
    }
  }
  return samples.filter((sample, index) => {
    if (typeof sample.epochId !== "string" || sample.epochId.length === 0) return false;
    const epochKey = `${sample.continuityGroup ?? ""}\u0000${sample.epochId}`;
    const boundary = boundaryByEpoch.get(epochKey);
    return boundary !== undefined && index > boundary;
  });
}

function projectPreviousInputCoverageProxy(mainSamples) {
  for (let index = mainSamples.length - 1; index > 0; index -= 1) {
    const current = mainSamples[index];
    const previous = mainSamples[index - 1];
    if (
      typeof current.epochId !== "string" ||
      current.epochId !== previous.epochId ||
      typeof current.continuityGroup !== "string" ||
      current.continuityGroup !== previous.continuityGroup ||
      typeof current.prefixFingerprint !== "string" ||
      current.prefixFingerprint !== previous.prefixFingerprint ||
      !hasCompleteCacheUsage(current) ||
      !isTokenCount(previous.inputTokens) ||
      previous.inputTokens === 0
    ) {
      return UNREPORTED;
    }
    const hitTokens = Math.min(current.hitTokens, previous.inputTokens);
    return {
      classification: "DIAGNOSTIC_PROXY",
      hitTokens,
      previousInputTokens: previous.inputTokens,
      coverage: hitTokens / previous.inputTokens,
    };
  }
  return UNREPORTED;
}

function projectLatestRequest(sample) {
  if (sample === undefined) return UNREPORTED;
  return {
    purpose: sample.purpose,
    ...(isTokenCount(sample.inputTokens) ? { inputTokens: sample.inputTokens } : {}),
    ...(isTokenCount(sample.hitTokens) ? { hitTokens: sample.hitTokens } : {}),
    ...(isTokenCount(sample.missTokens) ? { missTokens: sample.missTokens } : {}),
    ...(isTokenCount(sample.writeTokens) ? { writeTokens: sample.writeTokens } : {}),
    cacheUsageReported: hasCompleteCacheUsage(sample),
  };
}

function hasCompleteCacheUsage(sample) {
  return isTokenCount(sample.hitTokens) && isTokenCount(sample.missTokens);
}

function hasAnyProviderUsage(sample) {
  return [
    sample.totalTokens,
    sample.inputTokens,
    sample.outputTokens,
    sample.hitTokens,
    sample.missTokens,
    sample.writeTokens,
  ].some(isTokenCount);
}

function hasPositiveCacheDenominator(sample) {
  return hasCompleteCacheUsage(sample) && safeCountSum(sample.hitTokens, sample.missTokens) > 0;
}

function safeCountSum(left, right) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError("Provider cache usage exceeds the safe integer range.");
  }
  return total;
}

function safeObservedAt(sample) {
  return Number.isSafeInteger(sample.observedAt) && sample.observedAt >= 0
    ? sample.observedAt
    : undefined;
}

async function runOfflineFixture() {
  const fixtureUrl = new URL("./fixtures/prompt-cache-audit-boundaries.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  if (!Array.isArray(fixture.cases)) {
    throw new TypeError("Prompt cache audit fixture is invalid.");
  }

  const cases = fixture.cases.map((entry) => {
    const result = evaluatePromptCacheAudit(entry.samples, {
      ...entry.options,
      legacyFixtureCompatibility: true,
    });
    return {
      name: entry.name,
      billingHitRate: result.billingHitRate,
      metricsV2: result.metricsV2,
      scoredCount: result.scoredCount,
      totalCallCount: result.totalCallCount,
      unknownUsageCount: result.unknownUsageCount,
      duplicateCallIdCount: result.duplicateCallIdCount,
      missingCallIdCount: result.missingCallIdCount,
      hiddenCallCount: result.hiddenCallCount,
      totalInputTokens: result.totalInputTokens,
      totalHitTokens: result.totalHitTokens,
      totalMissTokens: result.totalMissTokens,
      totalWriteTokens: result.totalWriteTokens,
      passed: result.passed,
      fixtureExpectationMet: result.passed === entry.expectedPassed,
    };
  });
  const fixtureCheckPassed = cases.every((entry) => entry.fixtureExpectationMet);
  process.stdout.write(
    JSON.stringify(
      { compatibilityMode: "LEGACY_FIXTURE_INPUTS", fixtureCheckPassed, cases },
      null,
      2,
    ) + "\n",
  );
  if (!fixtureCheckPassed) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await runOfflineFixture();
  } catch {
    process.stderr.write("Offline prompt cache audit fixture could not be evaluated.\n");
    process.exitCode = 1;
  }
}
