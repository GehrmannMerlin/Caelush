import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import {
  createAIError,
  type AIAdapterEvent,
  type ApiAdapter,
  type ApiAdapterStreamInput,
  type ResolvedAIModelRequest,
} from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { openCaelushStorage } from "@caelush/storage";
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

class OverflowRecoveryProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly requests: ResolvedAIModelRequest[] = [];
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    this.requests.push(input.request);
    if (
      input.request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.textEvents(
        JSON.stringify({ verdict: "PASS", summary: "The candidate is acceptable." }),
      );
    }
    if (this.calls === 1) return this.toolCall();
    // Phase 2C: the provider overflow signal is the AI core's own code now; the agent
    // loop recognises `AI_CONTEXT_OVERFLOW` and still allows exactly one recovery.
    if (this.calls === 2) throw createAIError("AI_CONTEXT_OVERFLOW");
    return this.textEvents("done");
  }

  private async *toolCall(): AsyncGenerator<AIAdapterEvent> {
    yield { type: "tool_call.start", payload: { toolCallId: "read_call", toolName: "read_file" } };
    yield {
      type: "tool_call.completed",
      payload: { id: "read_call", name: "read_file", input: { path: "large.txt" } },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *textEvents(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("Context Runtime production recovery E2E", () => {
  it("reprojects a SQLite-backed raw Tool artifact after provider overflow", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-context-recovery-e2e-"));
    const payload = Array.from(
      { length: 450 },
      (_, index) => `${index}-` + "payload-".repeat(450),
    ).join("\n");
    await writeFile(join(directory, "large.txt"), payload, "utf8");
    const provider = new OverflowRecoveryProvider();
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const run = await client.createRun(session.id, {
      goal: "inspect the large workspace file",
      workspace: { id: createWorkspaceId(), path: directory },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 6, maxToolCalls: 6, timeoutMs: 15_000 },
    });

    await client.startRun(run.id);
    let settled = await client.getRun(run.id);
    for (let attempt = 0; attempt < 160 && !isTerminal(settled.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await client.getRun(run.id);
    }

    expect(settled.status).toBe("COMPLETED");
    expect(await client.getRunContextUsage(run.id)).toMatchObject({
      lastBuildStatus: "SUCCESS",
      lastRecoveryStages: ["REPROJECT_OPEN_OBSERVATIONS_EMERGENCY"],
    });
    expect(provider.calls).toBeGreaterThanOrEqual(4);
    const firstToolRequest = provider.requests[1];
    const recoveredRequest = provider.requests[2];
    expect(firstToolRequest).toBeDefined();
    expect(recoveredRequest).toBeDefined();
    const firstToolMessage = firstToolRequest?.messages.find((message) => message.role === "tool");
    const recoveredToolMessage = recoveredRequest?.messages.find(
      (message) => message.role === "tool",
    );
    expect(firstToolMessage).toBeDefined();
    expect(recoveredToolMessage).toBeDefined();
    // Phase 2C: the model-facing AI tool-result message carries exactly
    // `{role, toolCallId, toolName, content, isError}`. `rawArtifactRef` is a durable
    // recovery pointer and is deliberately dropped by the core's AI projection, so the
    // recovered turn must be shown to reproject the *same* tool result through its
    // identity rather than through a pointer the model never sees. The pointer itself
    // is asserted on the durable observation below.
    expect(firstToolMessage?.toolCallId).toBe("read_call");
    expect(recoveredToolMessage?.toolCallId).toBe(firstToolMessage?.toolCallId);
    expect(recoveredToolMessage?.toolName).toBe(firstToolMessage?.toolName);
    expect(firstToolMessage?.content).toContain("[output omitted; see artifact]");
    expect(recoveredToolMessage?.content).toContain("0-payload-");
    expect(recoveredToolMessage?.content.length).toBeLessThan(
      firstToolMessage?.content.length ?? 0,
    );

    await daemon.close();
    daemon = undefined;
    const storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    try {
      const invocation = (await storage.toolInvocations.listByRun(run.id)).find(
        (item) => item.toolName === "read_file",
      );
      expect(invocation).toBeDefined();
      const observation =
        invocation === undefined
          ? undefined
          : await storage.observations.findByToolInvocation(invocation.id);
      expect(observation?.rawArtifactRef).toBeTruthy();
      const artifact =
        observation?.rawArtifactRef === undefined
          ? undefined
          : await storage.contextArtifacts.readInternal(observation.rawArtifactRef);
      const source = await readFile(join(directory, "large.txt"), "utf8");
      expect(source.length).toBeGreaterThan(1_000_000);
      expect(artifact?.content).toContain("1: 0-payload-");
      expect(artifact?.byteLength).toBeGreaterThan(10_000);
      expect(artifact?.byteLength).toBeLessThan(source.length);
      expect(artifact?.runId).toBe(run.id);
    } finally {
      await storage.close();
    }
  }, 30_000);
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
