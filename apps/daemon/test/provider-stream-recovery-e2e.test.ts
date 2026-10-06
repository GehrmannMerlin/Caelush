import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type AgentEvent, type PublicRunEvent } from "@caelush/protocol";
import { CaelushClient } from "@caelush/client";
import type { AIProviderBinding, ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import { openCaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  finishOpenAISse,
  sendOpenAIText,
  sendRateLimit,
  writeOpenAIChunk,
  type ControllableProviderServer,
} from "./support/controllable-provider-server.js";
import { restrictedProvider } from "./support/permission-flow-fixture.js";

const PROVIDER_ID = "stream-fixture";
const MODEL_ID = "stream-fixture-model";
const OPENAI_API = "openai-compatible-chat";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;
let provider: ControllableProviderServer | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  await provider?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  provider = undefined;
  directory = undefined;
});

describe("Provider stream recovery daemon E2E", () => {
  it("nudges on silence, aborts the real HTTP stream, durably retries, and drops partial text/Tool calls", async () => {
    const workspacePath = await makeWorkspace("caelush-stream-idle-e2e-");
    let taskRequests = 0;
    provider = await createControllableProviderServer(async (request, response) => {
      if (isReviewRequest(request.body)) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
        return;
      }
      taskRequests += 1;
      if (taskRequests === 1) {
        beginOpenAISse(response);
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: { content: "PARTIAL_PROVIDER_TEXT_SENTINEL" },
        });
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "partial-tool-call",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"src/' },
              },
            ],
          },
        });
        return;
      }
      sendOpenAIText(response, "The request recovered and completed.");
    });
    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint, {
      nudgeAfterMs: 40,
      idleTimeoutMs: 180,
      teardownGraceMs: 40,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { session, run } = await createRun(client, workspacePath);
    const events = await observeRunEvents(client, run.id, async () => {
      await client.startRun(run.id);
    });
    const settled = await waitForRun(client, run.id);
    expect(settled.status).toBe("COMPLETED");
    expect(provider.requests[0]?.closedBeforeResponseEnded).toBe(true);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "model.status",
        "llm.failed",
        "retry.scheduled",
        "retry.started",
        "run.completed",
      ]),
    );
    const modelPhases = events
      .filter((event) => event.type === "model.status")
      .map((event) => (event.payload as { readonly phase: string }).phase);
    expect(modelPhases).toEqual(
      expect.arrayContaining(["NO_RECENT_ACTIVITY", "CANCELLING_IDLE_STREAM"]),
    );
    expect(events.some((event) => event.type === "tool.requested")).toBe(false);
    const transcript = await client.getSessionTranscript(session.id);
    expect(JSON.stringify(transcript)).not.toContain("PARTIAL_PROVIDER_TEXT_SENTINEL");
    expect(JSON.stringify(transcript)).toContain("The request recovered and completed.");
    expect(JSON.stringify(provider.requests[1]?.body)).not.toContain(
      "PARTIAL_PROVIDER_TEXT_SENTINEL",
    );
  }, 15_000);

  it("honors Retry-After without retrying early", async () => {
    const workspacePath = await makeWorkspace("caelush-stream-retry-after-e2e-");
    let taskRequests = 0;
    provider = await createControllableProviderServer((request, response) => {
      if (isReviewRequest(request.body)) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
        return;
      }
      taskRequests += 1;
      if (taskRequests === 1) sendRateLimit(response, "0.25");
      else sendOpenAIText(response, "Recovered after Provider Retry-After.");
    });
    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);
    const events = await observeRunEvents(client, run.id, async () => {
      await client.startRun(run.id);
    });
    const settled = await waitForRun(client, run.id);
    expect(
      settled.status,
      JSON.stringify({
        paths: provider.requests.map((request) => request.path),
        events: events.map((event) => event.type),
      }),
    ).toBe("COMPLETED");
    const scheduled = events.find((event) => event.type === "retry.scheduled");
    expect(scheduled?.payload).toMatchObject({ delayMs: 250, attempt: 2, maxAttempts: 6 });
    const first = provider.requests[0];
    const second = provider.requests[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.receivedAt - first!.receivedAt).toBeGreaterThanOrEqual(225);
  }, 15_000);

  it("honors the HTTP-date Retry-After form", async () => {
    const workspacePath = await makeWorkspace("caelush-stream-retry-after-date-e2e-");
    let taskRequests = 0;
    provider = await createControllableProviderServer((request, response) => {
      if (isReviewRequest(request.body)) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
        return;
      }
      taskRequests += 1;
      if (taskRequests === 1) {
        sendRateLimit(response, new Date(Date.now() + 1_500).toUTCString());
      } else {
        sendOpenAIText(response, "Recovered after HTTP-date Retry-After.");
      }
    });
    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);
    const events = await observeRunEvents(client, run.id, async () => {
      await client.startRun(run.id);
    });
    expect((await waitForRun(client, run.id)).status).toBe("COMPLETED");
    const scheduled = events.find((event) => event.type === "retry.scheduled");
    const delayMs = (scheduled?.payload as { readonly delayMs?: number } | undefined)?.delayMs;
    expect(delayMs).toBeGreaterThan(0);
    const first = provider.requests[0];
    const second = provider.requests[1];
    expect(second!.receivedAt - first!.receivedAt).toBeGreaterThanOrEqual(delayMs! - 50);
  }, 15_000);

  it("recovers a real loopback network reset on one later durable attempt", async () => {
    const workspacePath = await makeWorkspace("caelush-stream-network-reset-e2e-");
    let taskRequests = 0;
    provider = await createControllableProviderServer((request, response) => {
      if (isReviewRequest(request.body)) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
        return;
      }
      taskRequests += 1;
      if (taskRequests === 1) response.destroy();
      else sendOpenAIText(response, "Recovered after the loopback network reset.");
    });
    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);
    const events = await observeRunEvents(client, run.id, async () => {
      await client.startRun(run.id);
    });
    expect((await waitForRun(client, run.id)).status).toBe("COMPLETED");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["llm.failed", "retry.scheduled", "retry.started", "run.completed"]),
    );
    expect(events.find((event) => event.type === "retry.scheduled")?.payload).toMatchObject({
      errorCode: "LLM_NETWORK",
      attempt: 2,
      maxAttempts: 6,
    });
    expect(provider.requests).toHaveLength(3);
    const firstMessages = requestMessages(provider.requests[0]?.body);
    const retriedMessages = requestMessages(provider.requests[1]?.body);
    expect(isMessagePrefix(firstMessages, retriedMessages)).toBe(true);

    const storage = await openCaelushStorage({ path: join(workspacePath, "caelush.db") });
    try {
      const currentEpoch = await storage.promptSurface.getCurrent(run.id);
      expect(currentEpoch).toBeDefined();
      const surface =
        currentEpoch === undefined
          ? undefined
          : await storage.promptSurface.readEpoch(run.id, currentEpoch.epochId);
      const snapshots = surface?.snapshots ?? [];
      expect(snapshots.length).toBeGreaterThan(0);
      expect(new Set(snapshots.map((snapshot) => snapshot.sourceStepSequence)).size).toBe(
        snapshots.length,
      );
      expect(snapshots.every((snapshot, index) => snapshot.ordinal === index + 1)).toBe(true);
    } finally {
      await storage.close();
    }
  }, 15_000);

  it("switches only to a preconfigured equivalent transport on the next durable attempt", async () => {
    const workspacePath = await makeWorkspace("caelush-stream-fallback-e2e-");
    provider = await createControllableProviderServer((request, response) => {
      if (isReviewRequest(request.body)) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
      } else if (request.path.startsWith("/primary/")) {
        sendRateLimit(response, "2");
      } else {
        sendOpenAIText(response, "The equivalent secondary transport recovered.");
      }
    });
    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint, undefined, true);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);
    await client.startRun(run.id);
    const events: AgentEvent[] = [];
    for await (const event of client.watchRunEvents(run.id, { afterSequence: 0 })) {
      events.push(event as AgentEvent);
      if (event.type === "retry.scheduled") {
        const storage = await openCaelushStorage({ path: join(workspacePath, "caelush.db") });
        try {
          expect((await storage.execution.load(run.id))?.continuation).toMatchObject({
            type: "WAITING_RETRY",
            transport: {
              currentTransportId: "secondary",
              attemptedTransportIds: ["default", "secondary"],
            },
          });
        } finally {
          await storage.close();
        }
      }
      if (event.type === "run.completed" || event.type === "run.failed") break;
    }
    const settled = await waitForRun(client, run.id);
    expect(
      settled.status,
      JSON.stringify({
        paths: provider.requests.map((request) => request.path),
        events: events.map((event) => event.type),
      }),
    ).toBe("COMPLETED");
    expect(provider.requests[0]?.path).toContain("/primary/v1/chat/completions");
    expect(provider.requests[1]?.path).toContain("/secondary/v1/chat/completions");
    const fallback = events.find((event) => event.type === "transport.fallback.selected");
    expect(fallback?.payload).toMatchObject({
      fromTransportId: "default",
      toTransportId: "secondary",
    });
    const fallbackIndex = events.findIndex((event) => event.type === "transport.fallback.selected");
    const retryStartedIndex = events.findIndex((event) => event.type === "retry.started");
    expect(fallbackIndex).toBeGreaterThanOrEqual(0);
    expect(retryStartedIndex).toBeGreaterThan(fallbackIndex);
    expect(JSON.stringify(events)).not.toMatch(/https?:\/\//u);
  }, 15_000);

  it("does not cancel a Run when its Web SSE observer disconnects", async () => {
    const workspacePath = await makeWorkspace("caelush-stream-sse-disconnect-e2e-");
    const responseGate = deferred<void>();
    provider = await createControllableProviderServer(async (request, response) => {
      if (isReviewRequest(request.body)) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
        return;
      }
      beginOpenAISse(response);
      await responseGate.promise;
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: { content: "The model Run outlived the disconnected Web observer." },
      });
      finishOpenAISse(response);
    });
    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint, {
      nudgeAfterMs: 2_000,
      idleTimeoutMs: 5_000,
      teardownGraceMs: 100,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);
    const abort = new AbortController();
    const opened = deferred<void>();
    const eventReader = (async () => {
      for await (const _event of client.watchRunEvents(run.id, {
        signal: abort.signal,
        onOpen: () => opened.resolve(),
      })) {
        // The observation is intentionally discarded after it proves the SSE connection is live.
        void _event;
      }
    })();
    await opened.promise;
    await client.startRun(run.id);
    await provider.waitForRequest(0);
    abort.abort();
    await eventReader;
    expect(provider.requests[0]?.closedBeforeResponseEnded).toBe(false);
    responseGate.resolve();
    expect((await waitForRun(client, run.id)).status).toBe("COMPLETED");
  }, 15_000);

  it("recovers a persisted WAITING_RETRY after a daemon restart", async () => {
    const workspacePath = await makeWorkspace("caelush-stream-restart-e2e-");
    const databasePath = join(workspacePath, "caelush.db");
    let taskRequests = 0;
    provider = await createControllableProviderServer((request, response) => {
      if (isReviewRequest(request.body)) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
        return;
      }
      taskRequests += 1;
      if (taskRequests === 1) sendRateLimit(response, "3");
      else sendOpenAIText(response, "Recovered from persisted retry after restart.");
    });
    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);
    const eventAbort = new AbortController();
    const scheduledEvent = deferred<PublicRunEvent>();
    const eventReader = (async () => {
      for await (const event of client.watchRunEvents(run.id, { signal: eventAbort.signal })) {
        if (event.type === "retry.scheduled") scheduledEvent.resolve(event);
      }
    })();
    await client.startRun(run.id);
    const schedule = await scheduledEvent.promise;
    await waitForRetryBoundary(databasePath, run.id);
    eventAbort.abort();
    await eventReader;
    await daemon.close();
    daemon = undefined;

    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint);
    const resumedClient = new CaelushClient({ baseUrl: daemon.url });
    const events = await observeExistingRunEvents(
      resumedClient,
      run.id,
      schedule.durability.kind === "DURABLE" ? schedule.durability.sequence : 0,
    );
    expect((await waitForRun(resumedClient, run.id)).status).toBe("COMPLETED");
    expect(events.filter((event) => event.type === "retry.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
  }, 20_000);

  it("exhausts exactly five retries and exposes an explicit terminal failure", async () => {
    const workspacePath = await makeWorkspace("caelush-stream-exhaust-e2e-");
    provider = await createControllableProviderServer((request, response) => {
      if (isReviewRequest(request.body)) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
        return;
      }
      sendRateLimit(response, "0");
    });
    daemon = await startRecoveryDaemon(workspacePath, provider.endpoint);
    const client = new CaelushClient({ baseUrl: daemon.url });
    const { run } = await createRun(client, workspacePath);
    const events = await observeRunEvents(
      client,
      run.id,
      async () => {
        await client.startRun(run.id);
      },
      "run.failed",
    );
    const failedRun = await waitForRun(client, run.id);

    expect(failedRun.status).toBe("FAILED");
    expect(provider.requests).toHaveLength(6);
    expect(events.filter((event) => event.type === "retry.started")).toHaveLength(5);
    expect(events.filter((event) => event.type === "retry.scheduled")).toHaveLength(5);
    expect(events.find((event) => event.type === "retry.exhausted")?.payload).toMatchObject({
      attempt: 6,
      maxAttempts: 6,
      retriesUsed: 5,
      maxRetries: 5,
      reason: "ATTEMPTS_EXHAUSTED",
    });
  }, 20_000);
});

async function startRecoveryDaemon(
  workspacePath: string,
  endpoint: string,
  streamPolicy?: {
    readonly nudgeAfterMs: number;
    readonly idleTimeoutMs: number;
    readonly teardownGraceMs: number;
  },
  withSecondary = false,
) {
  const binding: AIProviderBinding = {
    id: PROVIDER_ID,
    endpoint: `${endpoint}/primary/v1`,
    defaultApi: OPENAI_API,
    allowUnknownModels: true,
    credentials: { resolve: async () => ({ apiKey: "fixture-only-key" }) },
    rateLimitDomain: "primary-domain",
    ...(withSecondary
      ? {
          transportCandidates: [
            {
              id: "secondary",
              endpoint: `${endpoint}/secondary/v1`,
              api: OPENAI_API,
              rateLimitDomain: "secondary-domain",
            },
          ],
        }
      : {}),
  };
  const modelSource: ModelDescriptorSourcePort = {
    id: "stream-recovery-e2e",
    priority: 0,
    resolve: ({ provider, model }) =>
      provider === PROVIDER_ID && model === MODEL_ID ? fixtureDescriptor() : undefined,
  };
  return startDaemon({
    databasePath: join(workspacePath, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [binding],
    modelSources: [modelSource],
    defaultModel: { provider: PROVIDER_ID, model: MODEL_ID },
    processSandboxProviders: [restrictedProvider],
    ...(streamPolicy === undefined ? {} : { providerStreamPolicy: streamPolicy }),
    logger: false,
  });
}

function fixtureDescriptor(): ModelDescriptor {
  return {
    ref: { provider: PROVIDER_ID, model: MODEL_ID },
    api: OPENAI_API,
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    source: "CONFIGURATION",
  };
}

async function makeWorkspace(prefix: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  directory = workspacePath;
  await mkdir(join(workspacePath, "src"));
  await writeFile(join(workspacePath, "README.md"), "provider stream fixture\n", "utf8");
  return workspacePath;
}

async function createRun(client: CaelushClient, workspacePath: string) {
  const workspace = { id: createWorkspaceId(), path: workspacePath };
  const session = await client.createSession({
    defaultWorkspace: workspace,
    defaultModel: { provider: PROVIDER_ID, model: MODEL_ID },
  });
  const run = await client.createRun(session.id, {
    goal: "inspect the provider stream recovery fixture",
    workspace: session.defaultWorkspace ?? workspace,
    model: { provider: PROVIDER_ID, model: MODEL_ID },
    runtime: { id: "local", kind: "local" },
    preset: { id: "FULL_ACCESS", expectedVersion: 1 },
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 30_000 },
  });
  return { session, run };
}

async function observeRunEvents(
  client: CaelushClient,
  runId: Parameters<CaelushClient["getRun"]>[0],
  start: () => Promise<unknown>,
  terminal: AgentEvent["type"] = "run.completed",
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const connected = deferred<void>();
  const reader = (async () => {
    for await (const event of client.watchRunEvents(runId, { onOpen: () => connected.resolve() })) {
      events.push(event as AgentEvent);
      if (event.type === terminal || event.type === "run.completed" || event.type === "run.failed")
        break;
    }
  })();
  await connected.promise;
  await start();
  await reader;
  return events;
}

async function observeExistingRunEvents(
  client: CaelushClient,
  runId: Parameters<CaelushClient["getRun"]>[0],
  afterSequence: number,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of client.watchRunEvents(runId, { afterSequence })) {
    events.push(event as AgentEvent);
    if (event.type === "run.completed" || event.type === "run.failed") break;
  }
  return events;
}

async function waitForRun(client: CaelushClient, runId: Parameters<CaelushClient["getRun"]>[0]) {
  let run = await client.getRun(runId);
  for (let attempt = 0; attempt < 400 && !isTerminal(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    run = await client.getRun(runId);
  }
  return run;
}

async function waitForRetryBoundary(
  databasePath: string,
  runId: Parameters<CaelushClient["getRun"]>[0],
) {
  const storage = await openCaelushStorage({ path: databasePath });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await storage.execution.load(runId))?.continuation?.type === "WAITING_RETRY") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await storage.close();
  }
  throw new Error("The provider retry continuation was not durably persisted.");
}

function isReviewRequest(body: Readonly<Record<string, unknown>>): boolean {
  return JSON.stringify(body).includes("Review the supplied");
}

function requestMessages(body: Readonly<Record<string, unknown>> | undefined): readonly unknown[] {
  const messages = body?.messages;
  if (!Array.isArray(messages)) throw new Error("The controlled model request had no messages.");
  return messages;
}

function isMessagePrefix(prefix: readonly unknown[], candidate: readonly unknown[]): boolean {
  return (
    candidate.length >= prefix.length &&
    JSON.stringify(candidate.slice(0, prefix.length)) === JSON.stringify(prefix)
  );
}

function isTerminal(status: string): boolean {
  return ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "BUDGET_EXCEEDED"].includes(status);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
