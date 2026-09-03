import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../daemon/src/index.js";
import { WebSessionManager } from "../src/application/session-manager.js";

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
let manager: WebSessionManager | undefined;

afterEach(async () => {
  manager?.dispose();
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  manager = undefined;
  daemon = undefined;
  directory = undefined;
});

describe("Phase 13D real Web control integration", () => {
  it("approves once through the real Web manager and resumes the waiting Tool", async () => {
    const workspacePath = await makeWorkspace();
    const provider = new ApprovalProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [provider],
      defaultModel: { provider: "phase-13d-approval", model: "fixture" },
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    manager = new WebSessionManager({
      client,
      workspace: { id: createWorkspaceId(), path: workspacePath },
      info: await client.getInfo(),
    });

    manager.beginDraft();
    await expect(manager.submitPrompt("approve the fixture patch")).resolves.toBe(true);
    await waitFor(() => manager?.getSnapshot().approvalState?.requests.length === 1);
    const approval = manager.getSnapshot().approvalState?.requests[0];
    expect(approval).toMatchObject({
      scope: "RUN",
      options: expect.arrayContaining([
        expect.objectContaining({ kind: "APPROVE_ONCE" }),
        expect.objectContaining({ kind: "APPROVE_RUN" }),
        expect.objectContaining({ kind: "REJECT" }),
      ]),
    });

    await expect(
      manager.resolveApproval(approval!.id, { action: "APPROVE", scope: "ONCE" }),
    ).resolves.toBe(true);
    await waitFor(() => manager?.getSnapshot().activeRun === undefined);
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("after\n");
    expect(provider.toolCalls).toBe(1);
  }, 20_000);

  it("rejects through the real Web manager without invoking the Tool", async () => {
    const workspacePath = await makeWorkspace();
    const provider = new ApprovalProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerOverrides: [provider],
      defaultModel: { provider: "phase-13d-approval", model: "fixture" },
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    manager = new WebSessionManager({
      client,
      workspace: { id: createWorkspaceId(), path: workspacePath },
      info: await client.getInfo(),
    });

    manager.beginDraft();
    await expect(manager.submitPrompt("reject the fixture patch")).resolves.toBe(true);
    await waitFor(() => manager?.getSnapshot().approvalState?.requests.length === 1);
    const approval = manager.getSnapshot().approvalState?.requests[0];
    await expect(manager.resolveApproval(approval!.id, { action: "REJECT" })).resolves.toBe(true);
    await waitFor(() => manager?.getSnapshot().activeRun === undefined);
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("before\n");
    expect(provider.toolCalls).toBe(1);
  }, 20_000);
});

class ApprovalProvider implements LLMProvider {
  readonly id = "phase-13d-approval" as ProviderId;
  calls = 0;
  toolCalls = 0;

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "fixture";
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
      return this.text(request, context, JSON.stringify({ verdict: "PASS", summary: "approved" }));
    }
    if (this.calls === 1) {
      this.toolCalls += 1;
      return this.tool(request, context);
    }
    return this.text(request, context, "finished");
  }

  private async *tool(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    yield {
      type: "stream.start",
      payload: { callId: context.callId, providerId: this.id, model: request.model },
    };
    yield {
      type: "tool_call.start",
      payload: { toolCallId: "patch-once", toolName: "apply_patch" },
    };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "patch-once",
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
    value: string,
  ): AsyncIterable<LLMStreamEvent> {
    yield {
      type: "stream.start",
      payload: { callId: context.callId, providerId: this.id, model: request.model },
    };
    yield { type: "text.delta", payload: { text: value } };
    yield { type: "stream.finish", payload: { finishReason: "STOP" } };
  }
}

async function makeWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "caelush-phase-13d-web-"));
  directory = path;
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "README.md"), "before\n", "utf8");
  return path;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
