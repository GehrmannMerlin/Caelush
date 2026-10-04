import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaelushClient } from "@caelush/client";
import { createAIError } from "@caelush/ai";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { createWorkspaceId } from "@caelush/protocol";
import { openCaelushStorage } from "@caelush/storage";
import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

const handles: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class ShutdownRecoveryProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly entered = deferred<void>();
  calls = 0;

  constructor(private readonly hangFirst: boolean) {}

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    if (this.hangFirst && this.calls === 1) return this.waitForAbort(input.signal);
    const isReview = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    return this.events(
      isReview
        ? JSON.stringify({ verdict: "PASS", summary: "The recovered task is acceptable." })
        : "Recovered after managed daemon restart.",
    );
  }

  // eslint-disable-next-line require-yield -- This fixture intentionally waits for abort then throws without producing Provider data.
  private async *waitForAbort(signal: AbortSignal): AsyncGenerator<AIAdapterEvent> {
    this.entered.resolve();
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
    }
    throw createAIError("AI_ABORTED");
  }

  private async *events(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close().catch(() => undefined);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function makeDatabasePath(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `caelush-${name}-`));
  directories.push(directory);
  return join(directory, "caelush.db");
}

async function jsonRequest<T extends Record<string, unknown> = Record<string, unknown>>(
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { response, body: (await response.json()) as T };
}

describe("daemon lifecycle", () => {
  it("checkpoints a hung model attempt on close and recovers it after restart", async () => {
    const databasePath = await makeDatabasePath("managed-restart");
    const workspacePath = dirname(databasePath);
    const firstProvider = new ShutdownRecoveryProvider(true);
    const first = await startDaemon({
      databasePath,
      port: 0,
      shutdownTimeoutMs: 8_000,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [firstProvider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    handles.push(first);
    const firstClient = new CaelushClient({ baseUrl: first.url });
    const requestedWorkspace = { id: createWorkspaceId(), path: workspacePath };
    const session = await firstClient.createSession({
      defaultWorkspace: requestedWorkspace,
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const workspace = session.defaultWorkspace ?? requestedWorkspace;
    const run = await firstClient.createRun(session.id, {
      goal: "finish the task after a managed restart",
      workspace,
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 60_000 },
    });
    await firstClient.startRun(run.id);
    await firstProvider.entered.promise;
    await first.close();

    const inspection = await openCaelushStorage({ path: databasePath });
    const checkpoint = await inspection.execution.load(run.id);
    expect(checkpoint?.run.status).toBe("RUNNING");
    expect(checkpoint?.continuation).toMatchObject({
      type: "WAITING_RETRY",
      attempt: 2,
      maxAttempts: 6,
      errorCode: "LLM_NETWORK",
    });
    const committedBeforeRestart = await inspection.eventReader.replay(run.id, {
      afterSequence: 0,
      throughSequence: await inspection.eventReader.latestSequence(run.id),
      limit: 100,
    });
    expect(committedBeforeRestart.map((event) => event.type)).toContain("retry.scheduled");
    await inspection.close();

    const secondProvider = new ShutdownRecoveryProvider(false);
    const second = await startDaemon({
      databasePath,
      port: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [secondProvider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    handles.push(second);
    const secondClient = new CaelushClient({ baseUrl: second.url });
    let settled = await secondClient.getRun(run.id);
    for (let attempt = 0; attempt < 240 && settled.status !== "COMPLETED"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await secondClient.getRun(run.id);
    }

    expect(settled.status).toBe("COMPLETED");
    expect(secondProvider.calls).toBeGreaterThanOrEqual(2);
    await second.close();

    const finalInspection = await openCaelushStorage({ path: databasePath });
    const events = await finalInspection.eventReader.replay(run.id, {
      afterSequence: 0,
      throughSequence: await finalInspection.eventReader.latestSequence(run.id),
      limit: 100,
    });
    expect(events.map((event) => event.type).filter((type) => type === "retry.started")).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("run.completed");
    await finalInspection.close();
  }, 20_000);

  it("rejects an unbounded shutdown deadline", async () => {
    await expect(
      startDaemon({ databasePath: ":memory:", shutdownTimeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("shutdownTimeoutMs must be a finite positive safe integer");
  });

  it("starts on an ephemeral port and closes idempotently with active SSE", async () => {
    const databasePath = await makeDatabasePath("shutdown");
    // Phase 2C: the daemon composes the AI model authority, so a Run may only name a
    // model the provider registry and the model catalog can resolve. The Run below is
    // never started; this configuration exists so its creation stays a 201 and the
    // test keeps exercising a real, active SSE subscription.
    const handle = await startDaemon({
      databasePath,
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providers: [
        {
          provider: "test",
          baseUrl: "http://test.invalid/v1",
          allowedModels: ["test-model"],
        },
      ],
    });
    handles.push(handle);
    const health = await fetch(`${handle.url}/api/v1/health`);
    expect(health.status).toBe(200);

    const { body: session } = await jsonRequest<{ id: string }>(`${handle.url}/api/v1/sessions`, {
      method: "POST",
      body: "{}",
    });
    const { body: run } = await jsonRequest<{ id: string }>(
      `${handle.url}/api/v1/sessions/${session.id}/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          goal: "shutdown",
          workspace: { id: "wsp_00000000-0000-7000-8000-000000000000", path: "C:/workspace" },
          model: { provider: "test", model: "test-model" },
          runtime: { id: "local", kind: "test" },
          preset: { id: "VIEW_ONLY", expectedVersion: 1 },
          limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
        }),
      },
    );
    const stream = fetch(`${handle.url}/api/v1/runs/${run.id}/events`, {
      headers: { accept: "text/event-stream" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await Promise.race([
      handle.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("daemon close timeout")), 2000),
      ),
    ]);
    await expect(handle.close()).resolves.toBeUndefined();
    const streamResponse = await stream;
    const reader = streamResponse.body?.getReader();
    if (reader) {
      let result = await reader.read();
      for (let attempt = 0; attempt < 8 && !result.done; attempt += 1) {
        result = await reader.read();
      }
      expect(result.done).toBe(true);
      reader.releaseLock();
    }
  });

  it("rejects an invalid database startup before listening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-invalid-db-"));
    directories.push(directory);
    await expect(startDaemon({ databasePath: directory, port: 0 })).rejects.toThrow();
  });

  it("fails clearly when the requested port is already occupied", async () => {
    const first = await startDaemon({ databasePath: await makeDatabasePath("first"), port: 0 });
    handles.push(first);
    const port = new URL(first.url).port;
    await expect(
      startDaemon({ databasePath: await makeDatabasePath("second"), port: Number(port) }),
    ).rejects.toThrow();
  });
});
