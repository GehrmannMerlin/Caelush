import { createRunId, createSessionId, createWorkspaceId } from "@caelush/protocol";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { CliConversationController } from "../src/application/cli-controller.js";
import type { CliViewState } from "../src/application/cli-state.js";
import { App } from "../src/components/App.js";

const runId = createRunId();
const baseState: CliViewState = {
  bootstrap: "READY",
  workspace: { id: createWorkspaceId(), path: "C:\\workspace\\project" },
  session: { id: createSessionId(), createdAt: 1, updatedAt: 1, metadata: {} },
  daemonInfo: {
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: "0.1.0",
    capabilities: {
      runExecution: true,
      runRecovery: true,
      cancellation: true,
      approvals: true,
      sseReplay: true,
    },
    runtimeKinds: ["local"],
    configuredProviders: ["fixture"],
    defaultModel: { provider: "fixture", model: "fixture-model" },
    defaultRunConfiguration: {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    },
  },
  transcript: [
    { id: "user-1", kind: "USER", text: "你好 😀", runId },
    { id: "assistant-1", kind: "ASSISTANT", text: "已完成检查。", runId },
  ],
  composerEnabled: true,
  activity: "Ready",
};

describe("Ink CLI shell", () => {
  it("renders the public header, settled transcript, activity, and composer", () => {
    const controller = fakeController(baseState);
    const rendered = render(<App controller={controller} />);

    expect(rendered.lastFrame()).toContain("Caelush");
    expect(rendered.lastFrame()).toContain("fixture/fixture-model");
    expect(rendered.lastFrame()).toContain("你好 😀");
    expect(rendered.lastFrame()).toContain("已完成检查。");
    expect(rendered.lastFrame()).toContain("Ready");
    expect(rendered.lastFrame()).not.toContain("toolCallId");
    expect(rendered.lastFrame()).not.toContain("stdout");
    rendered.unmount();
  });

  it("renders a safe fatal state without enabling the composer", () => {
    const controller = fakeController({
      bootstrap: "BOOTSTRAP_ERROR",
      transcript: [],
      composerEnabled: false,
      activity: "Terminal error",
      fatalError: "Caelush Local Agent Service is not reachable.",
    });
    const rendered = render(<App controller={controller} />);

    expect(rendered.lastFrame()).toContain("Caelush Local Agent Service is not reachable.");
    expect(rendered.lastFrame()).not.toContain("Press Enter");
    rendered.unmount();
  });
});

function fakeController(state: CliViewState): CliConversationController {
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    bootstrap: async () => undefined,
    submitPrompt: async () => true,
    dispose: () => undefined,
  } as unknown as CliConversationController;
}
