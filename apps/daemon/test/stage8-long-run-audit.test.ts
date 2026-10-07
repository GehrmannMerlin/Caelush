import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STAGE8_LIMITS,
  Stage8PreflightSchema,
  createStage8AttemptCheckpoint,
  appendStage8LivenessSample,
  projectSafeProviderStatus,
  recordStage8ProviderSample,
  recordStage8ToolInvocation,
  recordStage8Compaction,
  writeStage8CheckpointAtomic,
} from "../../../scripts/stage8-long-run-audit.mjs";
import { projectPromptCacheSegments } from "../src/daemon-composition.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const usage = (overrides: Record<string, unknown> = {}) => ({
  inputTokens: 1_000,
  outputTokens: 20,
  hitTokens: 950,
  missTokens: 50,
  writeTokens: 50,
  expectedReusablePrefixTokens: 950,
  epochFingerprint: "a".repeat(64),
  prefixFingerprint: "b".repeat(64),
  ...overrides,
});

describe("Stage 8 long-run audit local fixtures", () => {
  it("accepts daemon LOCAL credential status without accepting or serializing secrets", () => {
    expect(
      projectSafeProviderStatus({
        id: "deepseek",
        displayName: "DeepSeek",
        credentialConfigured: true,
        credentialSource: "LOCAL",
        credentialWritable: true,
        discoveryState: "READY",
      }),
    ).toEqual({
      providerId: "deepseek",
      configured: true,
      source: "LOCAL",
      writable: true,
      discoveryState: "READY",
    });
    expect(() =>
      projectSafeProviderStatus({
        id: "deepseek",
        displayName: "DeepSeek",
        credentialConfigured: true,
        credentialSource: "LOCAL",
        credentialWritable: true,
        discoveryState: "READY",
        apiKey: "must-not-be-accepted",
      }),
    ).toThrow();
    const safeArtifact = {
      schemaVersion: 1,
      daemonIdentityFingerprint: "a".repeat(64),
      productHomeFingerprint: "b".repeat(64),
      providerId: "deepseek",
      configured: true,
      source: "LOCAL",
      writable: true,
      discoveryState: "READY",
      modelCapabilities: {
        toolCalling: "SUPPORTED",
        promptCaching: "SUPPORTED",
        usageReporting: "SUPPORTED",
        contextWindowTokens: 1_048_576,
      },
      fullAccessPolicy: {
        filesystemBoundary: "HOST_USER_SCOPE",
        processBoundary: "UNRESTRICTED",
        requiredEnforcement: "HARD_SAFETY_ONLY",
        requiresConfirmation: true,
      },
      processSandbox: { status: "AVAILABLE", enforcement: "PARTIAL" },
      status: "READY",
    };
    expect(Stage8PreflightSchema.parse(safeArtifact).source).toBe("LOCAL");
    expect(() =>
      Stage8PreflightSchema.parse({
        ...safeArtifact,
        secret: "must-not-be-serialized",
      }),
    ).toThrow();
  });

  it("freezes the per-attempt provider, tool, and time ceilings", () => {
    expect(STAGE8_LIMITS).toMatchObject({
      maxMainCalls: 36,
      maxProviderCalls: 44,
      maxToolInvocations: 120,
      maxElapsedMs: 7_200_000,
      minimumSegmentSamples: 3,
      minimumBillingHitRateExclusive: 0.9,
      minimumReusablePrefixEfficiency: 0.99,
    });
  });

  it("projects prompt-surface segments as fingerprints and counts without returning content", () => {
    const rawPromptText = "private checkpoint content that must not be projected";
    const result = projectPromptCacheSegments({
      epoch: {
        runId: "run_stage8" as never,
        modelRef: { provider: "deepseek", model: "deepseek-flash" },
        stableHeadFingerprint: "a".repeat(64),
        toolSchemaFingerprint: "b".repeat(64),
        cacheSettingsFingerprint: "c".repeat(64),
        snapshots: [
          {
            ordinal: 1,
            anchor: {
              messageId: "message-stage8" as never,
              runId: "run_stage8" as never,
              conversationTurnId: "turn-stage8",
              sequence: 2,
            },
            content: rawPromptText,
            contentHash: "d".repeat(64),
            sourceStepSequence: 1,
          },
        ],
      },
      promptSurface: {
        prefixFingerprint: "e".repeat(64),
        stableHeadTokens: 200,
        snapshotTokens: 100,
      },
      records: [
        {
          runId: "run_stage8" as never,
          sequence: 1,
          messageType: "USER",
          data: { content: [{ text: "prior" }] },
        },
        {
          runId: "run_stage8" as never,
          sequence: 3,
          messageType: "ASSISTANT",
          data: { content: [{ text: "tail-only" }] },
        },
        {
          runId: "run_other" as never,
          sequence: 100,
          messageType: "ASSISTANT",
          data: { content: [{ text: "other-run-tail" }] },
        },
      ],
      recentTailTokens: 75,
    });

    expect(result).toMatchObject({
      prefixFingerprint: "e".repeat(64),
      stableHeadFingerprint: "a".repeat(64),
      toolCatalogFingerprint: "b".repeat(64),
      cacheSettingsFingerprint: "c".repeat(64),
      stableHeadTokens: 200,
      snapshotTokens: 100,
      recentTailTokens: 75,
      recentTailMessageCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain(rawPromptText);
    expect(JSON.stringify(result)).not.toContain("tail-only");
    expect(JSON.stringify(result)).not.toContain("other-run-tail");
    expect(result.checkpointFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.recentTailFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.roleSizeVectorFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("excludes only the first successful MAIN_AGENT warm-up and accounts auxiliaries", () => {
    let state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    state = recordStage8ProviderSample(state, {
      purpose: "MAIN_AGENT",
      outcome: "FAILED",
      usage: usage(),
    });
    state = recordStage8ProviderSample(state, {
      purpose: "MAIN_AGENT",
      outcome: "SUCCESS",
      usage: usage(),
    });
    expect(state.samples.map((sample: { scoring: string }) => sample.scoring)).toEqual([
      "UNSCORED_FAILED",
      "COLD_WARMUP",
    ]);
    state = recordStage8ProviderSample(state, {
      purpose: "MAIN_AGENT",
      outcome: "SUCCESS",
      usage: usage(),
    });
    state = recordStage8ProviderSample(state, {
      purpose: "RETRY",
      outcome: "SUCCESS",
      usage: usage(),
    });
    expect(state.mainCallCount).toBe(3);
    expect(state.providerCallCount).toBe(4);
    expect(state.scoredMainCallCount).toBe(1);
    expect(state.auxiliaryCallCount).toBe(1);
    expect(state.costStatus).toBe("RECONCILED");
  });

  it("assigns calls around the durable compaction boundary and requires three scored samples per side", () => {
    let state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    for (let index = 0; index < 4; index += 1) {
      state = recordStage8ProviderSample(state, {
        purpose: "MAIN_AGENT",
        outcome: "SUCCESS",
        usage: usage(),
      });
    }
    state = recordStage8Compaction(state, {
      sequence: 19,
      reason: "PROACTIVE_PRESSURE",
      tokensBefore: 80_000,
      tokensAfter: 32_000,
      epochBeforeFingerprint: "a".repeat(64),
      epochAfterFingerprint: "c".repeat(64),
    });
    for (let index = 0; index < 3; index += 1) {
      state = recordStage8ProviderSample(state, {
        purpose: "MAIN_AGENT",
        outcome: "SUCCESS",
        usage: usage({ epochFingerprint: "c".repeat(64), resetReason: "COMPACTION_COMMITTED" }),
      });
    }
    expect(state.preCompactionScoredMainCallCount).toBe(3);
    expect(state.postCompactionScoredMainCallCount).toBe(3);
    expect(state.samples[4].segment).toBe("POST_COMPACTION");
    expect(state.compactionCount).toBe(1);
    expect(state.compaction.sequence).toBe(19);
  });

  it("fuses at the inclusive 90% hit-rate floor once a segment has three scored samples", () => {
    let state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    const observations = [
      usage(),
      usage({ hitTokens: 900, missTokens: 100 }),
      usage({ hitTokens: 900, missTokens: 100 }),
      usage({ hitTokens: 900, missTokens: 100 }),
    ];
    for (const sample of observations) {
      state = recordStage8ProviderSample(state, {
        purpose: "MAIN_AGENT",
        outcome: "SUCCESS",
        usage: sample,
      });
    }
    expect(state.abortReason).toBe("HIT_RATE_FLOOR");
    expect(state.nextProviderCallAllowed).toBe(false);
    expect(state.scoredMainCallCount).toBe(3);
  });

  it("fuses on low reusable-prefix efficiency, unknown usage, unexplained resets, duplicates, and hidden calls", () => {
    const cases = [
      {
        sample: usage({ hitTokens: 800, missTokens: 200, expectedReusablePrefixTokens: 950 }),
        reason: "REUSABLE_PREFIX_ANOMALY",
      },
      { sample: null, reason: "UNKNOWN_USAGE" },
      {
        sample: usage({ resetReason: "UNEXPLAINED" }),
        reason: "UNEXPLAINED_RESET",
      },
    ];
    for (const fixture of cases) {
      const state = recordStage8ProviderSample(
        createStage8AttemptCheckpoint({ attemptId: "attempt-1" }),
        { purpose: "MAIN_AGENT", outcome: "SUCCESS", usage: fixture.sample },
      );
      expect(state.abortReason).toBe(fixture.reason);
    }

    let duplicateState = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    duplicateState = recordStage8ProviderSample(duplicateState, {
      purpose: "MAIN_AGENT",
      outcome: "SUCCESS",
      usage: usage(),
      snapshotFingerprint: "d".repeat(64),
    });
    duplicateState = recordStage8ProviderSample(duplicateState, {
      purpose: "MAIN_AGENT",
      outcome: "SUCCESS",
      usage: usage(),
      snapshotFingerprint: "d".repeat(64),
    });
    expect(duplicateState.duplicateSnapshotCount).toBe(1);
    expect(duplicateState.abortReason).toBe("DUPLICATE_SNAPSHOT");

    const hiddenState = recordStage8ProviderSample(
      createStage8AttemptCheckpoint({ attemptId: "attempt-1" }),
      { purpose: "MAIN_AGENT", outcome: "SUCCESS", usage: usage(), hiddenProviderCalls: 1 },
    );
    expect(hiddenState.hiddenCallCount).toBe(1);
    expect(hiddenState.abortReason).toBe("HIDDEN_PROVIDER_CALL");
  });

  it("counts Tool invocations and stops before exceeding the fixed cap", () => {
    let state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    for (let index = 0; index < 121; index += 1) {
      state = recordStage8ToolInvocation(state);
    }
    expect(state.toolInvocationCount).toBe(120);
    expect(state.nextToolInvocationAllowed).toBe(false);
    expect(state.abortReason).toBe("TOOL_LIMIT");
  });

  it("enforces the 36 MAIN_AGENT and 44 total provider call caps", () => {
    let mainState = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    for (let index = 0; index < 37; index += 1) {
      mainState = recordStage8ProviderSample(mainState, {
        purpose: "MAIN_AGENT",
        outcome: "SUCCESS",
        usage: usage(),
      });
    }
    expect(mainState.mainCallCount).toBe(36);
    expect(mainState.abortReason).toBe("MAIN_CALL_LIMIT");

    let totalState = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    for (let index = 0; index < 45; index += 1) {
      totalState = recordStage8ProviderSample(totalState, {
        purpose: "OTHER",
        outcome: "SUCCESS",
        usage: usage({ expectedReusablePrefixTokens: 0 }),
      });
    }
    expect(totalState.providerCallCount).toBe(44);
    expect(totalState.abortReason).toBe("TOTAL_CALL_LIMIT");
  });

  it("writes intent atomically before dispatch and never resends an in-flight call on resume", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-stage8-audit-"));
    const checkpointPath = join(directory, "attempt.checkpoint.json");
    let state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    state = await writeStage8CheckpointAtomic(checkpointPath, state, {
      dispatch: { purpose: "MAIN_AGENT" },
    });
    expect(JSON.parse(await readFile(checkpointPath, "utf8")).inFlight.callRef).toBe("call-0001");
    const resumed = await writeStage8CheckpointAtomic(checkpointPath, state, {
      resume: true,
    });
    expect(resumed.abortReason).toBe("IN_FLIGHT_REQUEST_NOT_RESENT");
    expect(resumed.providerCallCount).toBe(1);
    expect(resumed.inFlight).toBeNull();
  });

  it("creates the Stage 8 Run through the daemon and checkpoints creation intent before the POST", async () => {
    const { createOrResolveStage8Run } = await import("../../../scripts/stage8-long-run-audit.mjs");
    expect(createOrResolveStage8Run).toBeTypeOf("function");

    const workspace = {
      id: "wsp_stage8_attempt_1",
      canonicalPath: "D:\\Develop\\Caelush-Test\\01-incident-automation-studio-attempt-1",
    };
    const session = {
      id: "ses_stage8_attempt_1",
      title: "Stage 8 attempt-1",
      workspaceId: workspace.id,
      defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
    };
    const prompt = "frozen task contents stay out of the checkpoint";
    const run = {
      id: "run_stage8_attempt_1",
      sessionId: session.id,
      goal: prompt,
      workspace: { id: workspace.id, path: workspace.canonicalPath },
      model: { provider: "deepseek", model: "deepseek-flash" },
    };
    const calls: string[] = [];
    let savedState = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    const client = {
      async listWorkspaces() {
        calls.push("listWorkspaces");
        return { items: [workspace] };
      },
      async listSessions() {
        calls.push("listSessions");
        return { items: [] };
      },
      async createSession(input: Record<string, unknown>) {
        calls.push("createSession");
        expect(input.title).toBe("Stage 8 attempt-1");
        return session;
      },
      async listRuns() {
        calls.push("listRuns");
        return { items: [] };
      },
      async createRun(sessionId: string, input: Record<string, unknown>) {
        calls.push("createRun");
        expect(sessionId).toBe(session.id);
        expect(input.goal).toBe(prompt);
        expect(input.preset).toEqual({ id: "FULL_ACCESS", expectedVersion: 1 });
        expect(input.limits).toEqual({
          maxSteps: 36,
          maxToolCalls: 120,
          timeoutMs: 7_200_000,
        });
        expect(savedState.sessionId).toBe(session.id);
        expect(savedState.runCreationStatus).toBe("IN_FLIGHT");
        return run;
      },
    };

    const result = await createOrResolveStage8Run({
      client,
      attemptId: "attempt-1",
      workspaceRoot: workspace.canonicalPath,
      prompt,
      preflight: {
        providerId: "deepseek",
        selectedProvider: "deepseek",
        selectedModel: "deepseek-flash",
        reasoningLevel: "XHIGH",
      },
      checkpoint: savedState,
      persist: async (state: typeof savedState) => {
        savedState = state;
        return state;
      },
    });

    expect(result.run.id).toBe(run.id);
    expect(result.state).toMatchObject({
      workspaceId: workspace.id,
      sessionId: session.id,
      runId: run.id,
      sessionCreationStatus: "COMMITTED",
      runCreationStatus: "COMMITTED",
    });
    expect(calls).toEqual([
      "listWorkspaces",
      "listSessions",
      "createSession",
      "listRuns",
      "createRun",
    ]);
    expect(JSON.stringify(result.state)).not.toContain(prompt);
  });

  it("opens live Run observation before starting exactly once and checkpoints start intent", async () => {
    const { startStage8RunOnce } = await import("../../../scripts/stage8-long-run-audit.mjs");
    expect(startStage8RunOnce).toBeTypeOf("function");

    const calls: string[] = [];
    const run = { id: "run_stage8_attempt_1", status: "PENDING" };
    const checkpoint = {
      ...createStage8AttemptCheckpoint({ attemptId: "attempt-1" }),
      sessionId: "ses_stage8_attempt_1",
      runId: run.id,
      sessionCreationStatus: "COMMITTED",
      runCreationStatus: "COMMITTED",
      executionStartStatus: "NOT_STARTED",
    };
    let savedState = checkpoint;
    const result = await startStage8RunOnce({
      client: {
        async startRun(runId: string) {
          calls.push("startRun");
          expect(runId).toBe(run.id);
          expect(savedState.executionStartStatus).toBe("IN_FLIGHT");
          return { disposition: "SCHEDULED", run: { ...run, status: "PENDING" } };
        },
      },
      run,
      checkpoint,
      persist: async (state: typeof checkpoint) => {
        savedState = state;
        return state;
      },
      subscribeBeforeStart: async (runId: string, afterSequence: number) => {
        calls.push(`subscribe:${runId}:${afterSequence}`);
      },
    });

    expect(calls).toEqual(["subscribe:run_stage8_attempt_1:0", "startRun"]);
    expect(result.state.executionStartStatus).toBe("COMMITTED");
    expect(result.disposition).toBe("SCHEDULED");
  });

  it("derives exactly one provider-call usage delta from consecutive daemon projections", async () => {
    const { deriveStage8CallObservation } =
      await import("../../../scripts/stage8-long-run-audit.mjs");
    expect(deriveStage8CallObservation).toBeTypeOf("function");

    const fingerprint = (character: string) => character.repeat(64);
    const segments = {
      prefixFingerprint: fingerprint("a"),
      modelFingerprint: fingerprint("b"),
      stableHeadFingerprint: fingerprint("c"),
      toolCatalogFingerprint: fingerprint("d"),
      cacheSettingsFingerprint: fingerprint("e"),
      checkpointFingerprint: fingerprint("f"),
      recentTailFingerprint: fingerprint("1"),
      roleSizeVectorFingerprint: fingerprint("2"),
      stableHeadTokens: 200,
      snapshotTokens: 50,
      recentTailTokens: 300,
      checkpointBytes: 1_000,
      recentTailBytes: 1_500,
      recentTailMessageCount: 2,
    };
    const makeUsage = (requestCount: number, inputTokens: number, hitTokens: number) => ({
      totalRequestCount: requestCount,
      totalInputTokens: inputTokens,
      totalOutputTokens: 30,
      hitTokens,
      missTokens: inputTokens - hitTokens,
      writeTokens: 0,
      unknownUsageCount: 0,
      expectedReusablePrefixTokens: 900,
      epochId: "epoch-a",
      resetReason: "INITIAL",
      purposes: [
        {
          purpose: "MAIN_AGENT",
          requestCount,
          inputTokens,
          outputTokens: 30,
          hitTokens,
          missTokens: inputTokens - hitTokens,
          writeTokens: 0,
          unknownUsageCount: 0,
        },
      ],
      surfaceSegments: segments,
    });

    const observation = deriveStage8CallObservation(
      makeUsage(3, 3_000, 2_700),
      makeUsage(4, 4_200, 3_800),
      17,
    );
    expect(observation).toMatchObject({
      purpose: "MAIN_AGENT",
      usage: {
        inputTokens: 1_200,
        outputTokens: 0,
        hitTokens: 1_100,
        missTokens: 100,
        writeTokens: 0,
        expectedReusablePrefixTokens: 900,
        epochFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        prefixFingerprint: fingerprint("a"),
      },
      surfaceSegments: segments,
      eventSequence: 17,
    });
    const recorded = recordStage8ProviderSample(
      createStage8AttemptCheckpoint({ attemptId: "attempt-1" }),
      { ...observation, outcome: "SUCCESS" },
    );
    expect(recorded.samples[0]).toMatchObject({
      eventSequence: 17,
      surfaceSegments: segments,
    });

    expect(
      deriveStage8CallObservation(makeUsage(3, 3_000, 2_700), makeUsage(5, 5_000, 4_000), 18),
    ).toBeNull();
  });

  it("consumes native Run events into bounded call, Tool, and durable compaction evidence", async () => {
    const { consumeStage8RunEvents } = await import("../../../scripts/stage8-long-run-audit.mjs");
    expect(consumeStage8RunEvents).toBeTypeOf("function");

    const fingerprint = (character: string) => character.repeat(64);
    const segments = (checkpointCharacter: string) => ({
      prefixFingerprint: fingerprint("a"),
      modelFingerprint: fingerprint("b"),
      stableHeadFingerprint: fingerprint("c"),
      toolCatalogFingerprint: fingerprint("d"),
      cacheSettingsFingerprint: fingerprint("e"),
      checkpointFingerprint: fingerprint(checkpointCharacter),
      recentTailFingerprint: fingerprint("1"),
      roleSizeVectorFingerprint: fingerprint("2"),
      stableHeadTokens: 200,
      snapshotTokens: 50,
      recentTailTokens: 300,
      checkpointBytes: 1_000,
      recentTailBytes: 1_500,
      recentTailMessageCount: 2,
    });
    const before = {
      totalRequestCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      hitTokens: 0,
      missTokens: 0,
      writeTokens: 0,
      unknownUsageCount: 0,
      expectedReusablePrefixTokens: 900,
      epochId: "epoch-a",
      resetReason: "INITIAL",
      purposes: [],
      surfaceSegments: segments("f"),
    };
    const afterCall = {
      ...before,
      totalRequestCount: 1,
      totalInputTokens: 1_200,
      totalOutputTokens: 40,
      hitTokens: 1_100,
      missTokens: 100,
      purposes: [
        {
          purpose: "MAIN_AGENT",
          requestCount: 1,
          inputTokens: 1_200,
          outputTokens: 40,
          hitTokens: 1_100,
          missTokens: 100,
          writeTokens: 0,
          unknownUsageCount: 0,
        },
      ],
    };
    const afterCompaction = {
      ...afterCall,
      epochId: "epoch-b",
      resetReason: "COMPACTION_COMMITTED",
      resetStepSequence: 2,
      resetAt: 2,
      surfaceSegments: segments("9"),
    };
    const event = (sequence: number, type: string, payload: Record<string, unknown> = {}) => ({
      runId: "run_stage8_attempt_1",
      type,
      payload,
      durability: { kind: "DURABLE", sequence },
    });
    const events = [
      event(1, "llm.started", { model: { provider: "deepseek", model: "deepseek-flash" } }),
      event(2, "llm.completed", {
        model: { provider: "deepseek", model: "deepseek-flash" },
        usage: { steps: 1, toolCalls: 0, inputTokens: 1_200, outputTokens: 40 },
      }),
      event(3, "tool.requested", { invocationId: "tool-1", toolName: "write_file" }),
      event(4, "context.compaction.completed", {
        checkpointId: "private-checkpoint-id",
        reason: "PROACTIVE_PRESSURE",
        sourceSequenceFrom: 1,
        sourceSequenceTo: 2,
        tokensBefore: 80_000,
        tokensAfter: 32_000,
        degraded: false,
      }),
      event(5, "run.completed", { result: { type: "VERIFIED_COMPLETION" } }),
    ];
    let usageIndex = 0;
    let state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    const result = await consumeStage8RunEvents({
      client: {
        async getRunContextUsage() {
          usageIndex += 1;
          return { promptCache: usageIndex === 1 ? afterCall : afterCompaction };
        },
      },
      events,
      runId: "run_stage8_attempt_1",
      checkpoint: state,
      initialPromptCache: before,
      persist: async (nextState: typeof state) => {
        state = nextState;
        return state;
      },
    });

    expect(result).toMatchObject({
      lastDurableEventSequence: 5,
      providerCallCount: 1,
      mainCallCount: 1,
      toolInvocationCount: 1,
      compactionCount: 1,
      terminalState: "COMPLETED",
      compaction: {
        sequence: 4,
        reason: "PROACTIVE_PRESSURE",
        tokensBefore: 80_000,
        tokensAfter: 32_000,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-checkpoint-id");
  });

  it("stops consuming as soon as a terminal status change is observed", async () => {
    const { consumeStage8RunEvents } = await import("../../../scripts/stage8-long-run-audit.mjs");
    let state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    const events = {
      async *[Symbol.asyncIterator]() {
        yield {
          runId: "run_stage8_test",
          type: "status.changed",
          payload: { from: "RUNNING", to: "COMPLETED" },
          durability: { kind: "DURABLE", sequence: 1 },
        };
        throw new Error("The terminal event stream must not be read further.");
      },
    };
    await expect(
      consumeStage8RunEvents({
        client: {},
        events,
        runId: "run_stage8_test",
        checkpoint: state,
        initialPromptCache: null,
        persist: async (nextState: typeof state) => {
          state = nextState;
          return state;
        },
      }),
    ).resolves.toMatchObject({
      terminalState: "COMPLETED",
      lastDurableEventSequence: 1,
    });
  });

  it("waits for the daemon event stream to open before Run start", async () => {
    const { openStage8RunEventStream } = await import("../../../scripts/stage8-long-run-audit.mjs");
    expect(openStage8RunEventStream).toBeTypeOf("function");

    let resolveFrame: ((value: unknown) => void) | undefined;
    const firstFrame = new Promise<unknown>((resolve) => {
      resolveFrame = resolve;
    });
    let streamOpened = false;
    const client = {
      watchRunEvents(_runId: string, options: { onOpen?: () => void }) {
        return (async function* () {
          streamOpened = true;
          options.onOpen?.();
          yield await firstFrame;
        })();
      },
    };

    const stream = await openStage8RunEventStream(client as never, "run_stage8_test", 12);
    expect(streamOpened).toBe(true);
    const iterator = stream.events[Symbol.asyncIterator]();
    const pending = iterator.next();
    let frameDelivered = false;
    void pending.then(() => {
      frameDelivered = true;
    });
    await Promise.resolve();
    expect(frameDelivered).toBe(false);

    const event = { runId: "run_stage8_test", type: "run.started" };
    resolveFrame?.(event);
    await expect(pending).resolves.toEqual({ value: event, done: false });
    await stream.close();
  });

  it("starts the Run only after SSE is open and checkpoints its terminal event", async () => {
    const { startAndObserveStage8Run } = await import("../../../scripts/stage8-long-run-audit.mjs");
    expect(startAndObserveStage8Run).toBeTypeOf("function");
    const state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    state.sessionId = "ses_stage8_test";
    state.runId = "run_stage8_test";
    state.runCreationStatus = "COMMITTED";
    let streamOpened = false;
    const client = {
      watchRunEvents(_runId: string, options: { onOpen?: () => void }) {
        return (async function* () {
          streamOpened = true;
          options.onOpen?.();
          yield {
            runId: "run_stage8_test",
            type: "run.completed",
            payload: {},
            durability: { kind: "DURABLE", sequence: 1 },
          };
        })();
      },
      async startRun(runId: string) {
        expect(streamOpened).toBe(true);
        return {
          runId,
          action: "START",
          disposition: "SCHEDULED",
          run: { id: runId, status: "RUNNING" },
        };
      },
    };

    const result = await startAndObserveStage8Run({
      client: client as never,
      run: { id: "run_stage8_test", status: "PENDING" },
      checkpoint: state,
      initialPromptCache: null,
      persist: async (nextState: typeof state) => {
        Object.assign(state, nextState);
        return state;
      },
    });

    expect(result.state).toMatchObject({
      executionStartStatus: "COMMITTED",
      lastDurableEventSequence: 1,
      terminalState: "COMPLETED",
    });
  });

  it("opens SSE before recovering a committed Run and never starts it again", async () => {
    const { startAndObserveStage8Run } = await import("../../../scripts/stage8-long-run-audit.mjs");
    const state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    state.sessionId = "ses_stage8_test";
    state.runId = "run_stage8_test";
    state.runCreationStatus = "COMMITTED";
    state.executionStartStatus = "COMMITTED";
    let streamOpened = false;
    let recovered = false;
    let started = false;
    const client = {
      watchRunEvents(_runId: string, options: { onOpen?: () => void }) {
        return (async function* () {
          streamOpened = true;
          options.onOpen?.();
          yield {
            runId: "run_stage8_test",
            type: "run.completed",
            payload: {},
            durability: { kind: "DURABLE", sequence: 1 },
          };
        })();
      },
      async getRun() {
        return { id: "run_stage8_test", status: "RUNNING" };
      },
      async startRun() {
        started = true;
        throw new Error("A committed Run must not be started again.");
      },
      async recoverRun(runId: string) {
        expect(streamOpened).toBe(true);
        recovered = true;
        return {
          runId,
          action: "RECOVER",
          disposition: "ALREADY_ACTIVE",
          run: { id: runId, status: "RUNNING" },
        };
      },
      async cancelRun() {
        return undefined;
      },
    };

    const result = await startAndObserveStage8Run({
      client: client as never,
      run: { id: "run_stage8_test", status: "RUNNING" },
      checkpoint: state,
      initialPromptCache: null,
      persist: async (nextState: typeof state) => {
        Object.assign(state, nextState);
        return state;
      },
    });

    expect(recovered).toBe(true);
    expect(started).toBe(false);
    expect(result.state.terminalState).toBe("COMPLETED");
  });

  it("does not retry an unresolved Run start", async () => {
    const { startAndObserveStage8Run } = await import("../../../scripts/stage8-long-run-audit.mjs");
    const state = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    state.sessionId = "ses_stage8_test";
    state.runId = "run_stage8_test";
    state.runCreationStatus = "COMMITTED";
    state.executionStartStatus = "IN_FLIGHT";
    let startCount = 0;
    let cancelCount = 0;
    const client = {
      async startRun() {
        startCount += 1;
        throw new Error("Must not retry.");
      },
      async cancelRun() {
        cancelCount += 1;
        return undefined;
      },
    };
    const result = await startAndObserveStage8Run({
      client: client as never,
      run: { id: "run_stage8_test", status: "PENDING" },
      checkpoint: state,
      initialPromptCache: null,
      persist: async (nextState: typeof state) => {
        Object.assign(state, nextState);
        return state;
      },
    });

    expect(startCount).toBe(0);
    expect(cancelCount).toBe(1);
    expect(result.state).toMatchObject({
      executionStartStatus: "IN_FLIGHT",
      abortReason: "RUN_START_OUTCOME_UNRESOLVED",
      costStatus: "UNREPORTED",
    });
  });

  it("writes bounded liveness metadata without serializing Run content", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-stage8-liveness-"));
    const path = join(directory, "liveness.jsonl");
    const checkpoint = createStage8AttemptCheckpoint({ attemptId: "attempt-1" });
    checkpoint.providerCallCount = 3;
    checkpoint.lastDurableEventSequence = 17;
    const result = await appendStage8LivenessSample({
      path,
      baseUrl: "http://127.0.0.1:43120",
      runId: "run_stage8_test",
      checkpoint,
      client: {
        async getRun() {
          return { id: "run_stage8_test", status: "RUNNING", goal: "private task text" };
        },
      } as never,
      fetcher: async (input: URL | RequestInfo) =>
        new Response(null, { status: String(input).endsWith("/") ? 200 : 204 }),
      now: () => 1234,
    });

    expect(result).toMatchObject({
      timestamp: 1234,
      daemonHttpStatus: 204,
      webHttpStatus: 200,
      runStatus: "RUNNING",
      providerCallCount: 3,
      durableEventSequence: 17,
    });
    const line = await readFile(path, "utf8");
    expect(line).not.toContain("private task text");
    expect(line).not.toContain("goal");
  });
});
