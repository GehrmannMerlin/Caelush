import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type AgentEvent, type ModelRef } from "@caelush/protocol";
import {
  type LLMCapabilities,
  type LLMProvider,
  type LLMProviderCallContext,
  type LLMProviderRequest,
  type LLMStreamEvent,
  type ProviderId,
} from "@caelush/llm";
import { afterEach, describe, expect, it } from "vitest";
import { CaelushClient } from "@caelush/client";
import { startDaemon } from "../src/index.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  daemon = undefined;
});

const capabilities: LLMCapabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "SUPPORTED",
  structuredOutput: "SUPPORTED",
  vision: "UNSUPPORTED",
  reasoningSummary: "UNSUPPORTED",
};

class FixtureProvider implements LLMProvider {
  readonly id = "fixture" as ProviderId;
  readonly entered = deferred<void>();
  readonly release = deferred<void>();
  calls = 0;

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "fixture-model";
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
      return this.events(
        request,
        context,
        JSON.stringify({ verdict: "PASS", summary: "The task candidate is acceptable." }),
      );
    }
    if (this.calls === 1) return this.firstToolCall(request, context);
    if (this.calls === 2) return this.secondToolCall(request, context);
    return this.events(request, context, "The requested task is complete.");
  }

  private async *firstToolCall(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.entered.resolve();
    await this.release.promise;
    yield {
      type: "stream.start",
      payload: { callId: context.callId, providerId: this.id, model: request.model },
    };
    yield { type: "tool_call.start", payload: { toolCallId: "read_call", toolName: "read_file" } };
    yield {
      type: "tool_call.completed",
      payload: { id: "read_call", name: "read_file", input: { path: "src/message.txt" } },
    };
    yield { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *secondToolCall(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    yield {
      type: "stream.start",
      payload: { callId: context.callId, providerId: this.id, model: request.model },
    };
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
    yield { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } };
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

describe("daemon production composition E2E", () => {
  it("executes tools, verification, completion, and durable SSE replay through the client", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "caelush-production-e2e-"));
    directory = workspacePath;
    await mkdir(join(workspacePath, "src"));
    await writeFile(join(workspacePath, "src", "message.txt"), "before\n", "utf8");
    const provider = new FixtureProvider();
    const handle = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [provider],
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
    expect(await readFile(join(workspacePath, "src", "message.txt"), "utf8")).toBe("after\n");
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
