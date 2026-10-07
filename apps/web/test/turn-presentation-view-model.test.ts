import { describe, expect, it } from "vitest";
import { createRunId, type SessionTurnPresentationTurnV3 } from "@caelush/protocol";

import { projectTurnPresentation } from "../src/application/turn-presentation-view-model.js";

describe("projectTurnPresentation", () => {
  it("classifies a Turn without reordering its server-provided items", () => {
    const runId = createRunId();
    const turn: SessionTurnPresentationTurnV3 = {
      runId,
      conversationTurnId: "turn-view-model",
      runStatus: "COMPLETED",
      openedAt: 1_000,
      closedAt: 9_000,
      highWatermark: 12,
      items: [
        {
          id: "user",
          runId,
          conversationTurnId: "turn-view-model",
          ordinal: 0,
          status: "COMPLETED",
          createdAt: 1_000,
          kind: "USER",
          text: "task",
        },
        {
          id: "tool",
          runId,
          conversationTurnId: "turn-view-model",
          ordinal: 1,
          status: "COMPLETED",
          createdAt: 3_000,
          kind: "TOOL",
          toolInvocationId: "tool-invocation",
          toolName: "read_file",
          category: "READ",
          phase: "COMPLETED",
          title: "读取文件",
          summary: "src/app.ts",
          facts: [],
          effects: [],
        },
        {
          id: "commentary",
          runId,
          conversationTurnId: "turn-view-model",
          ordinal: 2,
          status: "COMPLETED",
          createdAt: 2_000,
          kind: "ASSISTANT",
          phase: "COMMENTARY",
          text: "commentary after the tool",
        },
        {
          id: "final",
          runId,
          conversationTurnId: "turn-view-model",
          ordinal: 3,
          status: "COMPLETED",
          createdAt: 4_000,
          kind: "ASSISTANT",
          phase: "FINAL_ANSWER",
          text: "done",
        },
      ],
    };

    const viewModel = projectTurnPresentation(turn, undefined, 20_000);

    expect(viewModel.processItems.map((item) => item.id)).toEqual(["tool", "commentary"]);
    expect(viewModel.toolActivities.map((item) => item.id)).toEqual(["tool"]);
    expect(viewModel.finalAnswerItems.map((item) => item.id)).toEqual(["final"]);
    expect(viewModel.activityCount).toBe(2);
    expect(viewModel.elapsedMs).toBe(8_000);
    expect(viewModel.isTerminal).toBe(true);
    expect(viewModel.isActive).toBe(false);
  });

  it("only considers the matching active Run active and keeps an empty Turn valid", () => {
    const runId = createRunId();
    const turn: SessionTurnPresentationTurnV3 = {
      runId,
      conversationTurnId: "empty-turn",
      runStatus: "RUNNING",
      openedAt: 5_000,
      highWatermark: 0,
      items: [],
    };

    expect(
      projectTurnPresentation(turn, { id: createRunId(), status: "RUNNING" }, 9_000),
    ).toMatchObject({
      isActive: false,
      isTerminal: false,
      activityCount: 0,
      elapsedMs: 4_000,
      processItems: [],
      userItems: [],
    });
    expect(projectTurnPresentation(turn, { id: runId, status: "RUNNING" }, 9_000).isActive).toBe(
      true,
    );
  });
});
