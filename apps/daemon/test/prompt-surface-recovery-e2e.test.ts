import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAIError,
  type AIAdapterEvent,
  type ApiAdapter,
  type ApiAdapterStreamInput,
  type ResolvedAIModelRequest,
} from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { createWorkspaceId, type RunId } from "@caelush/protocol";
import { openCaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

const MODEL = { provider: "fixture", model: "fixture-model" } as const;

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

class LocalRecoveryAdapter implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly requests: ResolvedAIModelRequest[] = [];
  private taskCalls = 0;

  constructor(private readonly failFirstTask: boolean) {}

  async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input.request);
    if (isReviewRequest(input.request)) {
      yield* this.textEvents(JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
      return;
    }
    this.taskCalls += 1;
    if (this.failFirstTask && this.taskCalls === 1) {
      // The local adapter fails before opening any HTTP transport. Context and Prompt Surface
      // persistence have already completed by the time the gateway enters this method.
      throw createAIError("AI_RATE_LIMIT", undefined, { retryAfterMs: 250 });
    }
    yield* this.textEvents("Recovered from the persisted local retry boundary.");
  }

  get taskRequestCount(): number {
    return this.taskCalls;
  }

  private async *textEvents(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("Prompt Surface daemon recovery E2E", () => {
  it("reuses the persisted snapshot after a pre-HTTP failure and daemon restart", async () => {
    const workspacePath = await makeWorkspace("caelush-prompt-surface-retry-e2e-");
    const databasePath = join(workspacePath, "caelush.db");
    const firstAdapter = new LocalRecoveryAdapter(true);
    daemon = await startPromptSurfaceDaemon(databasePath, firstAdapter);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);

    await client.startRun(run.id);
    await waitForRetryBoundary(databasePath, run.id);
    const beforeRestart = await readSnapshotFacts(databasePath, run.id);
    expect(beforeRestart).toHaveLength(1);
    expect(firstAdapter.taskRequestCount).toBe(1);
    await daemon.close();
    daemon = undefined;

    const recoveredAdapter = new LocalRecoveryAdapter(false);
    daemon = await startPromptSurfaceDaemon(databasePath, recoveredAdapter);
    const recoveredClient = new CaelushClient({ baseUrl: daemon.url });
    const settled = await waitForRun(recoveredClient, run.id);

    expect(settled.status).toBe("COMPLETED");
    expect(recoveredAdapter.taskRequestCount).toBe(1);
    const failedRequest = firstAdapter.requests.find((request) => !isReviewRequest(request));
    const recoveredRequest = recoveredAdapter.requests.find((request) => !isReviewRequest(request));
    expect(failedRequest).toBeDefined();
    expect(recoveredRequest).toBeDefined();
    expect(
      failedRequest !== undefined &&
        recoveredRequest !== undefined &&
        isMessagePrefix(failedRequest.messages, recoveredRequest.messages),
    ).toBe(true);
    const afterRestart = await readSnapshotFacts(databasePath, run.id);
    expect(afterRestart.length).toBeGreaterThanOrEqual(beforeRestart.length);
    expect(sameSnapshotFacts(beforeRestart, afterRestart.slice(0, beforeRestart.length))).toBe(
      true,
    );
    expect(new Set(afterRestart.map((fact) => fact.step)).size).toBe(afterRestart.length);
    expect(afterRestart.every((fact, index) => fact.ordinal === index + 1)).toBe(true);
    // This fixture uses an in-process API adapter; it never makes a loopback or Provider HTTP call.
    expect(firstAdapter.requests.length + recoveredAdapter.requests.length).toBe(3);
  }, 15_000);

  it("fails closed on a corrupted snapshot after the persisted retry restarts", async () => {
    const workspacePath = await makeWorkspace("caelush-prompt-surface-corrupt-e2e-");
    const databasePath = join(workspacePath, "caelush.db");
    const firstAdapter = new LocalRecoveryAdapter(true);
    daemon = await startPromptSurfaceDaemon(databasePath, firstAdapter);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);

    await client.startRun(run.id);
    await waitForRetryBoundary(databasePath, run.id);
    const persistedFacts = await readSnapshotFacts(databasePath, run.id);
    expect(persistedFacts).toHaveLength(1);
    await daemon.close();
    daemon = undefined;

    const raw = new DatabaseSync(databasePath);
    try {
      const corrupted = raw
        .prepare("UPDATE prompt_surface_snapshots SET content_hash = ? WHERE run_id = ?")
        .run("0".repeat(64), run.id);
      expect(corrupted.changes).toBe(1);
    } finally {
      raw.close();
    }

    const recoveryAdapter = new LocalRecoveryAdapter(false);
    daemon = await startPromptSurfaceDaemon(databasePath, recoveryAdapter);
    const recoveredClient = new CaelushClient({ baseUrl: daemon.url });
    const settled = await waitForRun(recoveredClient, run.id);

    expect(settled.status).toBe("FAILED");
    expect(recoveryAdapter.requests).toHaveLength(0);
    const verificationDb = new DatabaseSync(databasePath);
    try {
      const count = verificationDb
        .prepare("SELECT COUNT(*) AS count FROM prompt_surface_snapshots WHERE run_id = ?")
        .get(run.id) as { readonly count: number };
      expect(count.count).toBe(1);
    } finally {
      verificationDb.close();
    }
  }, 15_000);
});

async function startPromptSurfaceDaemon(databasePath: string, adapter: ApiAdapter) {
  return startDaemon({
    databasePath,
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [fixtureBinding()],
    modelSources: [fixtureModelSource()],
    adapterOverrides: [adapter],
    defaultModel: MODEL,
    logger: false,
  });
}

async function makeWorkspace(prefix: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  directory = workspacePath;
  await mkdir(join(workspacePath, "src"));
  return workspacePath;
}

async function createRun(client: CaelushClient, workspacePath: string) {
  const workspace = { id: createWorkspaceId(), path: workspacePath };
  const session = await client.createSession({
    defaultWorkspace: workspace,
    defaultModel: MODEL,
  });
  const run = await client.createRun(session.id, {
    goal: "inspect the local recovery fixture",
    workspace: session.defaultWorkspace ?? workspace,
    model: MODEL,
    runtime: { id: "local", kind: "local" },
    preset: { id: "FULL_ACCESS", expectedVersion: 1 },
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 30_000 },
  });
  return { run };
}

async function waitForRetryBoundary(databasePath: string, runId: RunId): Promise<void> {
  const storage = await openCaelushStorage({ path: databasePath });
  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const snapshot = await storage.execution.load(runId);
      if (snapshot?.continuation?.type === "WAITING_RETRY") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await storage.close();
  }
  throw new Error("The local retry continuation was not durably persisted.");
}

async function readSnapshotFacts(
  databasePath: string,
  runId: RunId,
): Promise<readonly { ordinal: number; anchor: number; step: number; hash: string }[]> {
  const storage = await openCaelushStorage({ path: databasePath });
  try {
    const current = await storage.promptSurface.getCurrent(runId);
    if (current === undefined) return [];
    const surface = await storage.promptSurface.readEpoch(current.runId, current.epochId);
    return (surface?.snapshots ?? []).map((snapshot) => ({
      ordinal: snapshot.ordinal,
      anchor: snapshot.anchorMessageSequence,
      step: snapshot.sourceStepSequence,
      hash: snapshot.contentHash,
    }));
  } finally {
    await storage.close();
  }
}

function sameSnapshotFacts(
  left: readonly { ordinal: number; anchor: number; step: number; hash: string }[],
  right: readonly { ordinal: number; anchor: number; step: number; hash: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (fact, index) =>
        fact.ordinal === right[index]?.ordinal &&
        fact.anchor === right[index]?.anchor &&
        fact.step === right[index]?.step &&
        fact.hash === right[index]?.hash,
    )
  );
}

function isMessagePrefix(prefix: readonly unknown[], candidate: readonly unknown[]): boolean {
  return (
    candidate.length >= prefix.length &&
    JSON.stringify(candidate.slice(0, prefix.length)) === JSON.stringify(prefix)
  );
}

function isReviewRequest(request: ResolvedAIModelRequest): boolean {
  return request.messages.some(
    (message) => message.role === "system" && message.content.includes("Review the supplied"),
  );
}

async function waitForRun(client: CaelushClient, runId: Parameters<CaelushClient["getRun"]>[0]) {
  let run = await client.getRun(runId);
  for (let attempt = 0; attempt < 600 && !isTerminal(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    run = await client.getRun(runId);
  }
  return run;
}

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
