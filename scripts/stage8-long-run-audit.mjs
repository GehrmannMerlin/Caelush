import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  computeDeepSeekCostNanoDollars,
  createIrreversibleFingerprint,
  getDeepSeekPricingPeriod,
} from "./deepseek-prompt-cache-audit.mjs";

export const STAGE8_LIMITS = Object.freeze({
  maxMainCalls: 36,
  maxProviderCalls: 44,
  maxToolInvocations: 120,
  maxElapsedMs: 7_200_000,
  minimumSegmentSamples: 3,
  minimumBillingHitRateExclusive: 0.9,
  minimumReusablePrefixEfficiency: 0.99,
  reusablePrefixAnomalyFloor: 0.9,
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOTES_ROOT = "D:\\Develop\\Caelush-work-notes\\prompt-cache-97";
const SCENARIO_ROOT = resolve(NOTES_ROOT, "scenarios");
const FROZEN_PROMPT_PATH = resolve(NOTES_ROOT, "stage-8-agent-task-prompt.md");
const FROZEN_PROMPT_SHA256 = "98acd3d25d4d87eb7500cc1aab0f9f77993f2c5af71c47c0212dc133ab3a0dc0";
const VITEST_ENTRY = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ATTEMPT_ID = /^attempt-[1-9][0-9]{0,2}$/;
const PURPOSES = new Set(["MAIN_AGENT", "COMPACTION", "RETRY", "TITLE", "OTHER", "UNKNOWN"]);
const RESET_REASONS = new Set([
  "INITIAL",
  "MODEL_CHANGED",
  "TOOL_SCHEMA_CHANGED",
  "STABLE_HEAD_CHANGED",
  "CACHE_SETTINGS_CHANGED",
  "COMPACTION_COMMITTED",
  "RECOVERY_INCOMPATIBLE",
]);
const DEFAULT_DAEMON_URL = "http://127.0.0.1:43120";

export const Stage8PreflightSchema = Object.freeze({
  parse(value) {
    const allowed = new Set([
      "schemaVersion",
      "daemonIdentityFingerprint",
      "productHomeFingerprint",
      "providerId",
      "configured",
      "source",
      "writable",
      "discoveryState",
      "selectedProvider",
      "selectedModel",
      "reasoningLevel",
      "modelCapabilities",
      "fullAccessPolicy",
      "processSandbox",
      "status",
    ]);
    assertClosedRecord(value, allowed, "Preflight artifact");
    if (
      value.schemaVersion !== 1 ||
      !FINGERPRINT.test(value.daemonIdentityFingerprint ?? "") ||
      !FINGERPRINT.test(value.productHomeFingerprint ?? "") ||
      typeof value.providerId !== "string" ||
      typeof value.configured !== "boolean" ||
      !["NONE", "LOCAL", "ENVIRONMENT"].includes(value.source) ||
      typeof value.writable !== "boolean" ||
      !["NOT_CONFIGURED", "READY", "FAILED"].includes(value.discoveryState) ||
      !["READY", "INCOMPLETE"].includes(value.status)
    ) {
      throw new TypeError("Preflight artifact fields are invalid.");
    }
    const capabilityKeys = new Set([
      "toolCalling",
      "promptCaching",
      "usageReporting",
      "contextWindowTokens",
    ]);
    assertClosedRecord(value.modelCapabilities, capabilityKeys, "Model capability projection");
    for (const field of ["toolCalling", "promptCaching", "usageReporting"]) {
      if (!["SUPPORTED", "UNSUPPORTED", "UNKNOWN"].includes(value.modelCapabilities[field])) {
        throw new TypeError("Model capability projection is invalid.");
      }
    }
    if (
      value.modelCapabilities.contextWindowTokens !== undefined &&
      (!Number.isSafeInteger(value.modelCapabilities.contextWindowTokens) ||
        value.modelCapabilities.contextWindowTokens < 1)
    ) {
      throw new TypeError("Model context window projection is invalid.");
    }
    assertClosedRecord(
      value.fullAccessPolicy,
      new Set([
        "filesystemBoundary",
        "processBoundary",
        "requiredEnforcement",
        "requiresConfirmation",
      ]),
      "Full access policy projection",
    );
    assertClosedRecord(
      value.processSandbox,
      new Set(["status", "enforcement"]),
      "Process sandbox projection",
    );
    return JSON.parse(JSON.stringify(value));
  },
});

export function projectSafeProviderStatus(provider) {
  const allowed = new Set([
    "id",
    "displayName",
    "credentialConfigured",
    "credentialSource",
    "credentialWritable",
    "discoveryState",
    "discoveryError",
  ]);
  assertClosedRecord(provider, allowed, "Provider view");
  const result = {
    providerId: provider.id,
    configured: provider.credentialConfigured,
    source: provider.credentialSource,
    writable: provider.credentialWritable,
    discoveryState: provider.discoveryState,
  };
  if (
    typeof result.providerId !== "string" ||
    typeof result.configured !== "boolean" ||
    !["NONE", "LOCAL", "ENVIRONMENT"].includes(result.source) ||
    typeof result.writable !== "boolean" ||
    !["NOT_CONFIGURED", "READY", "FAILED"].includes(result.discoveryState)
  ) {
    throw new TypeError("Provider credential status is invalid.");
  }
  return result;
}

export function createStage8AttemptCheckpoint({ attemptId }) {
  assertAttemptId(attemptId);
  return {
    schemaVersion: 1,
    attemptId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionId: null,
    runId: null,
    workspaceId: null,
    workspacePathFingerprint: null,
    sessionCreationStatus: "NOT_STARTED",
    runCreationStatus: "NOT_STARTED",
    executionStartStatus: "NOT_STARTED",
    runStartRequestedAt: null,
    lastDurableEventSequence: 0,
    startedAt: null,
    providerCallCount: 0,
    mainCallCount: 0,
    auxiliaryCallCount: 0,
    scoredMainCallCount: 0,
    preCompactionScoredMainCallCount: 0,
    postCompactionScoredMainCallCount: 0,
    toolInvocationCount: 0,
    unknownUsageCount: 0,
    unexplainedResetCount: 0,
    duplicateSnapshotCount: 0,
    hiddenCallCount: 0,
    lastEpochFingerprint: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalHitTokens: 0,
    totalMissTokens: 0,
    totalWriteTokens: 0,
    totalCostNanoUsd: "0",
    costStatus: "RECONCILED",
    coldWarmupConsumed: false,
    compactionCount: 0,
    compaction: null,
    samples: [],
    seenSnapshotFingerprints: [],
    inFlight: null,
    abortReason: null,
    terminalState: "UNKNOWN",
  };
}

export async function createOrResolveStage8Run({
  client,
  attemptId,
  workspaceRoot,
  prompt,
  preflight,
  checkpoint,
  persist,
}) {
  assertAttemptId(attemptId);
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new TypeError("The frozen Stage 8 task input is unavailable.");
  }
  if (typeof persist !== "function") {
    throw new TypeError("Stage 8 Run creation requires an atomic checkpoint writer.");
  }
  if (
    preflight?.providerId !== "deepseek" ||
    preflight.selectedProvider !== "deepseek" ||
    typeof preflight.selectedModel !== "string" ||
    preflight.selectedModel.length === 0
  ) {
    throw new Error("Stage 8 model selection is not the admitted DeepSeek model.");
  }

  let state = cloneState(checkpoint);
  if (state.attemptId !== attemptId || state.abortReason !== null) {
    throw new Error("Stage 8 checkpoint does not admit Run creation.");
  }
  const canonicalWorkspacePath = resolve(workspaceRoot);
  const workspacePathFingerprint = createIrreversibleFingerprint(canonicalWorkspacePath);
  const workspaceResponse = await client.listWorkspaces();
  const workspaceMatches = workspaceResponse.items.filter(
    (workspace) =>
      typeof workspace.canonicalPath === "string" &&
      sameLocalPath(workspace.canonicalPath, canonicalWorkspacePath),
  );
  if (workspaceMatches.length !== 1) {
    throw new Error("The exact Stage 8 attempt workspace is not uniquely registered.");
  }
  const workspace = workspaceMatches[0];
  if (state.workspaceId !== null && state.workspaceId !== workspace.id) {
    throw new Error("The Stage 8 workspace identity changed after checkpointing.");
  }
  state.workspaceId = workspace.id;
  state.workspacePathFingerprint = workspacePathFingerprint;
  state = await persist(state);

  const sessionTitle = `Stage 8 ${attemptId}`;
  const sessions = (await client.listSessions({ limit: 100 })).items.filter(
    (session) =>
      session.title === sessionTitle &&
      (session.workspaceId === workspace.id || session.defaultWorkspace?.id === workspace.id),
  );
  if (sessions.length > 1) {
    throw new Error("The Stage 8 session identity is ambiguous.");
  }

  let session = sessions[0];
  if (state.sessionId !== null && session?.id !== state.sessionId) {
    throw new Error("The checkpointed Stage 8 session is unavailable in its workspace.");
  }
  if (session === undefined) {
    if (state.sessionCreationStatus === "IN_FLIGHT") {
      throw new Error("The prior Stage 8 Session creation outcome is unresolved.");
    }
    state.sessionCreationStatus = "IN_FLIGHT";
    state = await persist(state);
    session = await client.createSession({
      title: sessionTitle,
      defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
      defaultModel: { provider: "deepseek", model: preflight.selectedModel },
      ...(preflight.reasoningLevel === undefined
        ? {}
        : { defaultReasoningLevel: preflight.reasoningLevel }),
    });
  }
  if (session.workspaceId !== workspace.id && session.defaultWorkspace?.id !== workspace.id) {
    throw new Error("The Stage 8 Session is associated with a different workspace.");
  }
  state.sessionId = session.id;
  state.sessionCreationStatus = "COMMITTED";
  state = await persist(state);

  const runs = (await client.listRuns(session.id, { limit: 100 })).items;
  let run;
  if (state.runId !== null) {
    run = runs.find((candidate) => candidate.id === state.runId);
    if (run === undefined) {
      throw new Error("The checkpointed Stage 8 Run is unavailable in its Session.");
    }
  } else if (state.runCreationStatus === "IN_FLIGHT") {
    if (runs.length !== 1) {
      throw new Error("The prior Stage 8 Run creation outcome is unresolved.");
    }
    run = runs[0];
  } else {
    if (state.runCreationStatus !== "NOT_STARTED" || runs.length !== 0) {
      throw new Error("The Stage 8 Session already contains an uncheckpointed Run.");
    }
    state.runCreationStatus = "IN_FLIGHT";
    state = await persist(state);
    run = await client.createRun(session.id, {
      goal: prompt,
      workspace: { id: workspace.id, path: workspace.canonicalPath },
      model: { provider: "deepseek", model: preflight.selectedModel },
      ...(preflight.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: preflight.reasoningLevel }),
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: {
        maxSteps: STAGE8_LIMITS.maxMainCalls,
        maxToolCalls: STAGE8_LIMITS.maxToolInvocations,
        timeoutMs: STAGE8_LIMITS.maxElapsedMs,
      },
    });
  }

  if (
    run.sessionId !== session.id ||
    run.goal !== prompt ||
    run.workspace?.id !== workspace.id ||
    !sameLocalPath(run.workspace?.path ?? "", canonicalWorkspacePath) ||
    run.model?.provider !== "deepseek" ||
    run.model?.model !== preflight.selectedModel
  ) {
    throw new Error("The Stage 8 Run response does not match the frozen attempt.");
  }
  state.runId = run.id;
  state.runCreationStatus = "COMMITTED";
  state = await persist(state);
  return { run, session, state };
}

function sameLocalPath(left, right) {
  if (typeof left !== "string" || left.length === 0) return false;
  const normalizedLeft = resolve(left).replace(/[\\/]+$/, "");
  const normalizedRight = resolve(right).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

export async function startStage8RunOnce({
  client,
  run,
  checkpoint,
  persist,
  subscribeBeforeStart,
}) {
  if (
    typeof run?.id !== "string" ||
    checkpoint?.runId !== run.id ||
    checkpoint.runCreationStatus !== "COMMITTED" ||
    typeof persist !== "function" ||
    typeof subscribeBeforeStart !== "function"
  ) {
    throw new Error("Stage 8 Run start preconditions are incomplete.");
  }
  let state = cloneState(checkpoint);
  if (state.abortReason !== null) throw new Error("The Stage 8 audit fuse is open.");
  if (state.executionStartStatus === "COMMITTED") {
    return { run, state, disposition: "ALREADY_STARTED" };
  }
  if (state.executionStartStatus === "IN_FLIGHT") {
    throw new Error("The prior Stage 8 Run start outcome is unresolved.");
  }
  if (state.executionStartStatus !== "NOT_STARTED") {
    throw new Error("The Stage 8 Run start checkpoint is invalid.");
  }

  await subscribeBeforeStart(run.id, state.lastDurableEventSequence);
  state.executionStartStatus = "IN_FLIGHT";
  state.runStartRequestedAt = Date.now();
  state = await persist(state);
  const response = await client.startRun(run.id);
  if (
    response?.run?.id !== run.id ||
    !["SCHEDULED", "ALREADY_ACTIVE"].includes(response.disposition)
  ) {
    throw new Error("The daemon did not acknowledge the Stage 8 Run start.");
  }
  state.executionStartStatus = "COMMITTED";
  state = await persist(state);
  return { run: response.run, state, disposition: response.disposition };
}

export async function openStage8RunEventStream(client, runId, afterSequence) {
  if (
    typeof runId !== "string" ||
    typeof client?.watchRunEvents !== "function" ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0
  ) {
    throw new TypeError("Stage 8 Run event stream inputs are invalid.");
  }
  let openedResolve;
  let openedReject;
  let opened = false;
  const opening = new Promise((resolve, reject) => {
    openedResolve = () => {
      opened = true;
      resolve();
    };
    openedReject = reject;
  });
  const controller = new globalThis.AbortController();
  const eventStream = client.watchRunEvents(runId, {
    afterSequence,
    signal: controller.signal,
    onOpen: () => {
      openedResolve();
    },
  });
  const iterator = eventStream[Symbol.asyncIterator]();
  const firstNext = iterator.next();
  void firstNext.then((result) => {
    if (result.done && !opened) openedReject(new Error("Stage 8 Run event stream ended early."));
  }, openedReject);
  let openingTimer;
  try {
    await Promise.race([
      opening,
      new Promise((_, reject) => {
        openingTimer = globalThis.setTimeout(
          () => reject(new Error("Stage 8 Run event stream did not open in time.")),
          15_000,
        );
      }),
    ]);
  } catch (error) {
    controller.abort();
    await iterator.return?.().catch(() => undefined);
    throw error;
  } finally {
    globalThis.clearTimeout(openingTimer);
  }

  const events = {
    async *[Symbol.asyncIterator]() {
      let result = await firstNext;
      while (!result.done) {
        yield result.value;
        result = await iterator.next();
      }
    },
  };
  return {
    events,
    async close() {
      controller.abort();
      await iterator.return?.().catch(() => undefined);
    },
  };
}

export function deriveStage8CallObservation(before, after, eventSequence) {
  const current = after;
  if (
    typeof current !== "object" ||
    current === null ||
    !Number.isSafeInteger(eventSequence) ||
    eventSequence < 1 ||
    !Number.isSafeInteger(current.totalRequestCount) ||
    !Array.isArray(current.purposes)
  ) {
    return null;
  }
  const prior =
    typeof before === "object" && before !== null
      ? before
      : {
          totalRequestCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          hitTokens: 0,
          missTokens: 0,
          writeTokens: 0,
          unknownUsageCount: 0,
          purposes: [],
          epochId: undefined,
          resetReason: undefined,
          resetStepSequence: undefined,
          expectedReusablePrefixTokens: 0,
        };
  const totalRequestDelta = current.totalRequestCount - prior.totalRequestCount;
  if (totalRequestDelta !== 1) return null;

  const priorPurposes = new Map(prior.purposes.map((entry) => [entry.purpose, entry.requestCount]));
  const changedPurposes = current.purposes.filter((entry) => {
    const delta = entry.requestCount - (priorPurposes.get(entry.purpose) ?? 0);
    return delta !== 0;
  });
  const regressedPurposes = current.purposes.some(
    (entry) => entry.requestCount < (priorPurposes.get(entry.purpose) ?? 0),
  );
  if (regressedPurposes || changedPurposes.length !== 1) return null;
  const changedPurpose = changedPurposes[0];
  const priorPurpose = prior.purposes.find((entry) => entry.purpose === changedPurpose.purpose);
  const purposeRequestDelta = changedPurpose.requestCount - (priorPurpose?.requestCount ?? 0);
  if (purposeRequestDelta !== 1 || !PURPOSES.has(changedPurpose.purpose)) return null;

  const totalFields = [
    ["inputTokens", "totalInputTokens"],
    ["outputTokens", "totalOutputTokens"],
    ["hitTokens", "hitTokens"],
    ["missTokens", "missTokens"],
    ["writeTokens", "writeTokens"],
    ["unknownUsageCount", "unknownUsageCount"],
  ];
  const deltas = {};
  for (const [purposeField, totalField] of totalFields) {
    const beforeTotal = prior[totalField] ?? 0;
    const afterTotal = current[totalField];
    const beforePurposeTotal = priorPurpose?.[purposeField] ?? 0;
    const afterPurposeTotal = changedPurpose[purposeField];
    if (
      !Number.isSafeInteger(beforeTotal) ||
      !Number.isSafeInteger(afterTotal) ||
      !Number.isSafeInteger(beforePurposeTotal) ||
      !Number.isSafeInteger(afterPurposeTotal) ||
      afterTotal < beforeTotal ||
      afterPurposeTotal < beforePurposeTotal
    ) {
      return null;
    }
    const totalDelta = afterTotal - beforeTotal;
    const purposeDelta = afterPurposeTotal - beforePurposeTotal;
    if (totalDelta !== purposeDelta) return null;
    deltas[purposeField] = totalDelta;
  }
  if (deltas.unknownUsageCount > 1) return null;

  const surfaceSegments = normalizePromptCacheSegments(current.surfaceSegments);
  if (surfaceSegments === null) return null;
  const currentEpoch = typeof current.epochId === "string" ? current.epochId : null;
  if (currentEpoch === null) return null;
  const previousEpoch = typeof prior.epochId === "string" ? prior.epochId : null;
  const resetStepChanged = current.resetStepSequence !== prior.resetStepSequence;
  let resetReason = resetStepChanged ? normalizeResetReason(current.resetReason) : null;
  if (previousEpoch === null && resetReason === null) resetReason = "INITIAL";
  if (previousEpoch !== null && previousEpoch !== currentEpoch && resetReason === null) {
    resetReason = "UNEXPLAINED";
  }
  const usage =
    deltas.unknownUsageCount === 1
      ? null
      : {
          inputTokens: deltas.inputTokens,
          outputTokens: deltas.outputTokens,
          hitTokens: deltas.hitTokens,
          missTokens: deltas.missTokens,
          writeTokens: deltas.writeTokens,
          expectedReusablePrefixTokens: safeCount(current.expectedReusablePrefixTokens),
          epochFingerprint: createIrreversibleFingerprint(currentEpoch),
          prefixFingerprint: stripFingerprintPrefix(surfaceSegments.prefixFingerprint),
          ...(resetReason === null ? {} : { resetReason }),
        };
  return {
    purpose: changedPurpose.purpose,
    usage,
    surfaceSegments,
    eventSequence,
    snapshotFingerprint: createIrreversibleFingerprint({
      eventSequence,
      totalRequestCount: current.totalRequestCount,
      purpose: changedPurpose.purpose,
    }),
  };
}

export async function consumeStage8RunEvents({
  client,
  events,
  runId,
  checkpoint,
  initialPromptCache,
  persist,
}) {
  if (typeof runId !== "string" || typeof persist !== "function") {
    throw new TypeError("Stage 8 event observation dependencies are invalid.");
  }
  let state = cloneState(checkpoint);
  let previousPromptCache = initialPromptCache ?? null;
  if (previousPromptCache?.epochId && state.lastEpochFingerprint === null) {
    state.lastEpochFingerprint = createIrreversibleFingerprint(previousPromptCache.epochId);
  }
  const cancelAfterFuse = async () => {
    state = await persist(state);
    if (typeof client.cancelRun === "function") {
      await client.cancelRun(runId).catch(() => undefined);
    }
  };

  for await (const event of events) {
    if (event?.runId !== runId) {
      throw new Error("Stage 8 received an event for a different Run.");
    }
    if (event.durability?.kind !== "DURABLE") continue;
    const sequence = event.durability.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("Stage 8 received an invalid durable event sequence.");
    }
    if (sequence <= state.lastDurableEventSequence) continue;
    if (state.abortReason !== null) {
      await cancelAfterFuse();
      break;
    }

    if (event.type === "llm.started") {
      if (state.inFlight !== null) {
        state.abortReason = "OVERLAPPING_PROVIDER_CALLS";
        state.lastDurableEventSequence = sequence;
        await cancelAfterFuse();
        break;
      }
      if (state.providerCallCount >= STAGE8_LIMITS.maxProviderCalls) {
        state.abortReason = "TOTAL_CALL_LIMIT";
        state.lastDurableEventSequence = sequence;
        await cancelAfterFuse();
        break;
      }
      if (state.mainCallCount >= STAGE8_LIMITS.maxMainCalls) {
        state.abortReason = "MAIN_CALL_LIMIT";
        state.lastDurableEventSequence = sequence;
        await cancelAfterFuse();
        break;
      }
      state.lastDurableEventSequence = sequence;
      state.inFlight = {
        callRef: `call-${String(state.providerCallCount + 1).padStart(4, "0")}`,
        purpose: "UNKNOWN",
        intentAt: Date.now(),
        eventSequence: sequence,
      };
      state = await persist(state);
      continue;
    }

    if (event.type === "llm.completed" || event.type === "llm.failed") {
      if (state.inFlight === null) {
        state = recordStage8ProviderSample(
          { ...state, lastDurableEventSequence: sequence },
          {
            purpose: "UNKNOWN",
            outcome: event.type === "llm.completed" ? "SUCCESS" : "FAILED",
            usage: null,
            eventSequence: sequence,
            hiddenProviderCalls: 1,
          },
        );
        await cancelAfterFuse();
        break;
      }
      const startEventSequence = state.inFlight.eventSequence;
      const currentUsage = await client.getRunContextUsage(runId);
      const promptCache = currentUsage?.promptCache ?? null;
      const derived = deriveStage8CallObservation(previousPromptCache, promptCache, sequence);
      const requestDelta =
        Number.isSafeInteger(promptCache?.totalRequestCount) &&
        Number.isSafeInteger(previousPromptCache?.totalRequestCount)
          ? promptCache.totalRequestCount - previousPromptCache.totalRequestCount
          : null;
      state = recordStage8ProviderSample(
        { ...state, lastDurableEventSequence: sequence },
        {
          purpose: derived?.purpose ?? "UNKNOWN",
          outcome: event.type === "llm.completed" ? "SUCCESS" : "FAILED",
          usage: derived?.usage ?? null,
          eventSequence: sequence,
          startEventSequence,
          ...(derived === null
            ? {
                snapshotFingerprint: createIrreversibleFingerprint({
                  eventSequence: sequence,
                  startEventSequence,
                  requestDelta,
                }),
              }
            : derived),
          ...(requestDelta !== null && requestDelta > 1
            ? { hiddenProviderCalls: requestDelta - 1 }
            : {}),
        },
      );
      previousPromptCache = promptCache;
      if (state.abortReason !== null) {
        await cancelAfterFuse();
        break;
      }
      state = await persist(state);
      continue;
    }

    if (event.type === "context.compaction.completed") {
      const currentUsage = await client.getRunContextUsage(runId);
      const promptCache = currentUsage?.promptCache ?? null;
      const beforeFingerprint = state.lastEpochFingerprint;
      const afterFingerprint =
        typeof promptCache?.epochId === "string"
          ? createIrreversibleFingerprint(promptCache.epochId)
          : null;
      state = recordStage8Compaction(
        { ...state, lastDurableEventSequence: sequence },
        {
          sequence,
          reason: event.payload?.reason,
          tokensBefore: event.payload?.tokensBefore,
          tokensAfter: event.payload?.tokensAfter,
          epochBeforeFingerprint: beforeFingerprint,
          epochAfterFingerprint: afterFingerprint,
        },
      );
      previousPromptCache = promptCache;
      if (state.abortReason !== null) {
        await cancelAfterFuse();
        break;
      }
      state = await persist(state);
      continue;
    }

    if (event.type === "tool.requested") {
      state = recordStage8ToolInvocation({
        ...state,
        lastDurableEventSequence: sequence,
      });
      if (state.abortReason !== null) {
        await cancelAfterFuse();
        break;
      }
      state = await persist(state);
      continue;
    }

    state.lastDurableEventSequence = sequence;
    if (event.type === "run.completed") state.terminalState = "COMPLETED";
    else if (event.type === "run.failed") state.terminalState = "FAILED";
    else if (event.type === "run.cancelled") state.terminalState = "CANCELLED";
    else if (event.type === "run.timed_out") state.terminalState = "TIMEOUT";
    else if (
      event.type === "status.changed" &&
      [
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "TIMEOUT",
        "MAX_STEPS_REACHED",
        "BUDGET_EXCEEDED",
      ].includes(event.payload?.to)
    ) {
      state.terminalState = event.payload.to;
    }
    if (state.terminalState !== "UNKNOWN" && previousPromptCache !== null) {
      const observedRequests = previousPromptCache.totalRequestCount;
      if (observedRequests > state.providerCallCount) {
        state.hiddenCallCount = addCount(
          state.hiddenCallCount,
          observedRequests - state.providerCallCount,
        );
        state.abortReason ??= "HIDDEN_PROVIDER_CALL";
      } else if (observedRequests < state.providerCallCount) {
        state.unknownUsageCount = addCount(
          state.unknownUsageCount,
          state.providerCallCount - observedRequests,
        );
        state.costStatus = "UNREPORTED";
        state.abortReason ??= "USAGE_RECONCILIATION_FAILED";
      }
    }
    state = await persist(state);
    if (state.terminalState !== "UNKNOWN") break;
  }
  return state;
}

export async function startAndObserveStage8Run({
  client,
  run,
  checkpoint,
  initialPromptCache,
  persist,
}) {
  if (typeof persist !== "function" || typeof run?.id !== "string") {
    throw new TypeError("Stage 8 Run observation dependencies are invalid.");
  }
  let state = cloneState(checkpoint);
  const save = async (nextState) => {
    state = cloneState(nextState);
    state = cloneState(await persist(state));
    return state;
  };
  let observedRun = run;
  let stream;
  try {
    if (state.executionStartStatus === "NOT_STARTED") {
      if (run.status !== "PENDING") {
        throw new Error("A Stage 8 Run outside PENDING cannot be started as a new attempt.");
      }
      const started = await startStage8RunOnce({
        client,
        run,
        checkpoint: state,
        persist: save,
        subscribeBeforeStart: async (runId, afterSequence) => {
          stream = await openStage8RunEventStream(client, runId, afterSequence);
        },
      });
      state = started.state;
      observedRun = started.run;
    } else if (state.executionStartStatus === "COMMITTED") {
      stream = await openStage8RunEventStream(client, run.id, state.lastDurableEventSequence);
      observedRun = typeof client.getRun === "function" ? await client.getRun(run.id) : observedRun;
      if (observedRun.id !== run.id) {
        throw new Error("The checkpointed Stage 8 Run identity changed.");
      }
      if (observedRun.status === "PENDING") {
        const started = await client.startRun(run.id);
        if (
          started?.run?.id !== run.id ||
          !["SCHEDULED", "ALREADY_ACTIVE"].includes(started.disposition)
        ) {
          throw new Error("The pending Stage 8 Run could not be resumed safely.");
        }
        observedRun = started.run;
      } else if (!isStage8TerminalRunStatus(observedRun.status)) {
        const recovered = await client.recoverRun(run.id);
        if (
          recovered?.run?.id !== run.id ||
          !["SCHEDULED", "ALREADY_ACTIVE"].includes(recovered.disposition)
        ) {
          throw new Error("The Stage 8 Run could not be recovered safely.");
        }
        observedRun = recovered.run;
      }
    } else {
      throw new Error("The Stage 8 Run start outcome is unresolved and will not be retried.");
    }

    if (stream === undefined) {
      throw new Error("The Stage 8 Run event stream was not established.");
    }
    state = await consumeStage8RunEvents({
      client,
      events: stream.events,
      runId: run.id,
      checkpoint: state,
      initialPromptCache,
      persist: save,
    });
    if (state.terminalState === "UNKNOWN" && state.abortReason === null) {
      state.abortReason = "EVENT_STREAM_ENDED_BEFORE_TERMINAL";
      state.costStatus = "UNREPORTED";
      try {
        state = await save(state);
      } finally {
        await client.cancelRun(run.id).catch(() => undefined);
      }
    }
  } catch {
    state.abortReason ??=
      state.executionStartStatus === "IN_FLIGHT"
        ? "RUN_START_OUTCOME_UNRESOLVED"
        : "EVENT_OBSERVATION_FAILED";
    state.costStatus = "UNREPORTED";
    try {
      state = await save(state);
    } finally {
      await client.cancelRun(run.id).catch(() => undefined);
    }
  } finally {
    if (stream !== undefined) await stream.close();
  }
  if (typeof client.getRun === "function") {
    const finalRun = await client.getRun(run.id).catch(() => undefined);
    if (finalRun?.id === run.id) observedRun = finalRun;
  }
  if (state.terminalState === "UNKNOWN" && isStage8TerminalRunStatus(observedRun.status)) {
    state.terminalState = normalizeStage8TerminalRunStatus(observedRun.status);
    state = await save(state);
  }
  return { run: observedRun, state };
}

export async function appendStage8LivenessSample({
  path,
  baseUrl,
  runId,
  checkpoint,
  client,
  fetcher = globalThis.fetch,
  now = Date.now,
}) {
  if (
    typeof path !== "string" ||
    typeof runId !== "string" ||
    typeof fetcher !== "function" ||
    typeof now !== "function"
  ) {
    throw new TypeError("Stage 8 liveness sample inputs are invalid.");
  }
  const parsedUrl = new globalThis.URL(baseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error("Stage 8 liveness checks only permit the local daemon endpoint.");
  }
  const getStatus = async (url) => {
    try {
      const response = await fetcher(url, {
        method: "GET",
        signal: globalThis.AbortSignal.timeout(5_000),
      });
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      return status;
    } catch {
      return null;
    }
  };
  const [daemonHttpStatus, webHttpStatus, run] = await Promise.all([
    getStatus(new globalThis.URL("/api/v1/health", baseUrl)),
    getStatus(new globalThis.URL("/", baseUrl)),
    typeof client?.getRun === "function"
      ? client.getRun(runId).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const sample = {
    timestamp: safeCount(now()),
    daemonHttpStatus,
    webHttpStatus,
    runStatus: typeof run?.status === "string" ? run.status : "UNAVAILABLE",
    providerCallCount: safeCount(checkpoint?.providerCallCount ?? 0),
    mainCallCount: safeCount(checkpoint?.mainCallCount ?? 0),
    toolInvocationCount: safeCount(checkpoint?.toolInvocationCount ?? 0),
    compactionCount: safeCount(checkpoint?.compactionCount ?? 0),
    durableEventSequence: safeCount(checkpoint?.lastDurableEventSequence ?? 0),
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(sample)}\n`, "utf8");
  return sample;
}

function isStage8TerminalRunStatus(status) {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}

function normalizeStage8TerminalRunStatus(status) {
  return isStage8TerminalRunStatus(status) ? status : "UNKNOWN";
}

function normalizePromptCacheSegments(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fingerprintFields = [
    "prefixFingerprint",
    "modelFingerprint",
    "stableHeadFingerprint",
    "toolCatalogFingerprint",
    "cacheSettingsFingerprint",
    "checkpointFingerprint",
    "recentTailFingerprint",
    "roleSizeVectorFingerprint",
  ];
  const countFields = [
    "stableHeadTokens",
    "snapshotTokens",
    "recentTailTokens",
    "checkpointBytes",
    "recentTailBytes",
    "recentTailMessageCount",
  ];
  const allowed = new Set([...fingerprintFields, ...countFields]);
  if (Object.keys(value).some((field) => !allowed.has(field))) return null;
  const segments = {};
  for (const field of fingerprintFields) {
    const fingerprint = stripFingerprintPrefix(value[field]);
    if (fingerprint === null) return null;
    segments[field] = fingerprint;
  }
  for (const field of countFields) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null;
    segments[field] = value[field];
  }
  return segments;
}

function stripFingerprintPrefix(value) {
  if (typeof value !== "string") return null;
  const normalized = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return FINGERPRINT.test(normalized) ? normalized : null;
}

export function recordStage8ProviderSample(previous, input) {
  const state = cloneState(previous);
  if (state.abortReason !== null) return state;
  if (!PURPOSES.has(input.purpose) || !["SUCCESS", "FAILED", "UNKNOWN"].includes(input.outcome)) {
    throw new TypeError("Stage 8 provider sample classification is invalid.");
  }
  if (state.inFlight !== null) {
    if (
      !Number.isSafeInteger(input.startEventSequence) ||
      input.startEventSequence < 1 ||
      (state.inFlight.eventSequence !== undefined &&
        state.inFlight.eventSequence !== input.startEventSequence)
    ) {
      state.abortReason = "IN_FLIGHT_OUTCOME_MISMATCH";
      return finalizeState(state);
    }
    state.inFlight = null;
  }
  if (state.providerCallCount >= STAGE8_LIMITS.maxProviderCalls) {
    state.abortReason = "TOTAL_CALL_LIMIT";
    return finalizeState(state);
  }
  const isMain = input.purpose === "MAIN_AGENT";
  if (isMain && state.mainCallCount >= STAGE8_LIMITS.maxMainCalls) {
    state.abortReason = "MAIN_CALL_LIMIT";
    return finalizeState(state);
  }
  state.providerCallCount += 1;
  if (isMain) state.mainCallCount += 1;
  else state.auxiliaryCallCount += 1;

  const usage = normalizeStage8Usage(input.usage);
  const sampleIndex = state.samples.length + 1;
  const sample = {
    callRef: `call-${String(sampleIndex).padStart(4, "0")}`,
    requestIndex: sampleIndex,
    purpose: input.purpose,
    outcome: input.outcome,
    scoring: "AUXILIARY",
    segment: state.compactionCount === 0 ? "PRE_COMPACTION" : "POST_COMPACTION",
    usage,
    resetReason: normalizeResetReason(input.usage?.resetReason),
    epochFingerprint: safeFingerprint(input.usage?.epochFingerprint),
    prefixFingerprint: safeFingerprint(input.usage?.prefixFingerprint),
    prefixEfficiency: null,
    eventSequence: input.eventSequence === undefined ? null : safeCount(input.eventSequence),
    surfaceSegments:
      input.surfaceSegments === undefined
        ? null
        : normalizePromptCacheSegments(input.surfaceSegments),
    snapshotFingerprint: safeFingerprint(input.snapshotFingerprint),
    costNanoUsd: null,
    costStatus: "UNREPORTED",
    observedAt: Date.now(),
  };
  if (input.surfaceSegments !== undefined && sample.surfaceSegments === null) {
    throw new TypeError("Stage 8 Prompt Cache surface segments are invalid.");
  }
  const resetReason = sample.resetReason;
  if (
    sample.epochFingerprint !== null &&
    state.lastEpochFingerprint !== null &&
    state.lastEpochFingerprint !== sample.epochFingerprint &&
    !RESET_REASONS.has(resetReason)
  ) {
    state.unexplainedResetCount += 1;
    state.abortReason ??= "UNEXPLAINED_RESET";
  }
  if (sample.epochFingerprint !== null) state.lastEpochFingerprint = sample.epochFingerprint;

  if (input.hiddenProviderCalls !== undefined && input.hiddenProviderCalls > 0) {
    state.hiddenCallCount += input.hiddenProviderCalls;
    state.abortReason = "HIDDEN_PROVIDER_CALL";
  }
  if (input.snapshotFingerprint !== undefined) {
    if (!FINGERPRINT.test(input.snapshotFingerprint)) {
      throw new TypeError("Stage 8 snapshot fingerprint is invalid.");
    }
    if (state.seenSnapshotFingerprints.includes(input.snapshotFingerprint)) {
      state.duplicateSnapshotCount += 1;
      state.abortReason ??= "DUPLICATE_SNAPSHOT";
    } else {
      state.seenSnapshotFingerprints.push(input.snapshotFingerprint);
    }
  }

  if (usage === null) {
    state.unknownUsageCount += 1;
    state.costStatus = "UNREPORTED";
    state.abortReason ??= "UNKNOWN_USAGE";
  } else {
    state.totalInputTokens = addCount(state.totalInputTokens, usage.inputTokens);
    state.totalOutputTokens = addCount(state.totalOutputTokens, usage.outputTokens);
    state.totalHitTokens = addCount(state.totalHitTokens, usage.hitTokens);
    state.totalMissTokens = addCount(state.totalMissTokens, usage.missTokens);
    state.totalWriteTokens = addCount(state.totalWriteTokens, usage.writeTokens);
    const pricingPeriod = input.pricingPeriod ?? getDeepSeekPricingPeriod(new Date());
    try {
      const cost = computeDeepSeekCostNanoDollars(
        {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.hitTokens,
          cacheMissInputTokens: usage.missTokens,
          cacheWriteInputTokens: usage.writeTokens,
          outputTokens: usage.outputTokens,
        },
        pricingPeriod,
      );
      sample.costNanoUsd = cost.toString();
      sample.costStatus = "RECONCILED";
      state.totalCostNanoUsd = (BigInt(state.totalCostNanoUsd) + cost).toString();
    } catch {
      state.costStatus = "UNREPORTED";
      state.abortReason ??= "COST_UNREPORTED";
    }
    if (usage.expectedReusablePrefixTokens > 0) {
      sample.prefixEfficiency =
        Math.min(usage.hitTokens, usage.expectedReusablePrefixTokens) /
        usage.expectedReusablePrefixTokens;
      if (sample.prefixEfficiency < STAGE8_LIMITS.reusablePrefixAnomalyFloor) {
        state.abortReason ??= "REUSABLE_PREFIX_ANOMALY";
      }
    }
    if (sample.resetReason === "UNEXPLAINED") {
      state.unexplainedResetCount += 1;
      state.abortReason ??= "UNEXPLAINED_RESET";
    }
  }

  if (isMain) {
    if (input.outcome === "SUCCESS" && !state.coldWarmupConsumed) {
      sample.scoring = "COLD_WARMUP";
      state.coldWarmupConsumed = true;
    } else if (input.outcome === "SUCCESS") {
      sample.scoring = "SCORED";
      state.scoredMainCallCount += 1;
      if (state.compactionCount === 0) state.preCompactionScoredMainCallCount += 1;
      else state.postCompactionScoredMainCallCount += 1;
      const rates = stage8HitRates([...state.samples, sample]);
      const activeCount =
        state.compactionCount === 0
          ? state.preCompactionScoredMainCallCount
          : state.postCompactionScoredMainCallCount;
      const activeRate = state.compactionCount === 0 ? rates.pre : rates.post;
      if (
        activeCount >= STAGE8_LIMITS.minimumSegmentSamples &&
        (rates.overall === null ||
          rates.overall <= STAGE8_LIMITS.minimumBillingHitRateExclusive ||
          activeRate === null ||
          activeRate <= STAGE8_LIMITS.minimumBillingHitRateExclusive)
      ) {
        state.abortReason ??= "HIT_RATE_FLOOR";
      }
    } else {
      sample.scoring = input.outcome === "FAILED" ? "UNSCORED_FAILED" : "UNSCORED_UNKNOWN";
    }
  }
  state.samples.push(sample);
  return finalizeState(state);
}

export function recordStage8Compaction(previous, input) {
  const state = cloneState(previous);
  if (state.abortReason !== null) return state;
  if (state.compactionCount > 0 || !Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    state.abortReason = "INVALID_COMPACTION_BOUNDARY";
    return finalizeState(state);
  }
  for (const field of ["epochBeforeFingerprint", "epochAfterFingerprint"]) {
    if (!FINGERPRINT.test(input[field] ?? "")) {
      state.abortReason = "COMPACTION_EVIDENCE_INCOMPLETE";
      return finalizeState(state);
    }
  }
  state.compactionCount = 1;
  state.compaction = {
    sequence: input.sequence,
    reason: boundedEnum(input.reason, [
      "PROACTIVE_PRESSURE",
      "SELECTION_PRESSURE",
      "FORCED_PROVIDER_OVERFLOW",
    ]),
    tokensBefore: safeCount(input.tokensBefore),
    tokensAfter: safeCount(input.tokensAfter),
    epochBeforeFingerprint: input.epochBeforeFingerprint,
    epochAfterFingerprint: input.epochAfterFingerprint,
  };
  return finalizeState(state);
}

export function recordStage8ToolInvocation(previous) {
  const state = cloneState(previous);
  if (state.abortReason !== null) return state;
  if (state.toolInvocationCount >= STAGE8_LIMITS.maxToolInvocations) {
    state.abortReason = "TOOL_LIMIT";
    return finalizeState(state);
  }
  state.toolInvocationCount += 1;
  return finalizeState(state);
}

export async function writeStage8CheckpointAtomic(path, previous, options = {}) {
  const state = cloneState(previous);
  if (options.resume === true && state.inFlight !== null) {
    const inFlight = state.inFlight;
    state.providerCallCount = addCount(state.providerCallCount, 1);
    if (inFlight.purpose === "MAIN_AGENT") state.mainCallCount = addCount(state.mainCallCount, 1);
    else state.auxiliaryCallCount = addCount(state.auxiliaryCallCount, 1);
    state.unknownUsageCount = addCount(state.unknownUsageCount, 1);
    state.costStatus = "UNREPORTED";
    state.abortReason = "IN_FLIGHT_REQUEST_NOT_RESENT";
    state.inFlight = null;
  } else if (options.dispatch !== undefined) {
    if (state.abortReason !== null) throw new Error("Stage 8 checkpoint is fused.");
    if (!PURPOSES.has(options.dispatch.purpose))
      throw new TypeError("Dispatch purpose is invalid.");
    state.inFlight = {
      callRef: `call-${String(state.providerCallCount + 1).padStart(4, "0")}`,
      purpose: options.dispatch.purpose,
      intentAt: Date.now(),
      ...(options.dispatch.eventSequence === undefined
        ? {}
        : { eventSequence: safeCount(options.dispatch.eventSequence) }),
    };
  }
  state.updatedAt = Date.now();
  validateSafeCheckpoint(state);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("Stage 8 checkpoint could not be committed atomically.");
  }
  return state;
}

export function summarizeStage8Attempt(state) {
  const rates = stage8HitRates(state.samples);
  const prefixValues = state.samples
    .filter((sample) => sample.scoring === "SCORED" && sample.prefixEfficiency !== null)
    .map((sample) => sample.prefixEfficiency);
  return {
    schemaVersion: 1,
    attemptId: state.attemptId,
    terminalState: state.terminalState,
    providerCallCount: state.providerCallCount,
    mainCallCount: state.mainCallCount,
    auxiliaryCallCount: state.auxiliaryCallCount,
    scoredMainCallCount: state.scoredMainCallCount,
    preCompactionScoredMainCallCount: state.preCompactionScoredMainCallCount,
    postCompactionScoredMainCallCount: state.postCompactionScoredMainCallCount,
    toolInvocationCount: state.toolInvocationCount,
    compactionCount: state.compactionCount,
    overallBillingHitRate: rates.overall,
    preCompactionBillingHitRate: rates.pre,
    postCompactionBillingHitRate: rates.post,
    minimumReusablePrefixEfficiency: prefixValues.length === 0 ? null : Math.min(...prefixValues),
    unknownUsageCount: state.unknownUsageCount,
    unexplainedResetCount: state.unexplainedResetCount,
    duplicateSnapshotCount: state.duplicateSnapshotCount,
    hiddenCallCount: state.hiddenCallCount,
    totalInputTokens: state.totalInputTokens,
    totalOutputTokens: state.totalOutputTokens,
    totalHitTokens: state.totalHitTokens,
    totalMissTokens: state.totalMissTokens,
    totalWriteTokens: state.totalWriteTokens,
    totalCostNanoUsd: state.totalCostNanoUsd,
    costStatus: state.costStatus,
    abortReason: state.abortReason,
    exitGatePassed: evaluateStage8ExitGate(state),
  };
}

export function evaluateStage8ExitGate(state) {
  const rates = stage8HitRates(state.samples);
  const efficiencies = state.samples
    .filter((sample) => sample.scoring === "SCORED")
    .map((sample) => sample.prefixEfficiency);
  return (
    state.abortReason === null &&
    state.terminalState === "COMPLETED" &&
    state.compactionCount >= 1 &&
    state.preCompactionScoredMainCallCount >= STAGE8_LIMITS.minimumSegmentSamples &&
    state.postCompactionScoredMainCallCount >= STAGE8_LIMITS.minimumSegmentSamples &&
    rates.overall !== null &&
    rates.overall > STAGE8_LIMITS.minimumBillingHitRateExclusive &&
    rates.pre !== null &&
    rates.pre > STAGE8_LIMITS.minimumBillingHitRateExclusive &&
    rates.post !== null &&
    rates.post > STAGE8_LIMITS.minimumBillingHitRateExclusive &&
    efficiencies.length > 0 &&
    efficiencies.every(
      (value) => value !== null && value >= STAGE8_LIMITS.minimumReusablePrefixEfficiency,
    ) &&
    state.costStatus === "RECONCILED" &&
    state.unknownUsageCount === 0 &&
    state.unexplainedResetCount === 0 &&
    state.duplicateSnapshotCount === 0 &&
    state.hiddenCallCount === 0
  );
}

export async function runLocalFixtureMode() {
  const result = spawnSync(
    process.execPath,
    [VITEST_ENTRY, "run", "apps/daemon/test/stage8-long-run-audit.test.ts"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, CAELUSH_STAGE8_AUDIT_MODE: "local-fixture" },
      stdio: "pipe",
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status === 0 ? 0 : 1;
}

function stage8HitRates(samples) {
  const scored = samples.filter((sample) => sample.scoring === "SCORED");
  const rate = (items) => {
    let hit = 0n;
    let miss = 0n;
    for (const sample of items) {
      if (sample.usage === null) continue;
      hit += BigInt(sample.usage.hitTokens);
      miss += BigInt(sample.usage.missTokens);
    }
    return hit + miss === 0n ? null : Number(hit) / Number(hit + miss);
  };
  return {
    overall: rate(scored),
    pre: rate(scored.filter((sample) => sample.segment === "PRE_COMPACTION")),
    post: rate(scored.filter((sample) => sample.segment === "POST_COMPACTION")),
  };
}

function normalizeStage8Usage(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const names = [
    "inputTokens",
    "outputTokens",
    "hitTokens",
    "missTokens",
    "writeTokens",
    "expectedReusablePrefixTokens",
  ];
  if (!names.every((name) => Number.isSafeInteger(value[name]) && value[name] >= 0)) return null;
  for (const name of ["epochFingerprint", "prefixFingerprint"]) {
    if (value[name] !== undefined && !FINGERPRINT.test(value[name])) return null;
  }
  return Object.fromEntries(names.map((name) => [name, value[name]]));
}

function normalizeResetReason(value) {
  if (value === undefined || value === null) return null;
  return RESET_REASONS.has(value) ? value : "UNEXPLAINED";
}

function safeFingerprint(value) {
  return typeof value === "string" && FINGERPRINT.test(value) ? value : null;
}

function cloneState(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Stage 8 checkpoint state is invalid.");
  }
  return JSON.parse(JSON.stringify(value));
}

function finalizeState(state) {
  const rates = stage8HitRates(state.samples);
  state.overallBillingHitRate = rates.overall;
  state.preCompactionBillingHitRate = rates.pre;
  state.postCompactionBillingHitRate = rates.post;
  state.nextProviderCallAllowed =
    state.abortReason === null &&
    state.providerCallCount < STAGE8_LIMITS.maxProviderCalls &&
    state.mainCallCount < STAGE8_LIMITS.maxMainCalls;
  state.nextToolInvocationAllowed =
    state.abortReason === null && state.toolInvocationCount < STAGE8_LIMITS.maxToolInvocations;
  return state;
}

function validateSafeCheckpoint(value) {
  const forbidden =
    /(?:api.?key|secret|credential|prompt|tool.?argument|response.?body|hidden.?reasoning|endpoint|raw.?cache.?key)/i;
  const visit = (member) => {
    if (Array.isArray(member)) return member.forEach(visit);
    if (member === null || typeof member !== "object") return;
    for (const [key, child] of Object.entries(member)) {
      if (forbidden.test(key)) throw new TypeError("Unsafe Stage 8 checkpoint field.");
      visit(child);
    }
  };
  visit(value);
}

function assertClosedRecord(value, allowedKeys, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new TypeError(`${label} contains an unsupported field.`);
  }
}

function assertAttemptId(value) {
  if (typeof value !== "string" || !ATTEMPT_ID.test(value)) {
    throw new TypeError("Stage 8 attempt identifier is invalid.");
  }
}

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Token count is invalid.");
  return value;
}

function addCount(left, right) {
  return safeCount(left + right);
}

function boundedEnum(value, allowed) {
  if (!allowed.includes(value)) throw new TypeError("Stage 8 enum value is invalid.");
  return value;
}

async function main() {
  const [mode, attemptId] = process.argv.slice(2);
  if (mode === "--local-fixture") return runLocalFixtureMode();
  if (mode === "--preflight") return runPreflight();
  if (mode === "--run" || mode === "--resume" || mode === "--summarize") {
    assertAttemptId(attemptId);
    if (mode === "--summarize") return runSummarize(attemptId);
    if (mode === "--run") return runAttempt(attemptId, false);
    return runAttempt(attemptId, true);
  }
  process.stderr.write(
    "Expected --local-fixture, --preflight, --run <attempt-id>, --resume <attempt-id>, or --summarize <attempt-id>.\n",
  );
  process.exitCode = 2;
}

async function runPreflight({ writeOutput = true } = {}) {
  const baseUrl = process.env.CAELUSH_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL;
  const parsedUrl = new globalThis.URL(baseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error("Stage 8 only permits the local daemon endpoint.");
  }
  const [health, info, providerResponse, defaultSelection, securityCapabilities] =
    await Promise.all([
      getPublicJson(baseUrl, "/api/v1/health"),
      getPublicJson(baseUrl, "/api/v1/info"),
      getPublicJson(baseUrl, "/api/v1/ai/providers"),
      getPublicJson(baseUrl, "/api/v1/ai/default-selection"),
      getPublicJson(baseUrl, "/api/v1/security/capabilities"),
    ]);
  if (
    health.apiVersion !== "v1" ||
    health.protocolVersion !== 1 ||
    info.apiVersion !== "v1" ||
    info.protocolVersion !== 1
  ) {
    throw new Error("Stage 8 daemon protocol is incompatible.");
  }
  const provider = providerResponse.providers.find((item) => item.id === "deepseek");
  if (provider === undefined)
    throw new Error("DeepSeek provider is unavailable in the active daemon.");
  const safeProvider = projectSafeProviderStatus(provider);
  const selection = defaultSelection.selection;
  const selectedModel = selection?.provider === "deepseek" ? selection.model : "deepseek-flash";
  const directory = await getPublicJson(
    baseUrl,
    `/api/v1/ai/models?provider=${encodeURIComponent("deepseek")}`,
  );
  const model = directory.models.find((item) => item.id === selectedModel);
  const productHome = process.env.CAELUSH_HOME ?? join(homedir(), ".caelush");
  const productHomeFingerprint = createIrreversibleFingerprint(productHome);
  const daemonIdentityFingerprint = createIrreversibleFingerprint({
    productHomeFingerprint,
    daemonVersion: info.daemonVersion,
    daemonUrlHash: createIrreversibleFingerprint(baseUrl),
  });
  const capabilities = {
    toolCalling: "SUPPORTED",
    promptCaching: "SUPPORTED",
    usageReporting: "SUPPORTED",
    contextWindowTokens: 1_048_576,
  };
  const fullAccessPreset = securityCapabilities.presets.find((item) => item.id === "FULL_ACCESS");
  const artifact = Stage8PreflightSchema.parse({
    schemaVersion: 1,
    daemonIdentityFingerprint,
    productHomeFingerprint,
    ...safeProvider,
    ...(selection?.provider === undefined ? {} : { selectedProvider: selection.provider }),
    ...(selectedModel === undefined ? {} : { selectedModel }),
    ...(selection?.reasoningLevel === undefined
      ? {}
      : { reasoningLevel: selection.reasoningLevel }),
    modelCapabilities: capabilities,
    fullAccessPolicy: {
      filesystemBoundary: fullAccessPreset?.filesystemBoundary ?? "UNKNOWN",
      processBoundary: fullAccessPreset?.processBoundary ?? "UNKNOWN",
      requiredEnforcement: fullAccessPreset?.requiredEnforcement ?? "UNKNOWN",
      requiresConfirmation: fullAccessPreset?.requiresConfirmation === true,
    },
    processSandbox: {
      status: securityCapabilities.processSandbox.status,
      enforcement: securityCapabilities.processSandbox.enforcement,
    },
    status:
      safeProvider.configured &&
      safeProvider.discoveryState === "READY" &&
      model?.availability === "AVAILABLE"
        ? "READY"
        : "INCOMPLETE",
  });
  await mkdir(SCENARIO_ROOT, { recursive: true });
  await writeFile(
    resolve(SCENARIO_ROOT, "stage8-preflight.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  if (writeOutput) process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

async function getPublicJson(baseUrl, route) {
  const response = await globalThis.fetch(new globalThis.URL(route, baseUrl), {
    method: "GET",
    headers: { accept: "application/json" },
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("The local daemon public API returned an error.");
  const value = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The local daemon public API returned an invalid response.");
  }
  return value;
}

async function runSummarize(attemptId) {
  const artifactPaths = getArtifactPaths(attemptId);
  const checkpoint = JSON.parse(await readFile(artifactPaths.checkpoint, "utf8"));
  const report = summarizeStage8Attempt(checkpoint);
  await writeFile(artifactPaths.reportJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(artifactPaths.reportMarkdown, renderMarkdownSummary(report), "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function getStage8AttemptWorkspaceRoot(attemptId) {
  assertAttemptId(attemptId);
  const ordinal = String(Number(attemptId.slice("attempt-".length))).padStart(2, "0");
  return resolve("D:\\Develop\\Caelush-Test", `${ordinal}-incident-automation-studio-${attemptId}`);
}

async function validateStage8AttemptWorkspace(attemptId, resume) {
  const workspaceRoot = getStage8AttemptWorkspaceRoot(attemptId);
  const metadata = await lstat(workspaceRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The Stage 8 attempt workspace is not a plain directory.");
  }
  const canonicalPath = await realpath(workspaceRoot);
  if (!sameLocalPath(canonicalPath, workspaceRoot)) {
    throw new Error("The Stage 8 attempt workspace resolves outside its registered path.");
  }
  if (!resume && (await readdir(canonicalPath)).length !== 0) {
    throw new Error("A new Stage 8 attempt requires an empty workspace.");
  }
  return canonicalPath;
}

function parseStage8AttemptCheckpoint(value, attemptId) {
  const template = createStage8AttemptCheckpoint({ attemptId });
  assertClosedRecord(value, new Set(Object.keys(template)), "Stage 8 checkpoint");
  validateSafeCheckpoint(value);
  if (
    value.schemaVersion !== 1 ||
    value.attemptId !== attemptId ||
    !Number.isSafeInteger(value.lastDurableEventSequence) ||
    value.lastDurableEventSequence < 0 ||
    !Array.isArray(value.samples) ||
    value.samples.length > STAGE8_LIMITS.maxProviderCalls ||
    !["NOT_STARTED", "IN_FLIGHT", "COMMITTED"].includes(value.sessionCreationStatus) ||
    !["NOT_STARTED", "IN_FLIGHT", "COMMITTED"].includes(value.runCreationStatus) ||
    !["NOT_STARTED", "IN_FLIGHT", "COMMITTED"].includes(value.executionStartStatus) ||
    ![
      "UNKNOWN",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "MAX_STEPS_REACHED",
      "BUDGET_EXCEEDED",
    ].includes(value.terminalState) ||
    (value.abortReason !== null && typeof value.abortReason !== "string")
  ) {
    throw new TypeError("Stage 8 checkpoint fields are invalid.");
  }
  for (const field of [
    "providerCallCount",
    "mainCallCount",
    "auxiliaryCallCount",
    "toolInvocationCount",
    "unknownUsageCount",
    "unexplainedResetCount",
    "duplicateSnapshotCount",
    "hiddenCallCount",
    "compactionCount",
    "totalInputTokens",
    "totalOutputTokens",
    "totalHitTokens",
    "totalMissTokens",
    "totalWriteTokens",
  ]) {
    safeCount(value[field]);
  }
  return cloneState(value);
}

async function writeStage8AttemptReports(checkpoint, artifactPaths) {
  const report = summarizeStage8Attempt(checkpoint);
  const artifact = {
    ...report,
    sessionId: checkpoint.sessionId,
    runId: checkpoint.runId,
    workspaceId: checkpoint.workspaceId,
    workspacePathFingerprint: checkpoint.workspacePathFingerprint,
    lastDurableEventSequence: checkpoint.lastDurableEventSequence,
    updatedAt: checkpoint.updatedAt,
    livenessFile: artifactPaths.livenessJsonl,
  };
  await Promise.all([
    writeFile(artifactPaths.json, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(artifactPaths.reportJson, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(artifactPaths.reportMarkdown, renderMarkdownSummary(report), {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
  return report;
}

function startStage8LivenessMonitor(sample, onFailure) {
  let stopped = false;
  let active = false;
  let failed = false;
  let pending = Promise.resolve();
  const timer = globalThis.setInterval(() => {
    if (stopped || active) return;
    active = true;
    pending = Promise.resolve()
      .then(sample)
      .catch(async () => {
        failed = true;
        await onFailure().catch(() => undefined);
      })
      .finally(() => {
        active = false;
      });
  }, 30_000);
  timer.unref?.();
  return {
    get failed() {
      return failed;
    },
    async stop() {
      stopped = true;
      globalThis.clearInterval(timer);
      await pending;
    },
  };
}

async function runAttempt(attemptId, resume) {
  const baseUrl = process.env.CAELUSH_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL;
  const preflight = await runPreflight({ writeOutput: false });
  if (preflight.status !== "READY") {
    process.stdout.write(
      `${JSON.stringify({ status: "BLOCKED_PREFLIGHT", attemptId, providerCallCount: 0 }, null, 2)}\n`,
    );
    process.exitCode = 3;
    return;
  }
  if (
    preflight.fullAccessPolicy.filesystemBoundary !== "WORKSPACE_READ_WRITE" ||
    preflight.fullAccessPolicy.processBoundary !== "WORKSPACE_WRITE" ||
    preflight.fullAccessPolicy.requiredEnforcement !== "OS_RESTRICTED"
  ) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "BLOCKED_WORKSPACE_CONTAINMENT",
          attemptId,
          action: resume ? "RESUME" : "RUN",
          providerCallCount: 0,
          reasonCode: "FULL_ACCESS_HOST_SCOPE_UNRESTRICTED",
          configuredFilesystemBoundary: preflight.fullAccessPolicy.filesystemBoundary,
          configuredProcessBoundary: preflight.fullAccessPolicy.processBoundary,
          requiredPreset: "FULL_ACCESS",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 3;
    return;
  }
  if (
    preflight.providerId !== "deepseek" ||
    preflight.selectedProvider !== "deepseek" ||
    preflight.configured !== true ||
    preflight.source !== "LOCAL" ||
    typeof preflight.selectedModel !== "string" ||
    preflight.modelCapabilities.toolCalling !== "SUPPORTED" ||
    preflight.modelCapabilities.promptCaching !== "SUPPORTED" ||
    preflight.modelCapabilities.usageReporting !== "SUPPORTED"
  ) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "BLOCKED_MODEL_CAPABILITIES",
          attemptId,
          providerCallCount: 0,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 3;
    return;
  }
  const prompt = await readFile(FROZEN_PROMPT_PATH);
  if (createIrreversibleFingerprint(prompt.toString("utf8")) !== FROZEN_PROMPT_SHA256) {
    throw new Error("The frozen Stage 8 task input changed.");
  }
  const workspaceRoot = await validateStage8AttemptWorkspace(attemptId, resume);
  const artifactPaths = getArtifactPaths(attemptId);
  let checkpointContents;
  try {
    checkpointContents = await readFile(artifactPaths.checkpoint, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let checkpoint;
  if (resume) {
    if (checkpointContents === undefined) {
      throw new Error("The Stage 8 attempt has no checkpoint to resume.");
    }
    checkpoint = parseStage8AttemptCheckpoint(JSON.parse(checkpointContents), attemptId);
  } else {
    if (checkpointContents !== undefined) {
      throw new Error("The Stage 8 attempt already has a checkpoint; use --resume.");
    }
    checkpoint = createStage8AttemptCheckpoint({ attemptId });
    checkpoint = await writeStage8CheckpointAtomic(artifactPaths.checkpoint, checkpoint);
  }

  const { CaelushClient } = await import("@caelush/client");
  const client = new CaelushClient({ baseUrl });
  const persist = async (nextState) => {
    checkpoint = await writeStage8CheckpointAtomic(artifactPaths.checkpoint, nextState);
    return checkpoint;
  };
  const finishWithoutExecution = async (status) => {
    if (checkpoint.runId !== null) await client.cancelRun(checkpoint.runId).catch(() => undefined);
    await writeStage8AttemptReports(checkpoint, artifactPaths);
    process.stdout.write(
      `${JSON.stringify(
        {
          status,
          attemptId,
          providerCallCount: checkpoint.providerCallCount,
          abortReason: checkpoint.abortReason,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 3;
  };
  if (checkpoint.inFlight !== null) {
    checkpoint = await writeStage8CheckpointAtomic(artifactPaths.checkpoint, checkpoint, {
      resume: true,
    });
    await finishWithoutExecution("ABORTED_IN_FLIGHT_REQUEST_NOT_RESENT");
    return;
  }
  if (checkpoint.executionStartStatus === "IN_FLIGHT") {
    checkpoint.abortReason ??= "RUN_START_OUTCOME_UNRESOLVED";
    checkpoint.costStatus = "UNREPORTED";
    checkpoint = await persist(checkpoint);
    await finishWithoutExecution("ABORTED_RUN_START_OUTCOME_UNRESOLVED");
    return;
  }
  if (checkpoint.abortReason !== null) {
    await finishWithoutExecution("ABORTED_CHECKPOINT_FUSED");
    return;
  }

  let lifecycle;
  try {
    const created = await createOrResolveStage8Run({
      client,
      attemptId,
      workspaceRoot,
      prompt: prompt.toString("utf8"),
      preflight,
      checkpoint,
      persist,
    });
    checkpoint = created.state;
    const usage = await client.getRunContextUsage(created.run.id);
    const initialPromptCache = usage?.promptCache ?? null;
    if (
      resume &&
      checkpoint.executionStartStatus === "COMMITTED" &&
      !stage8UsageMatchesCheckpoint(initialPromptCache, checkpoint)
    ) {
      checkpoint.abortReason = "RESUME_USAGE_DIVERGENCE";
      checkpoint.costStatus = "UNREPORTED";
      checkpoint = await persist(checkpoint);
      await finishWithoutExecution("ABORTED_RESUME_USAGE_DIVERGENCE");
      return;
    }
    await appendStage8LivenessSample({
      path: artifactPaths.livenessJsonl,
      baseUrl,
      runId: created.run.id,
      checkpoint,
      client,
    });
    const livenessMonitor = startStage8LivenessMonitor(
      () =>
        appendStage8LivenessSample({
          path: artifactPaths.livenessJsonl,
          baseUrl,
          runId: created.run.id,
          checkpoint,
          client,
        }),
      async () => {
        try {
          if (checkpoint.abortReason === null) {
            checkpoint.abortReason = "LIVENESS_CAPTURE_FAILED";
            checkpoint.costStatus = "UNREPORTED";
            checkpoint = await persist(checkpoint);
          }
        } finally {
          await client.cancelRun(created.run.id).catch(() => undefined);
        }
      },
    );
    try {
      lifecycle = await startAndObserveStage8Run({
        client,
        run: created.run,
        checkpoint,
        initialPromptCache,
        persist,
      });
      checkpoint = lifecycle.state;
      try {
        await appendStage8LivenessSample({
          path: artifactPaths.livenessJsonl,
          baseUrl,
          runId: created.run.id,
          checkpoint,
          client,
        });
      } catch {
        try {
          if (checkpoint.abortReason === null) {
            checkpoint.abortReason = "LIVENESS_CAPTURE_FAILED";
            checkpoint.costStatus = "UNREPORTED";
            checkpoint = await persist(checkpoint);
          }
        } finally {
          await client.cancelRun(created.run.id).catch(() => undefined);
        }
      }
    } finally {
      await livenessMonitor.stop();
      if (livenessMonitor.failed && checkpoint.abortReason === null) {
        checkpoint.abortReason = "LIVENESS_CAPTURE_FAILED";
        checkpoint.costStatus = "UNREPORTED";
        checkpoint = await persist(checkpoint);
        await client.cancelRun(created.run.id).catch(() => undefined);
      }
    }
  } catch {
    checkpoint.abortReason ??= "RUN_SETUP_FAILED";
    if (checkpoint.executionStartStatus === "IN_FLIGHT") {
      checkpoint.costStatus = "UNREPORTED";
    }
    checkpoint = await persist(checkpoint);
    await finishWithoutExecution("ABORTED_RUN_SETUP_FAILED");
    return;
  }
  const report = await writeStage8AttemptReports(checkpoint, artifactPaths);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: report.exitGatePassed ? "COMPLETED" : "INCOMPLETE",
        attemptId,
        runStatus: lifecycle?.run.status ?? "UNKNOWN",
        providerCallCount: report.providerCallCount,
        mainCallCount: report.mainCallCount,
        toolInvocationCount: report.toolInvocationCount,
        compactionCount: report.compactionCount,
        exitGatePassed: report.exitGatePassed,
        abortReason: report.abortReason,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = report.exitGatePassed ? 0 : 3;
}

function stage8UsageMatchesCheckpoint(promptCache, checkpoint) {
  if (typeof promptCache !== "object" || promptCache === null) return false;
  return (
    promptCache.totalRequestCount === checkpoint.providerCallCount &&
    promptCache.totalInputTokens === checkpoint.totalInputTokens &&
    promptCache.totalOutputTokens === checkpoint.totalOutputTokens &&
    promptCache.hitTokens === checkpoint.totalHitTokens &&
    promptCache.missTokens === checkpoint.totalMissTokens &&
    promptCache.writeTokens === checkpoint.totalWriteTokens &&
    promptCache.unknownUsageCount === checkpoint.unknownUsageCount
  );
}

function getArtifactPaths(attemptId) {
  assertAttemptId(attemptId);
  const base = resolve(SCENARIO_ROOT, `stage8-long-run-${attemptId}`);
  return {
    json: `${base}.json`,
    checkpoint: `${base}.checkpoint.json`,
    livenessJsonl: `${base}-liveness.jsonl`,
    reportJson: `${base}-summary.json`,
    reportMarkdown: `${base}.md`,
  };
}

function renderMarkdownSummary(report) {
  return [
    `# Stage 8 ${report.attemptId} summary`,
    "",
    `- Terminal state: ${report.terminalState}`,
    `- Provider calls: ${report.providerCallCount}`,
    `- MAIN_AGENT calls: ${report.mainCallCount}`,
    `- Tool invocations: ${report.toolInvocationCount}`,
    `- Compactions: ${report.compactionCount}`,
    `- Overall hit rate: ${report.overallBillingHitRate ?? "UNKNOWN"}`,
    `- Pre-compaction hit rate: ${report.preCompactionBillingHitRate ?? "UNKNOWN"}`,
    `- Post-compaction hit rate: ${report.postCompactionBillingHitRate ?? "UNKNOWN"}`,
    `- Cost (nano-USD): ${report.totalCostNanoUsd} (${report.costStatus})`,
    `- Exit gate: ${report.exitGatePassed ? "PASS" : "INCOMPLETE"}`,
    `- Abort reason: ${report.abortReason ?? "NONE"}`,
    "",
  ].join("\n");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    const kind = error instanceof Error ? error.name : "UnknownError";
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "UNCLASSIFIED";
    process.stderr.write(`Stage 8 audit could not complete safely (${kind}:${code}).\n`);
    process.exitCode = 2;
  }
}
