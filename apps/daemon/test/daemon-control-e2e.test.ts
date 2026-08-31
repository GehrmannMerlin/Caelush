import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type AgentEvent, type ModelRef } from "@caelush/protocol";
import {
  LLMAbortedError,
  LLMNetworkError,
  type LLMCapabilities,
  type LLMProvider,
  type LLMProviderCallContext,
  type LLMProviderRequest,
  type LLMStreamEvent,
  type ProviderId,
} from "@caelush/llm";
import { openCaelushStorage } from "@caelush/storage";
import { CaelushClient } from "@caelush/client";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";

const capabilities: LLMCapabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "SUPPORTED",
  structuredOutput: "SUPPORTED",
  vision: "UNSUPPORTED",
  reasoningSummary: "UNSUPPORTED",
};

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  daemon = undefined;
});

class ApprovalProvider implements LLMProvider {
  readonly id = "approval-fixture" as ProviderId;
  calls = 0;
  patchCalls = 0;

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "approval-model";
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.calls += 1;
    const isReview = request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    if (isReview) {
      return this.text(
        request,
        context,
        JSON.stringify({ verdict: "PASS", summary: "The approved task is acceptable." }),
      );
    }
    if (this.calls === 1) {
      this.patchCalls += 1;
      return this.toolCall(request, context);
    }
    return this.text(request, context, "The approved change is complete.");
  }

  private async *toolCall(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    yield streamStart(this.id, request, context);
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
    yield { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *text(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
    text: string,
  ): AsyncIterable<LLMStreamEvent> {
    yield streamStart(this.id, request, context);
    yield { type: "text.delta", payload: { text } };
    yield { type: "stream.finish", payload: { finishReason: "STOP" } };
  }
}

class BlockingProvider implements LLMProvider {
  readonly id = "cancel-fixture" as ProviderId;
  readonly entered = deferred<void>();
  readonly aborted = deferred<void>();

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "cancel-model";
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    return this.block(request, context);
  }

  private async *block(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.entered.resolve();
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) {
        resolve();
        return;
      }
      context.signal.addEventListener(
        "abort",
        () => {
          this.aborted.resolve();
          resolve();
        },
        { once: true },
      );
    });
    if (context.signal.aborted) throw new LLMAbortedError();
    yield streamStart(this.id, request, context);
  }
}

class RetryProvider implements LLMProvider {
  readonly id = "retry-fixture" as ProviderId;
  readonly firstFailed = deferred<void>();
  calls = 0;

  constructor(private readonly failFirst: boolean) {}

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "retry-model";
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.calls += 1;
    if (this.failFirst && this.calls === 1) return this.failNetwork();
    if (
      request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.text(request, context, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
    }
    return this.text(request, context);
  }

  private async *failNetwork(): AsyncIterable<LLMStreamEvent> {
    this.firstFailed.resolve();
    yield* [];
    throw new LLMNetworkError(undefined, { retryAfterMs: 2_500 });
  }

  private async *text(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
    text = "Recovered and completed.",
  ): AsyncIterable<LLMStreamEvent> {
    yield streamStart(this.id, request, context);
    yield { type: "text.delta", payload: { text } };
    yield { type: "stream.finish", payload: { finishReason: "STOP" } };
  }
}

describe("production daemon control-plane E2E", () => {
  it("waits for approval, resolves through HTTP, resumes the exact Tool, and completes", async () => {
    const workspacePath = await makeWorkspace("caelush-approval-e2e-", "before\n");
    const provider = new ApprovalProvider();
    daemon = await startFixtureDaemon(
      workspacePath,
      "approval-fixture",
      "approval-model",
      provider,
    );
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { session, run } = await createFixtureRun(
      client,
      workspacePath,
      "approval-fixture",
      "approval-model",
      "DANGEROUS_ONLY",
    );

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
    daemon = await startFixtureDaemon(workspacePath, "cancel-fixture", "cancel-model", provider);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createFixtureRun(client, workspacePath, "cancel-fixture", "cancel-model");

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
    daemon = await startFixtureDaemon(workspacePath, "cancel-fixture", "cancel-model", provider);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createFixtureRun(client, workspacePath, "cancel-fixture", "cancel-model");

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
    daemon = await startFixtureDaemon(workspacePath, "retry-fixture", "retry-model", firstProvider);
    const firstClient = new CaelushClient({ baseUrl: daemon.url });
    const { session, run } = await createFixtureRun(
      firstClient,
      workspacePath,
      "retry-fixture",
      "retry-model",
    );
    expect((await firstClient.startRun(run.id)).disposition).toBe("SCHEDULED");
    await firstProvider.firstFailed.promise;
    await waitForRetryBoundary(databasePath, run.id);
    expect((await firstClient.getRun(run.id)).status).toBe("RUNNING");

    await daemon.close();
    daemon = undefined;

    const secondProvider = new RetryProvider(false);
    daemon = await startFixtureDaemon(
      workspacePath,
      "retry-fixture",
      "retry-model",
      secondProvider,
    );
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

function streamStart(
  providerId: ProviderId,
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
): LLMStreamEvent {
  return {
    type: "stream.start",
    payload: { callId: context.callId, providerId, model: request.model },
  };
}

async function makeWorkspace(prefix: string, contents: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  directory = workspacePath;
  await mkdir(join(workspacePath, "src"));
  await writeFile(join(workspacePath, "README.md"), contents, "utf8");
  return workspacePath;
}

async function startFixtureDaemon(
  workspacePath: string,
  provider: string,
  model: string,
  fixture: LLMProvider,
): Promise<{ close(): Promise<void>; url: string }> {
  return startDaemon({
    databasePath: join(workspacePath, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerOverrides: [fixture],
    defaultModel: { provider, model },
    logger: false,
  });
}

async function createFixtureRun(
  client: CaelushClient,
  workspacePath: string,
  provider: string,
  model: string,
  approvalPolicy: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK" = "NEVER_ASK",
) {
  const session = await client.createSession({
    defaultWorkspace: { id: createWorkspaceId(), path: workspacePath },
    defaultModel: { provider, model },
  });
  const run = await client.createRun(session.id, {
    goal: "complete the fixture task",
    workspace: { id: createWorkspaceId(), path: workspacePath },
    model: { provider, model },
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
