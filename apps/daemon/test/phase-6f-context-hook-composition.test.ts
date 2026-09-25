import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AIAdapterEvent,
  ApiAdapter,
  ApiAdapterStreamInput,
  AIModelRequest,
} from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { createControlHookId, type ContextContributionRegistration } from "@caelush/agent";
import { createWorkspaceId } from "@caelush/protocol";
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

class RecordingProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly requests: AIModelRequest[] = [];

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input.request);
    const isVerification = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    return this.events(
      isVerification
        ? JSON.stringify({ verdict: "PASS", summary: "The candidate is acceptable." })
        : "done",
    );
  }

  private async *events(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("Phase 6F production Context Hook composition", () => {
  it("projects a non-empty Hook into the actual Fake Gateway request and redacts unsafe text", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-phase-6f-hook-"));
    const provider = new RecordingProvider();
    const hook: ContextContributionRegistration = {
      id: createControlHookId("phase-6f-production"),
      priority: 10,
      criticality: "REQUIRED",
      timeoutMs: 100,
      hook: {
        contribute: async () => [
          {
            id: "workspace-fact",
            source: "phase-6f-test",
            replay: "SNAPSHOT" as const,
            items: [
              {
                id: "unsafe-fact",
                priorityClass: "NORMAL" as const,
                tokenEstimate: 0,
                content: "TOKEN=CAELUSH_PHASE_6F_SECRET_9D /home/should-not-leak",
              },
            ],
          },
        ],
      },
    };
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
      contextContributionHooks: [hook],
    });

    const client = new CaelushClient({ baseUrl: daemon.url });
    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const run = await client.createRun(session.id, {
      goal: "inspect the workspace",
      workspace: { id: createWorkspaceId(), path: directory },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
    });
    await client.startRun(run.id);

    let status = "RUNNING";
    let settled: unknown;
    for (let attempt = 0; attempt < 240 && !isTerminal(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await client.getRun(run.id);
      status = (settled as { status: string }).status;
    }
    expect(status, JSON.stringify(settled)).toBe("COMPLETED");
    const requestText = JSON.stringify(provider.requests);
    expect(requestText).toContain("<context_contributions>");
    expect(requestText).toContain("[REDACTED:HOST_PATH]");
    expect(requestText).not.toContain("CAELUSH_PHASE_6F_SECRET_9D");
    expect(requestText).not.toContain("/home/should-not-leak");
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
