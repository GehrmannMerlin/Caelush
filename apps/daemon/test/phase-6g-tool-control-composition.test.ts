import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaelushClient } from "@caelush/client";
import { createControlHookId } from "@caelush/agent";
import { createWorkspaceId } from "@caelush/protocol";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

class ControlPipelineProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly requests: ApiAdapterStreamInput[] = [];
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input);
    this.calls += 1;
    if (
      input.request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.events(JSON.stringify({ verdict: "PASS", summary: "The task is acceptable." }));
    }
    if (this.calls === 1) return this.readCall();
    return this.events("done");
  }

  private async *readCall(): AsyncGenerator<AIAdapterEvent> {
    yield { type: "tool_call.start", payload: { toolCallId: "read_call", toolName: "read_file" } };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "read_call",
        name: "read_file",
        input: { path: "secret.txt" },
      },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *events(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

describe("Phase 6G daemon Tool control composition", () => {
  it("passes safe Guard input and sanitized Feedback contributions through the production entrypoint", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-phase-6g-tool-control-"));
    await writeFile(join(directory, "secret.txt"), "safe file content", "utf8");
    const provider = new ControlPipelineProvider();
    const guardInputs: unknown[] = [];
    const feedbackInputs: unknown[] = [];

    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
      beforeToolDispatchHooks: [
        {
          id: createControlHookId("phase-6g-guard"),
          priority: 10,
          criticality: "REQUIRED",
          timeoutMs: 100,
          hook: {
            evaluate: async (input) => {
              guardInputs.push(input);
              return { kind: "PASS" as const };
            },
          },
        },
      ],
      toolFeedbackContributionHooks: [
        {
          id: createControlHookId("phase-6g-feedback"),
          priority: 10,
          criticality: "REQUIRED",
          timeoutMs: 100,
          hook: {
            contribute: async (input) => {
              feedbackInputs.push(input);
              return [
                {
                  id: "safe-note",
                  text: "API_KEY=CAELUSH_PHASE_6G_SECRET_123\u001b[31m",
                  placement: "APPEND" as const,
                },
              ];
            },
          },
        },
      ],
    });

    const client = new CaelushClient({ baseUrl: daemon.url });
    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const run = await client.createRun(session.id, {
      goal: "inspect the file",
      workspace: { id: createWorkspaceId(), path: directory },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
    });
    await client.startRun(run.id);

    let status = "RUNNING";
    let settled: { status: string } = { status };
    for (let attempt = 0; attempt < 240 && !isTerminal(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = (await client.getRun(run.id)) as { status: string };
      status = settled.status;
    }

    expect(status, JSON.stringify(settled)).toBe("COMPLETED");
    expect(guardInputs).toHaveLength(1);
    expect(guardInputs[0]).not.toHaveProperty("args");
    expect(JSON.stringify(guardInputs[0])).not.toContain("secret.txt");
    expect(feedbackInputs).toHaveLength(1);
    expect(feedbackInputs[0]).toMatchObject({
      toolCallId: "read_call",
      toolName: "read_file",
    });
    expect((feedbackInputs[0] as { builtInFeedback: string }).builtInFeedback).toContain(
      "safe file content",
    );
    expect(provider.requests[1]?.request.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "read_call",
        content: expect.stringContaining("[REDACTED"),
      }),
    );
    expect(JSON.stringify(provider.requests[1])).not.toContain("CAELUSH_PHASE_6G_SECRET_123");
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
