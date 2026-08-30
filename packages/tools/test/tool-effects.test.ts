import {
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type JsonObject,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  SAFE_SHELL_COMMAND_LABEL,
  applyToolEffectsToAgentState,
  projectExecEffects,
  projectPatchEffects,
  projectReadFileEffect,
  projectStdinEffects,
  type ToolEffectProjectorInput,
} from "../src/index.js";

function state() {
  return {
    runId: createRunId(),
    sessionId: createSessionId(),
    goal: "test",
    status: "RUNNING" as const,
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "FULL_ACCESS" as const,
    approvalPolicy: "NEVER_ASK" as const,
    plan: [],
    recentObservations: [],
    changedFiles: [],
    activeProcesses: [],
    errors: [],
    verification: "NOT_RUN" as const,
    usage: { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    updatedAt: createTimestampMs(1),
  };
}

function input(details: JsonObject, args: JsonObject = {}): ToolEffectProjectorInput {
  return {
    request: {
      runId: createRunId(),
      stepId: "step_01" as never,
      invocationId: "tool_01" as never,
      externalCallId: "call",
      args,
      environment: {
        workspace: { id: createWorkspaceId(), path: "C:/workspace" },
        runtime: { id: "local", kind: "local" },
      },
    },
    result: { content: "ok", details, isError: false },
    now: createTimestampMs(2),
  };
}

describe("Tool effects", () => {
  it("projects successful file reads and patches, but no effects from errors", () => {
    expect(projectReadFileEffect(input({ path: "src/a.ts" }))).toEqual([
      { type: "FILE_READ", path: "src/a.ts" },
    ]);
    expect(
      projectReadFileEffect({
        ...input({ path: "src/a.ts" }),
        result: { content: "", details: { path: "src/a.ts" }, isError: true },
      }),
    ).toEqual([]);
    expect(
      projectPatchEffects(
        input({
          changes: [
            { kind: "UPDATE", path: "src/a.ts", additions: 1, deletions: 2 },
            { kind: "MOVE", fromPath: "a.ts", toPath: "b.ts", additions: 0, deletions: 0 },
          ],
        }),
      ),
    ).toHaveLength(2);
  });

  it("uses the safe shell label and does not copy command or stdin", () => {
    const started = projectExecEffects(
      input({ status: "RUNNING", sessionId: "session-1" }, { cmd: "secret command" }),
    );
    expect(started).toEqual([
      { type: "SHELL_STARTED", invocationId: expect.any(String) },
      { type: "PROCESS_STARTED", sessionId: "session-1" },
    ]);
    expect(JSON.stringify(started)).not.toContain("secret command");
    const stopped = projectStdinEffects(
      input({ status: "EXITED", exitCode: 0 }, { session_id: "session-1", chars: "secret stdin" }),
    );
    expect(stopped).toEqual([{ type: "PROCESS_STOPPED", sessionId: "session-1" }]);
    expect(SAFE_SHELL_COMMAND_LABEL).toBe("shell command");
  });

  it("keeps latest file changes and bounds process summaries", () => {
    const initial = state();
    const withFile = applyToolEffectsToAgentState(
      initial,
      [
        { type: "FILE_CHANGE", summary: { path: "a.ts", changeType: "CREATED" } },
        { type: "FILE_CHANGE", summary: { path: "a.ts", changeType: "MODIFIED", additions: 2 } },
        { type: "PROCESS_STARTED", sessionId: "session-1" },
      ],
      createTimestampMs(3),
    );
    expect(withFile.changedFiles).toEqual([{ path: "a.ts", changeType: "MODIFIED", additions: 2 }]);
    expect(withFile.activeProcesses).toEqual([
      { id: "session-1", command: "shell command", status: "RUNNING" },
    ]);
    const stopped = applyToolEffectsToAgentState(
      withFile,
      [{ type: "PROCESS_STOPPED", sessionId: "session-1" }],
      createTimestampMs(4),
    );
    expect(stopped.activeProcesses).toEqual([]);
    expect(JSON.stringify(stopped)).not.toContain("secret");
  });
});
