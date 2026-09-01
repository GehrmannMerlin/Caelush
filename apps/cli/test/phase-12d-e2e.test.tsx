import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaelushClient } from "@caelush/client";
import { createWorkspaceId, type ModelRef } from "@caelush/protocol";
import type {
  LLMCapabilities,
  LLMProvider,
  LLMProviderCallContext,
  LLMProviderRequest,
  LLMStreamEvent,
  ProviderId,
} from "@caelush/llm";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../daemon/src/index.js";
import { CliConversationController } from "../src/application/cli-controller.js";
import { App } from "../src/components/App.js";

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
let controller: CliConversationController | undefined;

afterEach(async () => {
  controller?.dispose();
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  controller = undefined;
  daemon = undefined;
  directory = undefined;
});

class InteractiveApprovalProvider implements LLMProvider {
  readonly id = "phase-12d-approval" as ProviderId;
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
    if (
      request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.text(request, context, JSON.stringify({ verdict: "PASS", summary: "passed" }));
    }
    if (this.calls === 1) return this.applyPatch(request, context);
    return this.text(request, context, "The approved change is complete.");
  }

  private async *applyPatch(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.patchCalls += 1;
    yield streamStart(this.id, request, context);
    yield {
      type: "tool_call.start",
      payload: { toolCallId: "phase-12d-call", toolName: "apply_patch" },
    };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "phase-12d-call",
        name: "apply_patch",
        input: {
          patch:
            "*** Begin Patch\n*** Update File: README.md\n@@\n-before\n+phase-12d-after\n*** End Patch",
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
  readonly id = "phase-12d-cancel" as ProviderId;
  entered!: () => void;
  private enteredPromise = new Promise<void>((resolve) => {
    this.entered = resolve;
  });

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "cancel-model";
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  async *stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    yield streamStart(this.id, request, context);
    this.entered();
    await new Promise<void>((resolve) =>
      context.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield { type: "text.delta", payload: { text: "late output must be discarded" } };
    yield { type: "stream.finish", payload: { finishReason: "STOP" } };
  }

  waitUntilEntered(): Promise<void> {
    return this.enteredPromise;
  }
}

describe("real Phase 12D daemon and CLI E2E", () => {
  it("resolves a real Approval through the CLI dialog and completes the same Run", async () => {
    const workspacePath = await makeWorkspace("phase-12d-approval-");
    const provider = new InteractiveApprovalProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [provider],
      defaultModel: { provider: provider.id, model: "approval-model" },
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    controller = new CliConversationController({ client, workspacePath });
    await controller.bootstrap();
    const rendered = render(<App controller={controller} />);

    await expect(controller.submitPrompt("make the approved change")).resolves.toBe(true);
    await waitFor(() => controller?.getState().controlMode === "APPROVAL");
    const runId = controller.getState().activeRun?.runId;
    expect(runId).toBeDefined();
    expect(rendered.lastFrame()).toContain("Approve once");

    controller.moveApprovalSelection(-1);
    const approval = controller.getState().approvalState!.requests[0]!;
    await expect(
      controller.resolveApproval(approval.id, { action: "APPROVE", scope: "ONCE" }),
    ).resolves.toBe(true);
    await waitFor(() => controller?.getState().activeRun === undefined);

    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toContain("phase-12d-after");
    expect(provider.patchCalls).toBe(1);
    expect(controller.getState().displayHistory.at(-1)).toMatchObject({
      kind: "ASSISTANT",
      text: "The approved change is complete.",
    });
    expect(runId).toBeDefined();
    rendered.unmount();
  }, 20_000);

  it("cancels a real active Run through the CLI controller and preserves daemon truth", async () => {
    const workspacePath = await makeWorkspace("phase-12d-cancel-");
    const provider = new BlockingProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [provider],
      defaultModel: { provider: provider.id, model: "cancel-model" },
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    controller = new CliConversationController({ client, workspacePath });
    await controller.bootstrap();
    await controller.submitPrompt("cancel the long task");
    await provider.waitUntilEntered();
    await waitFor(() => controller?.getState().activeRun?.status === "RUNNING");

    await expect(controller.cancelActiveRun()).resolves.toBe(true);
    const runId = controller.getState().displayHistory.at(-1)?.runId;
    expect(controller.getState().activeRun).toBeUndefined();
    expect(controller.getState().activity).toBe("Cancelled");
    expect(runId).toBeDefined();
    await expect(client.getRun(runId!)).resolves.toMatchObject({ status: "CANCELLED" });
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("before\n");
  }, 20_000);
});

async function makeWorkspace(prefix: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  directory = workspacePath;
  await writeFile(join(workspacePath, "README.md"), "before\n", "utf8");
  return workspacePath;
}

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
