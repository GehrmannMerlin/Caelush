import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type AgentEvent } from "@caelush/protocol";
import {
  createAIError,
  type AIAdapterEvent,
  type ApiAdapter,
  type ApiAdapterStreamInput,
} from "@caelush/ai";
import { openCaelushStorage } from "@caelush/storage";
import { CaelushClient } from "@caelush/client";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import {
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  fixtureBinding,
  fixtureModelSource,
} from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  daemon = undefined;
});

/**
 * Phase 2C: a daemon fixture adapter is a *dialect*, not a vendor.
 *
 * Every class below therefore registers the shared `FIXTURE_API` id and implements the
 * AI core's `ApiAdapter` seam. There is no `supportsModel` and no capability
 * declaration any more: model metadata is the model catalog's authority, and the
 * gateway owns the `stream.start` / `stream.finish` envelope, so an adapter emits only
 * dialect events.
 */
class ApprovalProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  calls = 0;
  patchCalls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    const isReview = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    if (isReview) {
      return this.text(
        JSON.stringify({ verdict: "PASS", summary: "The approved task is acceptable." }),
      );
    }
    if (this.calls === 1) {
      this.patchCalls += 1;
      return this.toolCall();
    }
    return this.text("The approved change is complete.");
  }

  private async *toolCall(): AsyncGenerator<AIAdapterEvent> {
    yield {
      type: "tool_call.start",
      payload: { toolCallId: "approval_patch", toolName: "apply_patch" },
    };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "approval_patch",
        name: "apply_patch",
        input: {
          patch: "*** Begin Patch\n*** Update File: README.md\n@@\n-before\n+after\n*** End Patch",
        },
      },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *text(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

class BlockingProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly entered = deferred<void>();
  readonly aborted = deferred<void>();

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    return this.block(input);
  }

  private async *block(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.entered.resolve();
    await new Promise<void>((resolve) => {
      if (input.signal.aborted) {
        resolve();
        return;
      }
      input.signal.addEventListener(
        "abort",
        () => {
          this.aborted.resolve();
          resolve();
        },
        { once: true },
      );
    });
    // The adapter receives the gateway-owned signal unchanged. An aborted turn has no
    // dialect event to report — the gateway owns `stream.start` and `stream.error` — so
    // the abort surfaces as the AI core's own abort code and nothing is yielded.
    if (input.signal.aborted) throw createAIError("AI_ABORTED");
    yield* [] as readonly AIAdapterEvent[];
  }
}

class RetryProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly firstFailed = deferred<void>();
  calls = 0;

  constructor(private readonly failFirst: boolean) {}

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    if (this.failFirst && this.calls === 1) return this.failNetwork();
    if (
      input.request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.text(JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
    }
    return this.text();
  }

  private async *failNetwork(): AsyncGenerator<AIAdapterEvent> {
    this.firstFailed.resolve();
    yield* [];
    // The transient provider failure is now an AI core code; only `AI_RATE_LIMIT`,
    // `AI_NETWORK` and `AI_TIMEOUT` carry retry metadata into the durable layer.
    throw createAIError("AI_NETWORK", undefined, { retryAfterMs: 2_500 });
  }

  private async *text(text = "Recovered and completed."): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("production daemon control-plane E2E", () => {
  it("waits for approval, resolves through HTTP, resumes the exact Tool, and completes", async () => {
    const workspacePath = await makeWorkspace("caelush-approval-e2e-", "before\n");
    const provider = new ApprovalProvider();
    daemon = await startFixtureDaemon(workspacePath, provider);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { session, run } = await createFixtureRun(client, workspacePath, "DANGEROUS_ONLY");

    expect((await client.startRun(run.id)).disposition).toBe("SCHEDULED");
    const waiting = await waitForRun(client, run.id, "WAITING_APPROVAL");
    expect(waiting.sessionId).toBe(session.id);
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("before\n");
    const pending = await client.listPendingApprovals(run.id);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.runId).toBe(run.id);

    const resolved = await client.resolveApproval(run.id, pending.items[0]!.id, {
      action: "APPROVE",
      scope: "ONCE",
    });
    expect(resolved.disposition).toBe("SCHEDULED");
    const completed = await waitForRun(client, run.id, "COMPLETED");
    expect(completed.id).toBe(run.id);
    expect(provider.calls).toBe(3);
    expect(provider.patchCalls).toBe(1);
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("after\n");

    const events = await collectUntil(client, run.id, "run.completed");
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.resolved",
        "file.modified",
        "verification.planned",
        "verification.finalized",
        "run.completed",
      ]),
    );
    expect(eventTypes.filter((type) => type === "approval.requested")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "approval.resolved")).toHaveLength(1);
  }, 20_000);

  it("persists cancellation, propagates AbortSignal, and discards late provider output", async () => {
    const workspacePath = await makeWorkspace("caelush-cancel-e2e-", "unchanged\n");
    const provider = new BlockingProvider();
    const databasePath = join(workspacePath, "caelush.db");
    daemon = await startFixtureDaemon(workspacePath, provider);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createFixtureRun(client, workspacePath);

    expect((await client.startRun(run.id)).disposition).toBe("SCHEDULED");
    await provider.entered.promise;
    const cancelled = await client.cancelRun(run.id);
    expect(cancelled.disposition).toBe("SETTLED");
    expect(cancelled.run.status).toBe("CANCELLED");
    await provider.aborted.promise;
    const events = await collectUntil(client, run.id, "run.cancelled");
    expect(events.map((event) => event.type)).toContain("run.cancelled");
    expect(events.map((event) => event.type)).not.toContain("run.completed");

    await daemon.close();
    daemon = undefined;
    const storage = await openCaelushStorage({ path: databasePath });
    try {
      const snapshot = await storage.execution.load(run.id);
      expect(snapshot?.cancellationIntent).toMatchObject({
        runId: run.id,
        cause: "USER_REQUESTED",
      });
      expect((await storage.runs.get(run.id))?.status).toBe("CANCELLED");
    } finally {
      await storage.close();
    }
  }, 20_000);

  it("gracefully closes by cancelling active work before closing the SQLite lifecycle", async () => {
    const workspacePath = await makeWorkspace("caelush-shutdown-e2e-", "unchanged\n");
    const databasePath = join(workspacePath, "caelush.db");
    const provider = new BlockingProvider();
    daemon = await startFixtureDaemon(workspacePath, provider);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createFixtureRun(client, workspacePath);

    await client.startRun(run.id);
    await provider.entered.promise;
    await daemon.close();
    daemon = undefined;
    await provider.aborted.promise;

    const storage = await openCaelushStorage({ path: databasePath });
    try {
      expect((await storage.runs.get(run.id))?.status).toBe("CANCELLED");
    } finally {
      await storage.close();
    }
  }, 20_000);

  it("closes and reopens SQLite, then recovers the same Run without duplicate verification", async () => {
    const workspacePath = await makeWorkspace("caelush-recover-e2e-", "unchanged\n");
    const databasePath = join(workspacePath, "caelush.db");
    const firstProvider = new RetryProvider(true);
    daemon = await startFixtureDaemon(workspacePath, firstProvider);
    const firstClient = new CaelushClient({ baseUrl: daemon.url });
    const { session, run } = await createFixtureRun(firstClient, workspacePath);
    expect((await firstClient.startRun(run.id)).disposition).toBe("SCHEDULED");
    await firstProvider.firstFailed.promise;
    await waitForRetryBoundary(databasePath, run.id);
    expect((await firstClient.getRun(run.id)).status).toBe("RUNNING");

    await daemon.close();
    daemon = undefined;

    const secondProvider = new RetryProvider(false);
    daemon = await startFixtureDaemon(workspacePath, secondProvider);
    const secondClient = new CaelushClient({ baseUrl: daemon.url });
    const recovered = await secondClient.recoverRun(run.id);
    expect(recovered.run.id).toBe(run.id);
    expect(recovered.run.sessionId).toBe(session.id);
    const completed = await waitForRun(secondClient, run.id, "COMPLETED");
    expect(completed.id).toBe(run.id);
    expect({ calls: secondProvider.calls, disposition: recovered.disposition }).toEqual({
      calls: 2,
      disposition: "SCHEDULED",
    });

    const events = await collectUntil(secondClient, run.id, "run.completed");
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.filter((type) => type === "verification.planned")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "run.completed")).toHaveLength(1);
    expect((await secondClient.getRun(run.id)).sessionId).toBe(session.id);
  }, 20_000);
});

async function makeWorkspace(prefix: string, contents: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  directory = workspacePath;
  await mkdir(join(workspacePath, "src"));
  await writeFile(join(workspacePath, "README.md"), contents, "utf8");
  return workspacePath;
}

async function startFixtureDaemon(
  workspacePath: string,
  fixture: ApiAdapter,
): Promise<{ close(): Promise<void>; url: string }> {
  return startDaemon({
    databasePath: join(workspacePath, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [fixtureBinding()],
    modelSources: [fixtureModelSource()],
    adapterOverrides: [fixture],
    defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    logger: false,
  });
}

async function createFixtureRun(
  client: CaelushClient,
  workspacePath: string,
  approvalPolicy: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK" = "NEVER_ASK",
) {
  const session = await client.createSession({
    defaultWorkspace: { id: createWorkspaceId(), path: workspacePath },
    defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
  });
  const run = await client.createRun(session.id, {
    goal: "complete the fixture task",
    workspace: { id: createWorkspaceId(), path: workspacePath },
    model: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy,
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  });
  return { session, run };
}

async function waitForRun(
  client: CaelushClient,
  runId: Parameters<CaelushClient["getRun"]>[0],
  expected: string,
) {
  let run = await client.getRun(runId);
  for (let attempt = 0; attempt < 200 && run.status !== expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    run = await client.getRun(runId);
  }
  expect(run.status).toBe(expected);
  return run;
}

async function collectUntil(
  client: CaelushClient,
  runId: Parameters<CaelushClient["getRun"]>[0],
  target: AgentEvent["type"],
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of client.watchRunEvents(runId, { afterSequence: 0 })) {
    events.push(event);
    if (event.type === target) break;
  }
  return events;
}

async function waitForRetryBoundary(
  databasePath: string,
  runId: Parameters<CaelushClient["getRun"]>[0],
) {
  const storage = await openCaelushStorage({ path: databasePath });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = await storage.execution.load(runId);
      if (snapshot?.continuation?.type === "WAITING_RETRY") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await storage.close();
  }
  throw new Error("The retry continuation was not durably persisted.");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
