import {
  ApprovalRequestSchema,
  createApprovalRequestId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  type ApprovalRequest,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  approvalOptions,
  approvalResolutionForOption,
  createApprovalView,
  routeCliInput,
  type CliInputKey,
} from "../src/application/cli-control.js";
import { createInitialCliState, type CliViewState } from "../src/application/cli-state.js";

describe("CLI control state", () => {
  it("starts Approval selection at Reject and hides Run scope for ONCE", () => {
    const once = createApprovalView(makeApproval({ scope: "ONCE" }));

    expect(once.selectedIndex).toBe(once.options.findIndex((item) => item.kind === "REJECT"));
    expect(once.options.some((item) => item.kind === "APPROVE_RUN")).toBe(false);
  });

  it("maps every visible option to the exact protocol resolution", () => {
    expect(approvalResolutionForOption("APPROVE_ONCE")).toEqual({
      action: "APPROVE",
      scope: "ONCE",
    });
    expect(approvalResolutionForOption("APPROVE_RUN")).toEqual({
      action: "APPROVE",
      scope: "RUN",
    });
    expect(approvalResolutionForOption("REJECT")).toEqual({ action: "REJECT" });
    expect(approvalOptions("ONCE").map((item) => item.kind)).toEqual(["APPROVE_ONCE", "REJECT"]);
    expect(approvalOptions("ONCE").map((item) => item.label)).toEqual(["Approve once", "Reject"]);
    expect(approvalOptions("RUN").map((item) => item.label)).toEqual([
      "Approve once",
      "Approve this action for this Run",
      "Reject",
    ]);
  });

  it("projects only allowlisted public action fields", () => {
    const view = createApprovalView(
      makeApproval({
        action: {
          toolName: "read_file",
          requiredCapabilities: ["filesystem.read", 7, "process.spawn"],
          summary: "Read a source file",
          command: "SECRET_COMMAND",
          stdin: "SECRET_STDIN",
          token: "SECRET_TOKEN",
        },
      }),
    );

    expect(view).toMatchObject({
      toolName: "read_file",
      requiredCapabilities: ["filesystem.read", "process.spawn"],
      summary: "Read a source file",
    });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(JSON.stringify(view)).not.toContain("command");
    expect(JSON.stringify(view)).not.toContain("stdin");
  });

  it.each([
    [stateWithApproval(), { input: "\r", key: { return: true } }, "APPROVAL_SUBMIT"],
    [stateWithApproval(), { input: "", key: { escape: true } }, "APPROVAL_CLOSE"],
    [stateWithSessionPicker(), { input: "\r", key: { return: true } }, "SESSION_SELECT"],
    [stateWithActiveRun(), { input: "c", key: { ctrl: true } }, "CANCEL"],
    [stateWithActiveRun(), { input: "d", key: { ctrl: true } }, "DETACH"],
    [stateDisconnected(), { input: "r", key: {} }, "RECONNECT"],
  ])("routes input to one active surface", (state, key, expected) => {
    expect(routeCliInput(state as CliViewState, key.input, key.key as CliInputKey).kind).toBe(
      expected,
    );
  });

  it("closes a pending confirmation with Escape and does not confirm it", () => {
    const state = {
      ...createInitialCliState(),
      controlMode: "PENDING_RUN_CONFIRMATION" as const,
      pendingRunId: createRunId(),
    };
    expect(routeCliInput(state, "", { escape: true })).toEqual({ kind: "PENDING_CLOSE" });
    expect(routeCliInput(state, "y", {})).toEqual({ kind: "PENDING_CONFIRM", confirmed: true });
    expect(routeCliInput(state, "n", {})).toEqual({ kind: "PENDING_CONFIRM", confirmed: false });
  });
});

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: createApprovalRequestId(),
    runId: createRunId(),
    toolInvocationId: createToolInvocationId(),
    riskLevel: "HIGH",
    title: "Permission required",
    reason: "The tool needs access.",
    action: {
      toolName: "read_file",
      requiredCapabilities: ["filesystem.read"],
      summary: "Read a source file",
    },
    status: "PENDING",
    scope: "ONCE",
    createdAt: 1,
    ...overrides,
  });
}

function stateWithApproval(): CliViewState {
  return {
    ...createInitialCliState(),
    controlMode: "APPROVAL",
    approvalState: {
      requests: [createApprovalView(makeApproval())],
      selectedRequestIndex: 0,
      submitting: false,
    },
  };
}

function stateWithSessionPicker(): CliViewState {
  return {
    ...createInitialCliState(),
    controlMode: "SESSION_PICKER",
    sessionCandidates: [
      {
        session: { id: createSessionId(), createdAt: 1, updatedAt: 1, metadata: {} },
        lastActivityAt: 1,
      },
    ],
  };
}

function stateWithActiveRun(): CliViewState {
  return {
    ...createInitialCliState(),
    activeRun: { runId: createRunId(), status: "RUNNING" },
  };
}

function stateDisconnected(): CliViewState {
  return {
    ...createInitialCliState(),
    transportState: "DISCONNECTED",
    activeRun: { runId: createRunId(), status: "RUNNING" },
  };
}
