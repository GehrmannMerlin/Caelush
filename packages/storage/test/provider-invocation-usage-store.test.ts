import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLLMCallId, createStepId, createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/storage.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteProviderInvocationUsageStore", () => {
  it("summarizes completed request and token usage across lifetime and a requested period", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-provider-usage-summary-"));
    directories.push(directory);
    const storage = await openCaelushStorage({ path: join(directory, "usage.sqlite") });
    try {
      const session = makeSession();
      const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(10) });
      await storage.sessions.insert(session);
      await storage.runs.insert(run);

      const addUsage = async (input: {
        readonly observedAt: number;
        readonly status: "COMPLETE" | "FAILED";
        readonly totalTokens?: number;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
      }) => {
        const callId = createLLMCallId();
        await storage.providerInvocationUsage.observe({
          callId,
          runId: run.id,
          purpose: "MAIN_AGENT",
          providerId: "deepseek",
          modelId: "deepseek-chat",
          api: "openai-compatible",
          continuityGroup: "a".repeat(64),
          requestFingerprint: "b".repeat(64),
          observedAt: createTimestampMs(input.observedAt),
        });
        await storage.providerInvocationUsage.settle({
          callId,
          status: input.status,
          settledAt: createTimestampMs(input.observedAt + 1),
          ...(input.totalTokens === undefined ? {} : { totalTokens: input.totalTokens }),
          ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
          ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
        });
      };

      await addUsage({ observedAt: 1_100, status: "COMPLETE", totalTokens: 7 });
      await addUsage({ observedAt: 1_200, status: "COMPLETE", inputTokens: 4, outputTokens: 5 });
      await addUsage({ observedAt: 900, status: "COMPLETE", totalTokens: 11 });
      await addUsage({ observedAt: 1_300, status: "FAILED", totalTokens: 100 });

      await expect(
        storage.providerInvocationUsage.getSummary(createTimestampMs(1_000)),
      ).resolves.toEqual({
        allTime: { successfulRequests: 3, totalTokens: 27 },
        since: { successfulRequests: 2, totalTokens: 16 },
      });
    } finally {
      await storage.close();
    }
  });

  it("leaves token totals unknown when any completed request has no provider usage counters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-provider-usage-unknown-summary-"));
    directories.push(directory);
    const storage = await openCaelushStorage({ path: join(directory, "usage.sqlite") });
    try {
      const session = makeSession();
      const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(10) });
      await storage.sessions.insert(session);
      await storage.runs.insert(run);
      const callId = createLLMCallId();
      await storage.providerInvocationUsage.observe({
        callId,
        runId: run.id,
        purpose: "MAIN_AGENT",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        api: "openai-compatible",
        continuityGroup: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        observedAt: createTimestampMs(20),
      });
      await storage.providerInvocationUsage.settle({
        callId,
        status: "COMPLETE",
        settledAt: createTimestampMs(21),
      });
      const meteredCallId = createLLMCallId();
      await storage.providerInvocationUsage.observe({
        callId: meteredCallId,
        runId: run.id,
        purpose: "MAIN_AGENT",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        api: "openai-compatible",
        continuityGroup: "c".repeat(64),
        requestFingerprint: "d".repeat(64),
        observedAt: createTimestampMs(22),
      });
      await storage.providerInvocationUsage.settle({
        callId: meteredCallId,
        status: "COMPLETE",
        settledAt: createTimestampMs(23),
        totalTokens: 15,
      });

      await expect(
        storage.providerInvocationUsage.getSummary(createTimestampMs(10)),
      ).resolves.toEqual({
        allTime: { successfulRequests: 2, totalTokens: null },
        since: { successfulRequests: 2, totalTokens: null },
      });
    } finally {
      await storage.close();
    }
  });

  it("persists one identified Provider sample, settles idempotently, and restores it after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-provider-usage-"));
    directories.push(directory);
    const databasePath = join(directory, "usage.sqlite");
    const session = makeSession();
    const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(10) });
    const callId = createLLMCallId();
    const stepId = createStepId();
    const identity = {
      callId,
      runId: run.id,
      stepId,
      purpose: "VERIFICATION_LLM" as const,
      providerId: "deepseek",
      modelId: "deepseek-chat",
      api: "openai-compatible",
      continuityGroup: "a".repeat(64),
      cacheEpochId: "b".repeat(64),
      prefixFingerprint: "c".repeat(64),
      requestFingerprint: "d".repeat(64),
      observedAt: createTimestampMs(20),
    };

    const first = await openCaelushStorage({ path: databasePath });
    await first.sessions.insert(session);
    await first.runs.insert(run);
    await first.providerInvocationUsage.observe(identity);
    await first.providerInvocationUsage.settle({
      callId,
      status: "COMPLETE",
      settledAt: createTimestampMs(21),
      totalTokens: 17_328,
      inputTokens: 16_017,
      outputTokens: 1_311,
      cacheHitInputTokens: 12_000,
      cacheMissInputTokens: 4_017,
      cacheWriteInputTokens: 100,
      reasoningTokens: 500,
    });
    await first.close();

    const reopened = await openCaelushStorage({ path: databasePath });
    try {
      await expect(reopened.providerInvocationUsage.observe(identity)).resolves.toMatchObject({
        callId,
        runId: run.id,
        stepId,
        purpose: "VERIFICATION_LLM",
        status: "COMPLETE",
        totalTokens: 17_328,
        inputTokens: 16_017,
        outputTokens: 1_311,
        cacheHitInputTokens: 12_000,
        cacheMissInputTokens: 4_017,
        cacheWriteInputTokens: 100,
        reasoningTokens: 500,
      });
      await expect(
        reopened.providerInvocationUsage.listByRunStep(run.id, stepId),
      ).resolves.toMatchObject([
        { callId, stepId, status: "COMPLETE", inputTokens: 16_017, outputTokens: 1_311 },
      ]);
      await expect(
        reopened.providerInvocationUsage.settle({
          callId,
          status: "COMPLETE",
          settledAt: createTimestampMs(22),
          totalTokens: 17_328,
          inputTokens: 16_017,
          outputTokens: 1_311,
          cacheHitInputTokens: 12_000,
          cacheMissInputTokens: 4_017,
          cacheWriteInputTokens: 100,
          reasoningTokens: 500,
        }),
      ).resolves.toBeUndefined();
      await expect(
        reopened.providerInvocationUsage.settle({
          callId,
          status: "COMPLETE",
          settledAt: createTimestampMs(22),
          totalTokens: 17_328,
          inputTokens: 16_017,
          outputTokens: 1_311,
          cacheHitInputTokens: 11_999,
          cacheMissInputTokens: 4_018,
          cacheWriteInputTokens: 100,
          reasoningTokens: 500,
        }),
      ).rejects.toThrow("cannot be overwritten");
    } finally {
      await reopened.close();
    }
    const sqlite = new DatabaseSync(databasePath);
    try {
      const rawRows = sqlite
        .prepare(
          "SELECT call_id, purpose, status, request_fingerprint, input_tokens, cache_hit_input_tokens FROM provider_invocation_usage",
        )
        .all() as unknown as Array<Record<string, unknown>>;
      expect(rawRows).toHaveLength(1);
      expect(JSON.stringify(rawRows)).not.toContain("C4_PRIVATE_REPLAY_SENTINEL");
      expect(JSON.stringify(rawRows)).not.toContain("reasoning_content");
    } finally {
      sqlite.close();
    }
  });

  it("keeps historical observations without a Step readable but out of Step-scoped billing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-provider-usage-legacy-step-"));
    directories.push(directory);
    const storage = await openCaelushStorage({ path: join(directory, "usage.sqlite") });
    try {
      const session = makeSession();
      const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(10) });
      await storage.sessions.insert(session);
      await storage.runs.insert(run);
      const identity = {
        callId: createLLMCallId(),
        runId: run.id,
        purpose: "MAIN_AGENT" as const,
        providerId: "deepseek",
        modelId: "deepseek-chat",
        api: "openai-compatible",
        continuityGroup: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        observedAt: createTimestampMs(20),
      };

      await expect(storage.providerInvocationUsage.observe(identity)).resolves.not.toHaveProperty(
        "stepId",
      );
      await expect(
        storage.providerInvocationUsage.listByRunStep(run.id, createStepId()),
      ).resolves.toEqual([]);
    } finally {
      await storage.close();
    }
  });

  it("cascades request samples with their owning Run and rejects cross-Run call identity reuse", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-provider-usage-cascade-"));
    directories.push(directory);
    const databasePath = join(directory, "usage.sqlite");
    const callId = createLLMCallId();
    const storage = await openCaelushStorage({ path: databasePath });
    try {
      const session = makeSession();
      const runA = makeRun(session.id);
      const runB = makeRun(session.id);
      await storage.sessions.insert(session);
      await storage.runs.insert(runA);
      await storage.runs.insert(runB);
      const input = {
        callId,
        runId: runA.id,
        purpose: "MAIN_AGENT" as const,
        providerId: "deepseek",
        modelId: "deepseek-chat",
        api: "openai-compatible",
        continuityGroup: "a".repeat(64),
        requestFingerprint: "d".repeat(64),
        observedAt: createTimestampMs(20),
      };
      await storage.providerInvocationUsage.observe(input);
      await expect(
        storage.providerInvocationUsage.observe({ ...input, runId: runB.id }),
      ).rejects.toThrow("already belongs to another request");
    } finally {
      await storage.close();
    }
    const sqlite = new DatabaseSync(databasePath);
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      const row = sqlite
        .prepare("SELECT run_id FROM provider_invocation_usage WHERE call_id = ?")
        .get(callId) as { run_id: string };
      sqlite.prepare("DELETE FROM agent_runs WHERE id = ?").run(row.run_id);
    } finally {
      sqlite.close();
    }
    const reopened = await openCaelushStorage({ path: databasePath });
    try {
      await expect(reopened.providerInvocationUsage.get(callId)).resolves.toBeNull();
    } finally {
      await reopened.close();
    }
  });
});
