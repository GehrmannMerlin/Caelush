import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const PURPOSES = new Set(["MAIN_AGENT", "WARMUP", "RETRY", "COMPACTION", "TITLE", "OTHER"]);
const USAGE_FIELDS = ["inputTokens", "hitTokens", "missTokens", "writeTokens"];
const UNREPORTED = "UNREPORTED";

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
  let reusablePrefixReported = true;

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
      if (shouldScore) scoredUsageReported = false;
      statuses.push({ index, status: UNREPORTED });
      continue;
    }

    if (!shouldScore) {
      statuses.push({ index, status: "EXCLUDED" });
      continue;
    }

    const expectedPrefix = sample.expectedReusablePrefixTokens;
    if (!isTokenCount(expectedPrefix)) reusablePrefixReported = false;
    scored.push({
      hitTokens: sample.hitTokens,
      missTokens: sample.missTokens,
      expectedReusablePrefixTokens: expectedPrefix,
    });
    statuses.push({ index, status: "SCORED" });
  }

  const hitMissTotal = scored.reduce(
    (total, sample) => total + sample.hitTokens + sample.missTokens,
    0,
  );
  const expectedPrefixTotal = reusablePrefixReported
    ? scored.reduce((total, sample) => total + sample.expectedReusablePrefixTokens, 0)
    : 0;
  const reusableHitTotal = reusablePrefixReported
    ? scored.reduce(
        (total, sample) => total + Math.min(sample.hitTokens, sample.expectedReusablePrefixTokens),
        0,
      )
    : 0;
  const identityIntegrityFailure = duplicateCallIdCount > 0 || missingCallIdCount > 0;
  const billingHitRate =
    !scoredUsageReported || identityIntegrityFailure || hitMissTotal === 0
      ? UNREPORTED
      : scoredHitTotal(scored) / hitMissTotal;
  const reusablePrefixEfficiency =
    !scoredUsageReported ||
    identityIntegrityFailure ||
    !reusablePrefixReported ||
    expectedPrefixTotal === 0
      ? UNREPORTED
      : reusableHitTotal / expectedPrefixTotal;
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
    typeof reusablePrefixEfficiency === "number" &&
    reusablePrefixEfficiency >= settings.minimumReusablePrefixEfficiency &&
    unknownUsageCount === 0 &&
    duplicateCallIdCount === 0 &&
    missingCallIdCount === 0 &&
    hiddenCallCount === 0 &&
    unaccountedSampleCount === 0;
  const totalsReported = providerInventoryComplete && allSamplesUsageReported;

  return {
    billingHitRate,
    reusablePrefixEfficiency,
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
  const minimumReusablePrefixEfficiency = options.minimumReusablePrefixEfficiency ?? 0.99;

  if (!isTokenCount(expectedScoredCount) || !isTokenCount(observedProviderCallCount)) {
    throw new TypeError("Prompt cache audit request counts are invalid.");
  }
  if (!isRate(minimumBillingHitRate) || !isRate(minimumReusablePrefixEfficiency)) {
    throw new TypeError("Prompt cache audit thresholds are invalid.");
  }

  return {
    expectedScoredCount,
    observedProviderCallCount,
    minimumBillingHitRate,
    minimumReusablePrefixEfficiency,
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

async function runOfflineFixture() {
  const fixtureUrl = new URL("./fixtures/prompt-cache-audit-boundaries.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  if (!Array.isArray(fixture.cases)) {
    throw new TypeError("Prompt cache audit fixture is invalid.");
  }

  const cases = fixture.cases.map((entry) => {
    const result = evaluatePromptCacheAudit(entry.samples, entry.options);
    return {
      name: entry.name,
      billingHitRate: result.billingHitRate,
      reusablePrefixEfficiency: result.reusablePrefixEfficiency,
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
  process.stdout.write(JSON.stringify({ fixtureCheckPassed, cases }, null, 2) + "\n");
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
