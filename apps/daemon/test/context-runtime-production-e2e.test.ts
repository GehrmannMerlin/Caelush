import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

class ContextFixtureProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    const review = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    return this.events(
      review
        ? JSON.stringify({ verdict: "PASS", summary: "The candidate is acceptable." })
        : "done",
    );
  }

  private async *events(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("Context Runtime production E2E", () => {
  it("persists context telemetry through the real daemon and API", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-context-production-e2e-"));
    const provider = new ContextFixtureProvider();
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
      contextBudgetPolicyVersion: "ADAPTIVE_V1",
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const workspace = session.defaultWorkspace;
    if (workspace === undefined) throw new Error("test Workspace was not registered");
    const run = await client.createRun(session.id, {
      goal: "describe the workspace",
      workspace,
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
    });
    expect(run.contextBudgetPolicy).toMatchObject({
      version: "ADAPTIVE_V1",
      outputReserveTokens: 8_192,
      safetyReserveTokens: 1_280,
    });
    await client.startRun(run.id);
    let settled = await client.getRun(run.id);
    for (let attempt = 0; attempt < 80 && !isTerminal(settled.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await client.getRun(run.id);
    }
    expect(settled.status).toBe("COMPLETED");
    const usage = await client.getRunContextUsage(run.id);
    expect(usage).toMatchObject({
      rawContextWindowTokens: expect.any(Number),
      effectiveInputLimitTokens: expect.any(Number),
      fullRequestInputEstimateTokens: expect.any(Number),
      fullWindowUsedRatio: expect.any(Number),
      lastBuildAt: expect.any(Number),
      lastBuildStatus: "SUCCESS",
    });
    expect(usage.fullRequestInputEstimateTokens).toBeGreaterThanOrEqual(usage.estimatedInputTokens);
    expect(usage.fullWindowUsedRatio).toBe(
      Math.min(1, usage.fullRequestInputEstimateTokens / usage.rawContextWindowTokens),
    );
    expect(usage.pressureState).toBe("NORMAL");
    expect(usage.effectiveInputLimitTokens).toBeLessThanOrEqual(
      usage.rawContextWindowTokens - 8_192 - 1_280,
    );
    expect(provider.calls).toBeGreaterThan(0);
  }, 20_000);
});

function isTerminal(status: string): boolean {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}
