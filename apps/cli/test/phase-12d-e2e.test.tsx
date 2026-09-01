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
import type { CliTimer, CliTimerHandle } from "../src/application/reconnect-scheduler.js";
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

  constructor(private readonly applyPatchOnFirstCall = true) {}

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
    if (this.calls === 1 && this.applyPatchOnFirstCall) return this.applyPatch(request, context);
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

class TextCompletionProvider implements LLMProvider {
  readonly id = "phase-12d-reconnect" as ProviderId;
  calls = 0;

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "reconnect-model";
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.calls += 1;
    const text = request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    )
      ? JSON.stringify({ verdict: "PASS", summary: "passed" })
      : "The reconnectable task is complete.";
    return textEvents(request, context, text);
  }
}

class ContinuityProvider implements LLMProvider {
  readonly id = "phase-12d-continuity" as ProviderId;
  readonly normalRequests: LLMProviderRequest[] = [];

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "continuity-model";
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    const isReview = request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    if (isReview) {
      return textEvents(request, context, JSON.stringify({ verdict: "PASS", summary: "passed" }));
    }

    this.normalRequests.push(request);
    const hasMarker = request.messages.some((message) =>
      (typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
      ).includes("ORANGE-731"),
    );
    return textEvents(
      request,
      context,
      this.normalRequests.length === 1
        ? "I will remember ORANGE-731."
        : hasMarker
          ? "The marker was ORANGE-731."
          : "I do not know the marker.",
    );
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

  it("rejects a real Approval without executing the Tool", async () => {
    const workspacePath = await makeWorkspace("phase-12d-reject-");
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

    await expect(controller.submitPrompt("reject the dangerous change")).resolves.toBe(true);
    await waitFor(() => controller?.getState().controlMode === "APPROVAL");
    const approval = controller.getState().approvalState!.requests[0]!;
    await expect(controller.resolveApproval(approval.id, { action: "REJECT" })).resolves.toBe(true);
    await waitFor(() => controller?.getState().activeRun === undefined);

    expect(provider.patchCalls).toBe(1);
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("before\n");
    expect(controller.getState().displayHistory.at(-1)).toMatchObject({
      kind: "ASSISTANT",
      text: "The approved change is complete.",
    });
  }, 20_000);

  it("reconnects from the last durable cursor and completes without duplicate timeline entries", async () => {
    const workspacePath = await makeWorkspace("phase-12d-reconnect-");
    const provider = new TextCompletionProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [provider],
      defaultModel: { provider: provider.id, model: "reconnect-model" },
      logger: false,
    });
    const timer = new ImmediateReconnectTimer();
    const afterSequences: Array<number | undefined> = [];
    let eventConnections = 0;
    let dropFirstEventStream = true;
    const client = new CaelushClient({
      baseUrl: daemon.url,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/events")) {
          eventConnections += 1;
          afterSequences.push(
            new URL(url).searchParams.get("afterSequence") === null
              ? undefined
              : Number(new URL(url).searchParams.get("afterSequence")),
          );
          const response = await fetch(input, init);
          if (dropFirstEventStream && response.body !== null) {
            dropFirstEventStream = false;
            return truncateSseResponse(response);
          }
          return response;
        }
        return fetch(input, init);
      },
    });
    controller = new CliConversationController({ client, workspacePath, timer });
    await controller.bootstrap();
    await expect(controller.submitPrompt("finish through a reconnect")).resolves.toBe(true);
    await waitFor(() => controller?.getState().transportState === "RECONNECTING");
    expect(timer.pendingCount).toBe(1);
    timer.runNext();
    await waitFor(() => controller?.getState().activeRun === undefined);

    const history = controller.getState().displayHistory;
    expect(eventConnections).toBeGreaterThanOrEqual(2);
    expect(afterSequences[0]).toBe(0);
    expect(afterSequences.slice(1).some((value) => value !== undefined && value > 0)).toBe(true);
    expect(new Set(history.map((entry) => entry.id)).size).toBe(history.length);
    expect(history.at(-1)).toMatchObject({
      kind: "ASSISTANT",
      text: "The reconnectable task is complete.",
    });
  }, 20_000);

  it("resumes the same waiting Approval after a daemon restart without creating a Run", async () => {
    const workspacePath = await makeWorkspace("phase-12d-restart-");
    const databasePath = join(workspacePath, "caelush.db");
    const firstProvider = new InteractiveApprovalProvider();
    daemon = await startDaemon({
      databasePath,
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [firstProvider],
      defaultModel: { provider: firstProvider.id, model: "approval-model" },
      logger: false,
    });
    const firstClient = new CaelushClient({ baseUrl: daemon.url });
    controller = new CliConversationController({ client: firstClient, workspacePath });
    await controller.bootstrap();
    await controller.submitPrompt("survive a daemon restart");
    await waitFor(() => controller?.getState().controlMode === "APPROVAL");

    const firstState = controller.getState();
    const sessionId = firstState.session!.id;
    const runId = firstState.activeRun!.runId;
    const approvalId = firstState.approvalState!.requests[0]!.id;
    const workspace = firstState.workspace!;
    controller.dispose();
    controller = undefined;
    await daemon.close();
    daemon = undefined;

    const secondProvider = new InteractiveApprovalProvider(false);
    daemon = await startDaemon({
      databasePath,
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [secondProvider],
      defaultModel: { provider: secondProvider.id, model: "approval-model" },
      logger: false,
    });
    const calls: Array<{ readonly method: string; readonly url: string }> = [];
    const secondClient = new CaelushClient({
      baseUrl: daemon.url,
      fetch: async (input, init) => {
        calls.push({ method: init?.method ?? "GET", url: String(input) });
        return fetch(input, init);
      },
    });
    controller = new CliConversationController({
      client: secondClient,
      workspacePath,
      launchIntent: { kind: "RESUME_EXACT", sessionId },
    });
    await controller.bootstrap();
    const resumed = controller.getState();
    expect(resumed.session?.id).toBe(sessionId);
    expect(resumed.workspace).toEqual(workspace);
    expect(resumed.activeRun?.runId).toBe(runId);
    expect(resumed.approvalState?.requests[0]?.id).toBe(approvalId);
    expect(resumed.controlMode).toBe("APPROVAL");
    expect(
      calls.some((call) => call.method === "POST" && /\/sessions\/[^/]+\/runs$/.test(call.url)),
    ).toBe(false);

    const rendered = render(<App controller={controller} />);
    expect(rendered.lastFrame()).toContain("Approve once");
    await expect(
      controller.resolveApproval(approvalId, { action: "APPROVE", scope: "ONCE" }),
    ).resolves.toBe(true);
    await waitFor(() => controller?.getState().activeRun === undefined);

    expect(secondProvider.patchCalls).toBe(0);
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toContain("phase-12d-after");
    expect(controller.getState().displayHistory.at(-1)).toMatchObject({
      kind: "ASSISTANT",
      text: "The approved change is complete.",
    });
    rendered.unmount();
  }, 20_000);

  it("continues a Session with the same WorkspaceRef and real verified history", async () => {
    const workspacePath = await makeWorkspace("phase-12d-continue-");
    const provider = new ContinuityProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [provider],
      defaultModel: { provider: provider.id, model: "continuity-model" },
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    controller = new CliConversationController({ client, workspacePath });
    await controller.bootstrap();
    await controller.submitPrompt("Remember marker ORANGE-731");
    await waitFor(() => controller?.getState().activeRun === undefined);
    const firstState = controller.getState();
    const sessionId = firstState.session!.id;
    const workspace = firstState.workspace!;
    controller.dispose();

    controller = new CliConversationController({
      client,
      workspacePath,
      launchIntent: { kind: "CONTINUE" },
    });
    await controller.bootstrap();
    expect(controller.getState().session?.id).toBe(sessionId);
    expect(controller.getState().workspace).toEqual(workspace);
    expect(controller.getState().displayHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "USER", text: "Remember marker ORANGE-731" }),
        expect.objectContaining({ kind: "ASSISTANT", text: "I will remember ORANGE-731." }),
      ]),
    );

    await controller.submitPrompt("What marker did I mention?");
    await waitFor(() => controller?.getState().activeRun === undefined);
    expect(provider.normalRequests[1]!.messages).toEqual(
      expect.arrayContaining([
        { role: "user", content: "Remember marker ORANGE-731" },
        {
          role: "assistant",
          content: [{ type: "text", text: "I will remember ORANGE-731." }],
        },
      ]),
    );
    expect(controller.getState().displayHistory.at(-1)).toMatchObject({
      kind: "ASSISTANT",
      text: "The marker was ORANGE-731.",
    });
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

async function* textEvents(
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
  text: string,
): AsyncIterable<LLMStreamEvent> {
  yield streamStart(request.model.provider as ProviderId, request, context);
  yield { type: "text.delta", payload: { text } };
  yield { type: "stream.finish", payload: { finishReason: "STOP" } };
}

function truncateSseResponse(response: Response): Response {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  const body = new ReadableStream<Uint8Array>({
    async start(streamController) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            streamController.close();
            return;
          }
          buffered += decoder.decode(next.value, { stream: true });
          const delimiter = buffered.match(/\r?\n\r?\n/);
          if (delimiter?.index !== undefined) {
            const end = delimiter.index + delimiter[0].length;
            streamController.enqueue(encoder.encode(buffered.slice(0, end)));
            void reader.cancel().catch(() => undefined);
            streamController.close();
            return;
          }
        }
      } catch (error) {
        streamController.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

class ImmediateReconnectTimer implements CliTimer {
  private readonly callbacks: Array<{ readonly callback: () => void; cancelled: boolean }> = [];

  get pendingCount(): number {
    return this.callbacks.filter((item) => !item.cancelled).length;
  }

  schedule(_delayMs: number, callback: () => void): CliTimerHandle {
    const item = { callback, cancelled: false };
    this.callbacks.push(item);
    return { cancel: () => (item.cancelled = true) };
  }

  runNext(): void {
    const item = this.callbacks.find((candidate) => !candidate.cancelled);
    if (item === undefined) throw new Error("No reconnect timer is pending.");
    item.cancelled = true;
    item.callback();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
