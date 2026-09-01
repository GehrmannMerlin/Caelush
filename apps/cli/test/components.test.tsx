import {
  createPlanItemId,
  createRunId,
  createSessionId,
  createVerificationCheckId,
  createVerificationPlanId,
  createWorkspaceId,
} from "@caelush/protocol";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { CliConversationController } from "../src/application/cli-controller.js";
import type { CliViewState } from "../src/application/cli-state.js";
import { createInitialCliTimelineState } from "../src/application/timeline-model.js";
import { App } from "../src/components/App.js";
import { RunRecoveryPicker } from "../src/components/RunRecoveryPicker.js";
import { SessionPicker } from "../src/components/SessionPicker.js";

const runId = createRunId();
const baseState: CliViewState = {
  bootstrap: "READY",
  transportState: "CONNECTED",
  controlMode: "NONE",
  workspace: { id: createWorkspaceId(), path: "C:\\workspace\\project" },
  session: { id: createSessionId(), createdAt: 1, updatedAt: 1, metadata: {} },
  sessionCandidates: [],
  sessionSelectionIndex: 0,
  recoveryCandidates: [],
  recoverySelectionIndex: 0,
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
  displayHistory: [
    { id: "user-1", kind: "USER", text: "你好 😀", runId },
    { id: "assistant-1", kind: "ASSISTANT", text: "已完成检查。", runId },
  ],
  timeline: createInitialCliTimelineState(runId),
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
      displayHistory: [],
      timeline: baseState.timeline,
      composerEnabled: false,
      activity: "Terminal error",
      fatalError: "Caelush Local Agent Service is not reachable.",
    });
    const rendered = render(<App controller={controller} />);

    expect(rendered.lastFrame()).toContain("Caelush Local Agent Service is not reachable.");
    expect(rendered.lastFrame()).not.toContain("Press Enter");
    rendered.unmount();
  });

  it("renders active plan, tool, process, and verification domains dynamically", () => {
    const planId = createVerificationPlanId();
    const activeState: CliViewState = {
      ...baseState,
      composerEnabled: false,
      timeline: {
        ...baseState.timeline,
        currentPlan: [
          { id: createPlanItemId(), title: "Inspect workspace", status: "IN_PROGRESS" },
        ],
        activeTools: [
          {
            id: "tool-1",
            kind: "TOOL",
            title: "Run command",
            text: "Command: pnpm test",
            status: "RUNNING",
          },
        ],
        activeProcesses: [
          {
            id: "process-1",
            kind: "PROCESS",
            title: "Process",
            text: "pnpm test · running",
            status: "RUNNING",
          },
        ],
        verification: [
          {
            planId,
            checkCount: 1,
            passed: 0,
            failed: 0,
            errors: 0,
            skipped: 0,
            finalized: false,
            checks: [
              {
                checkId: createVerificationCheckId(),
                status: "RUNNING",
                title: "TASK · ACCEPTANCE",
              },
            ],
          },
        ],
      },
    };
    const rendered = render(<App controller={fakeController(activeState)} />);

    expect(rendered.lastFrame()).toContain("Live activity");
    expect(rendered.lastFrame()).toContain("Inspect workspace");
    expect(rendered.lastFrame()).toContain("Run command");
    expect(rendered.lastFrame()).toContain("Processes");
    expect(rendered.lastFrame()).toContain("Verification");
    rendered.unmount();
  });

  it("renders bounded Session and Run recovery picker rows", () => {
    const session = {
      id: createSessionId(),
      createdAt: 1,
      updatedAt: 1,
      metadata: { title: "Project session" },
    };
    const sessionRendered = render(
      <SessionPicker candidates={[{ session, lastActivityAt: 2 }]} selectedIndex={0} />,
    );
    expect(sessionRendered.lastFrame()).toContain("Project session");
    expect(sessionRendered.lastFrame()).toContain(session.id.slice(-8));
    sessionRendered.unmount();

    const runRendered = render(
      <RunRecoveryPicker
        candidates={[{ ...baseRunForPicker(), goal: "Inspect the current project" }]}
        selectedIndex={0}
      />,
    );
    expect(runRendered.lastFrame()).toContain("RUNNING");
    expect(runRendered.lastFrame()).toContain("Inspect the current project");
    runRendered.unmount();
  });
});

function baseRunForPicker() {
  return {
    id: runId,
    sessionId: createSessionId(),
    goal: "Run",
    status: "RUNNING" as const,
    workspace: { id: createWorkspaceId(), path: "C:\\workspace\\project" },
    runtime: { id: "local", kind: "local" as const },
    permissionProfile: "PROJECT_ACCESS" as const,
    approvalPolicy: "DANGEROUS_ONLY" as const,
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    model: { provider: "fixture", model: "fixture-model" },
    createdAt: 1,
  };
}

function fakeController(state: CliViewState): CliConversationController {
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    bootstrap: async () => undefined,
    submitPrompt: async () => true,
    dispose: () => undefined,
  } as unknown as CliConversationController;
}
