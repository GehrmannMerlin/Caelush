import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaelushClient } from "@caelush/client";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../daemon/src/index.js";
import { CliConversationController } from "../src/application/cli-controller.js";
import { App } from "../src/components/App.js";
import {
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  fixtureBinding,
  fixtureModelSource,
} from "./support/ai-fixture.js";

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

/**
 * Phase 2C: a fixture adapter is a *dialect*, not a vendor.
 *
 * Each class below registers the shared `FIXTURE_API` id and implements the AI core's
 * `ApiAdapter` seam. There is no `supportsModel` and no capability declaration any more:
 * model metadata is the model catalog's authority, and the gateway owns the
 * `stream.start` / `stream.finish` envelope, so an adapter emits only dialect events.
 */
class TimelineProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly entered = deferred<void>();
  readonly release = deferred<void>();
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    if (
      input.request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.text(JSON.stringify({ verdict: "PASS", summary: "The task is acceptable." }));
    }
    if (this.calls === 1) return this.readFileCall();
    return this.text("The verified workspace report is complete.");
  }

  private async *readFileCall(): AsyncGenerator<AIAdapterEvent> {
    this.entered.resolve();
    await this.release.promise;
    yield { type: "tool_call.start", payload: { toolCallId: "read-call", toolName: "read_file" } };
    yield {
      type: "tool_call.completed",
      payload: { id: "read-call", name: "read_file", input: { path: "src/message.txt" } },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *text(value: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text: value } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

class ApprovalTimelineProvider implements ApiAdapter {
  readonly id = FIXTURE_API;

  stream(): AsyncGenerator<AIAdapterEvent> {
    return this.toolCall();
  }

  private async *toolCall(): AsyncGenerator<AIAdapterEvent> {
    yield {
      type: "tool_call.start",
      payload: { toolCallId: "approval-call", toolName: "apply_patch" },
    };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "approval-call",
        name: "apply_patch",
        input: {
          patch: "*** Begin Patch\n*** Update File: README.md\n@@\n+before\n+after\n*** End Patch",
        },
      },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }
}

describe("real daemon to CLI timeline E2E", () => {
  it("renders real SSE activity, safe output, verification, and verified completion in Ink", async () => {
    const workspacePath = await makeWorkspace("caelush-cli-timeline-e2e-", "API_KEY=real-value\n");
    const provider = new TimelineProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    controller = new CliConversationController({ client, workspacePath });
    await controller.bootstrap();
    const rendered = render(<App controller={controller} />);

    await expect(controller.submitPrompt("inspect the workspace safely")).resolves.toBe(true);
    await provider.entered.promise;
    provider.release.resolve();
    await waitFor(() => controller?.getState().activeRun === undefined);

    const frame = rendered.lastFrame();
    expect(frame).toContain("Read file");
    expect(frame).toContain("Verification");
    expect(frame).toContain("The verified workspace report is complete.");
    expect(frame).not.toContain("API_KEY=real-value");
    expect(frame).not.toContain("read-call");
    expect(await readFile(join(workspacePath, "src", "message.txt"), "utf8")).toContain(
      "API_KEY=real-value",
    );
    rendered.unmount();
  }, 20_000);

  it("renders a real WAITING_APPROVAL notice and stops without resolving it", async () => {
    const workspacePath = await makeWorkspace("caelush-cli-approval-e2e-", "before\n");
    const provider = new ApprovalTimelineProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    controller = new CliConversationController({ client, workspacePath });
    await controller.bootstrap();
    const rendered = render(<App controller={controller} />);

    await expect(controller.submitPrompt("make the approved change")).resolves.toBe(true);
    await waitFor(() => controller?.getState().activeRun?.status === "WAITING_APPROVAL");

    expect(controller.getState().timeline.activeApprovals).toHaveLength(1);
    expect(rendered.lastFrame()).toContain("Approval required");
    expect(rendered.lastFrame()).not.toContain("Press Enter");
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("before\n");
    rendered.unmount();
  }, 20_000);
});

async function makeWorkspace(prefix: string, contents: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  directory = workspacePath;
  await mkdir(join(workspacePath, "src"));
  await writeFile(join(workspacePath, "src", "message.txt"), contents, "utf8");
  await writeFile(join(workspacePath, "README.md"), "before\n", "utf8");
  return workspacePath;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
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
