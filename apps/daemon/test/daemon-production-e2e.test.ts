import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type AgentEvent } from "@caelush/protocol";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { afterEach, describe, expect, it } from "vitest";
import { CaelushClient } from "@caelush/client";
import { openCaelushStorage } from "@caelush/storage";
import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  daemon = undefined;
});

class FixtureProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly entered = deferred<void>();
  readonly release = deferred<void>();
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    const isReview = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    if (isReview) {
      return this.events(
        JSON.stringify({ verdict: "PASS", summary: "The task candidate is acceptable." }),
      );
    }
    if (this.calls === 1) return this.firstToolCall();
    if (this.calls === 2) return this.secondToolCall();
    return this.events("The requested task is complete.");
  }

  private async *firstToolCall(): AsyncGenerator<AIAdapterEvent> {
    this.entered.resolve();
    await this.release.promise;
    yield { type: "tool_call.start", payload: { toolCallId: "read_call", toolName: "read_file" } };
    yield {
      type: "tool_call.completed",
      payload: { id: "read_call", name: "read_file", input: { path: "src/message.txt" } },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *secondToolCall(): AsyncGenerator<AIAdapterEvent> {
    yield {
      type: "tool_call.start",
      payload: { toolCallId: "patch_call", toolName: "apply_patch" },
    };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "patch_call",
        name: "apply_patch",
        input: {
          patch:
            "*** Begin Patch\n*** Update File: src/message.txt\n@@\n-before\n+after\n*** End Patch",
        },
      },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *events(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("daemon production composition E2E", () => {
  it("executes tools, verification, completion, and durable SSE replay through the client", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "caelush-production-e2e-"));
    directory = workspacePath;
    await mkdir(join(workspacePath, "src"));
    const payload = Array.from(
      { length: 300 },
      (_, index) => `${index}-` + "payload-".repeat(300),
    ).join("\n");
    await writeFile(join(workspacePath, "src", "message.txt"), `before\n${payload}`, "utf8");
    const provider = new FixtureProvider();
    const handle = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    daemon = handle;
    const client = new CaelushClient({ baseUrl: handle.url });

    await expect(client.getInfo()).resolves.toMatchObject({
      configuredProviders: ["fixture"],
      defaultModel: { provider: "fixture", model: "fixture-model" },
      defaultRunConfiguration: {
        runtime: { id: "local", kind: "local" },
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
        resourcePolicy: {
          mode: "ADAPTIVE",
          operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
          batch: { maxToolCallsPerTurn: 16 },
          progress: {
            windowTurns: 8,
            identicalCallNudgeThreshold: 3,
            noProgressTurnsBeforeReplan: 4,
            replansBeforePause: 2,
          },
          hardLimits: {},
          inactivity: {},
        },
      },
    });
    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: workspacePath },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const run = await client.createRun(session.id, {
      goal: "report the clean fixture workspace",
      workspace: { id: createWorkspaceId(), path: workspacePath },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    });

    const subscriptionReady = deferred<void>();
    const events: AgentEvent[] = [];
    const eventClient = new CaelushClient({
      baseUrl: handle.url,
      fetch: async (input, init) => {
        if (String(input).includes(`/runs/${run.id}/events`)) subscriptionReady.resolve();
        return fetch(input, init);
      },
    });
    const liveEvents = (async () => {
      for await (const event of eventClient.watchRunEvents(run.id, { afterSequence: 0 })) {
        events.push(event);
        if (event.type === "run.completed") break;
      }
    })();
    await subscriptionReady.promise;
    const started = await client.startRun(run.id);
    expect(started.disposition).toBe("SCHEDULED");
    expect(started.run.status).toBe("PENDING");
    await provider.entered.promise;
    expect((await client.getRun(run.id)).status).not.toBe("COMPLETED");
    provider.release.resolve();

    let settled = await client.getRun(run.id);
    for (let attempt = 0; attempt < 80 && !isTerminal(settled.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await client.getRun(run.id);
    }
    expect(settled.status).toBe("COMPLETED");
    await liveEvents;
    expect(await readFile(join(workspacePath, "src", "message.txt"), "utf8")).toBe(
      `after\n${payload}`,
    );
    expect(provider.calls).toBe(4);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.started",
        "llm.started",
        "tool.started",
        "tool.completed",
        "file.read",
        "file.modified",
        "verification.planned",
        "verification.check.started",
        "verification.check.completed",
        "verification.finalized",
        "run.completed",
      ]),
    );
    expect(settled.finalResult).toMatchObject({ type: "VERIFIED_COMPLETION" });
    const usage = await client.getRunContextUsage(run.id);
    expect(usage).not.toBeNull();
    expect(usage).toMatchObject({
      rawContextWindowTokens: expect.any(Number),
      effectiveInputLimitTokens: expect.any(Number),
      estimatedInputTokens: expect.any(Number),
      lastBuildAt: expect.any(Number),
      lastRecoveryStages: expect.any(Array),
      lastBuildStatus: "SUCCESS",
    });

    const durableEvents = events.filter(
      (event): event is Extract<AgentEvent, { durability: { kind: "DURABLE" } }> =>
        event.durability.kind === "DURABLE",
    );
    const middle = durableEvents[Math.floor(durableEvents.length / 2)]?.durability.sequence ?? 0;
    const replayed: AgentEvent[] = [];
    for await (const event of client.watchRunEvents(run.id, { afterSequence: middle })) {
      replayed.push(event);
      if (
        replayed.length === durableEvents.filter((item) => item.durability.sequence > middle).length
      )
        break;
    }
    expect(replayed.every((event) => event.durability.kind === "DURABLE")).toBe(true);
    expect(
      replayed.map((event) =>
        event.durability.kind === "DURABLE" ? event.durability.sequence : -1,
      ),
    ).toEqual(
      durableEvents
        .filter((event) => event.durability.sequence > middle)
        .map((event) => (event.durability.kind === "DURABLE" ? event.durability.sequence : -1)),
    );

    await daemon.close();
    daemon = undefined;
    const persistedStorage = await openCaelushStorage({
      path: join(workspacePath, "caelush.db"),
    });
    try {
      const invocation = (await persistedStorage.toolInvocations.listByRun(run.id)).find(
        (item) => item.toolName === "read_file",
      );
      expect(invocation).toBeDefined();
      const observation =
        invocation === undefined
          ? undefined
          : await persistedStorage.observations.findByToolInvocation(invocation.id);
      expect(observation?.rawArtifactRef).toBeTruthy();
      const artifact =
        observation?.rawArtifactRef === undefined
          ? undefined
          : await persistedStorage.contextArtifacts.readInternal(observation.rawArtifactRef);
      expect(artifact?.content).toContain("2: 0-payload-");
      expect(artifact?.content.length).toBeGreaterThan(10_000);
      const modelToolMessage = (await persistedStorage.messages.listByRun(run.id)).find(
        (entry) => entry.message.role === "tool",
      );
      if (modelToolMessage?.message.role !== "tool") throw new Error("model tool message missing");
      expect(modelToolMessage.message.content.length).toBeLessThan(artifact?.content.length ?? 0);
    } finally {
      await persistedStorage.close();
    }
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
