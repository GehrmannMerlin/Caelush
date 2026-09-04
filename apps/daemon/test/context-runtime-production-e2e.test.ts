import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type ModelRef } from "@caelush/protocol";
import type {
  LLMCapabilities,
  LLMProvider,
  LLMProviderCallContext,
  LLMProviderRequest,
  LLMStreamEvent,
  ProviderId,
} from "@caelush/llm";
import { CaelushClient } from "@caelush/client";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

class ContextFixtureProvider implements LLMProvider {
  readonly id = "fixture" as ProviderId;
  calls = 0;

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "fixture-model";
  }

  getCapabilities(): LLMCapabilities {
    return {
      textStreaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "SUPPORTED",
      vision: "UNSUPPORTED",
      reasoningSummary: "UNSUPPORTED",
    };
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.calls += 1;
    const review = request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    return this.events(
      request,
      context,
      review
        ? JSON.stringify({ verdict: "PASS", summary: "The candidate is acceptable." })
        : "done",
    );
  }

  private async *events(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
    text: string,
  ): AsyncIterable<LLMStreamEvent> {
    yield {
      type: "stream.start",
      payload: { callId: context.callId, providerId: this.id, model: request.model },
    };
    yield { type: "text.delta", payload: { text } };
    yield { type: "stream.finish", payload: { finishReason: "STOP" } };
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
      providerOverrides: [provider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const run = await client.createRun(session.id, {
      goal: "describe the workspace",
      workspace: { id: createWorkspaceId(), path: directory },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
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
      lastBuildAt: expect.any(Number),
      lastBuildStatus: "SUCCESS",
    });
    expect(provider.calls).toBeGreaterThanOrEqual(2);
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
