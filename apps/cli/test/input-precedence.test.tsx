import {
  ApprovalRequestSchema,
  createApprovalRequestId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CliConversationController } from "../src/application/cli-controller.js";
import { createApprovalView } from "../src/application/cli-control.js";
import { createInitialCliState, type CliViewState } from "../src/application/cli-state.js";
import { App } from "../src/components/App.js";

describe("CLI input precedence", () => {
  it("uses Approval Enter instead of Composer Enter", () => {
    const approval = createApprovalView(
      ApprovalRequestSchema.parse({
        id: createApprovalRequestId(),
        runId: createRunId(),
        toolInvocationId: createToolInvocationId(),
        riskLevel: "HIGH",
        title: "Approval required",
        reason: "The action requires approval.",
        action: { toolName: "read_file", summary: "Read a source file" },
        status: "PENDING",
        scope: "ONCE",
        createdAt: 1,
      }),
    );
    const state: CliViewState = {
      ...createInitialCliState(),
      bootstrap: "READY",
      controlMode: "APPROVAL",
      activeRun: { runId: approval.runId, status: "WAITING_APPROVAL" },
      approvalState: { requests: [approval], selectedRequestIndex: 0, submitting: false },
      composerEnabled: false,
    };
    const resolveApproval = vi.fn(async () => true);
    const submitPrompt = vi.fn(async () => true);
    const rendered = render(
      <App controller={fakeController(state, { resolveApproval, submitPrompt })} />,
    );

    rendered.stdin.write("\r");

    expect(resolveApproval).toHaveBeenCalledTimes(1);
    expect(resolveApproval).toHaveBeenCalledWith(approval.id, { action: "REJECT" });
    expect(submitPrompt).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("renders Session picker rows without leaking internal metadata", () => {
    const state: CliViewState = {
      ...createInitialCliState(),
      bootstrap: "READY",
      controlMode: "SESSION_PICKER",
      sessionCandidates: [
        {
          session: {
            id: createSessionId(),
            createdAt: 1,
            updatedAt: 1,
            metadata: {
              title: "Current project",
              database: "SECRET_DATABASE",
              providerUrl: "SECRET_PROVIDER_URL",
            },
          },
          lastActivityAt: 2,
        },
      ],
      composerEnabled: false,
    };
    const rendered = render(<App controller={fakeController(state)} />);

    expect(rendered.lastFrame()).toContain("Resume a Session");
    expect(rendered.lastFrame()).toContain("Current project");
    expect(rendered.lastFrame()).not.toContain("SECRET_DATABASE");
    expect(rendered.lastFrame()).not.toContain("SECRET_PROVIDER_URL");
    rendered.unmount();
  });

  it("routes Ctrl+C to cancellation and Ctrl+D to local detach for an active Run", () => {
    const state: CliViewState = {
      ...createInitialCliState(),
      bootstrap: "READY",
      activeRun: { runId: createRunId(), status: "RUNNING" },
      composerEnabled: false,
    };
    const cancelActiveRun = vi.fn(async () => true);
    const detachActiveRun = vi.fn();
    const writeMessage = vi.fn();
    const controller = fakeController(state, { cancelActiveRun, detachActiveRun });
    const rendered = render(<App controller={controller} writeMessage={writeMessage} />);

    rendered.stdin.write("\u0003");
    expect(cancelActiveRun).toHaveBeenCalledTimes(1);
    expect(detachActiveRun).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("keeps Ctrl+C cancellation available while an Approval dialog is open", () => {
    const runId = createRunId();
    const state: CliViewState = {
      ...createInitialCliState(),
      bootstrap: "READY",
      controlMode: "APPROVAL",
      activeRun: { runId, status: "WAITING_APPROVAL" },
      composerEnabled: false,
    };
    const cancelActiveRun = vi.fn(async () => true);
    const rendered = render(<App controller={fakeController(state, { cancelActiveRun })} />);

    rendered.stdin.write("\u0003");

    expect(cancelActiveRun).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });
});

function fakeController(
  state: CliViewState,
  overrides: Record<string, unknown> = {},
): CliConversationController {
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    bootstrap: async () => undefined,
    submitPrompt: async () => true,
    moveApprovalSelection: () => undefined,
    moveSessionSelection: () => undefined,
    moveRecoverySelection: () => undefined,
    selectSession: async () => true,
    selectRecoveryRun: async () => true,
    confirmPendingRun: async () => true,
    closeApproval: () => undefined,
    closePendingRunConfirmation: () => undefined,
    resolveApproval: async () => true,
    cancelActiveRun: async () => true,
    detachActiveRun: () => undefined,
    reconnectActiveRun: () => undefined,
    dispose: () => undefined,
    ...overrides,
  } as unknown as CliConversationController;
}
