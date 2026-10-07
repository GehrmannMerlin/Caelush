import {
  createRunId,
  createTimestampMs,
  type ClientAgentRun,
  type SessionTurnPresentationResponseV3,
  type SessionTurnPresentationTurnV3,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { mergeActiveTurnPresentation } from "../src/application/session-presentation-merge.js";

describe("mergeActiveTurnPresentation", () => {
  it("replaces only the refreshed Turn and preserves historical Turns in canonical order", () => {
    const firstRun = run(100);
    const secondRun = run(200);
    const activeRun = run(300);
    const firstTurn = turn(firstRun.id, 100, [user(firstRun.id, "first turn")]);
    const secondTurn = turn(secondRun.id, 200, [user(secondRun.id, "second turn")]);
    const oldActiveTurn = turn(activeRun.id, 300, [user(activeRun.id, "active turn", 3)]);
    const current: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [firstTurn, secondTurn, oldActiveTurn],
    };
    const refreshedTurn = turn(activeRun.id, 300, [user(activeRun.id, "active turn", 90)], 90);

    const merged = mergeActiveTurnPresentation(
      current,
      { capabilityVersion: 3, turns: [refreshedTurn] },
      [activeRun, secondRun, firstRun],
      activeRun,
    );

    expect(merged).toEqual({
      capabilityVersion: 3,
      turns: [firstTurn, secondTurn, refreshedTurn],
    });
  });

  it("inserts a newly returned Active Turn by canonical Run order and supplies its optimistic USER", () => {
    const firstRun = run(100);
    const activeRun = run(200);
    const current: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [turn(firstRun.id, 100, [user(firstRun.id, "history")])],
    };
    const refreshedTurn = turn(activeRun.id, 200, [], 7);

    const merged = mergeActiveTurnPresentation(
      current,
      { capabilityVersion: 3, turns: [refreshedTurn] },
      [activeRun, firstRun],
      activeRun,
    );

    expect(merged?.turns.map((item) => item.runId)).toEqual([firstRun.id, activeRun.id]);
    expect(merged?.turns[1]?.items).toEqual([
      expect.objectContaining({
        id: `optimistic:presentation:user:${activeRun.id}`,
        runId: activeRun.id,
        conversationTurnId: refreshedTurn.conversationTurnId,
        ordinal: 0,
        kind: "USER",
        text: activeRun.goal,
      }),
    ]);
    expect(merged?.turns[1]?.highWatermark).toBe(7);
  });

  it("reconciles the optimistic USER as soon as the durable USER arrives", () => {
    const activeRun = run(100);
    const current: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [turn(activeRun.id, 100, [], 4)],
    };
    const withoutCanonicalUser = mergeActiveTurnPresentation(
      current,
      { capabilityVersion: 3, turns: [turn(activeRun.id, 100, [], 5)] },
      [activeRun],
      activeRun,
    );
    const durableUser = user(activeRun.id, activeRun.goal, 8);
    const withCanonicalUser = mergeActiveTurnPresentation(
      withoutCanonicalUser!,
      {
        capabilityVersion: 3,
        turns: [turn(activeRun.id, 100, [durableUser], 9)],
      },
      [activeRun],
      activeRun,
    );

    expect(withoutCanonicalUser?.turns[0]?.items).toHaveLength(1);
    expect(withoutCanonicalUser?.turns[0]?.items[0]?.id).toBe(
      `optimistic:presentation:user:${activeRun.id}`,
    );
    expect(withCanonicalUser?.turns[0]?.items).toEqual([durableUser]);
  });

  it("does not route legacy presentation responses through the V3 merge", () => {
    const activeRun = run(100);
    const current: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [],
    };

    expect(
      mergeActiveTurnPresentation(
        current,
        { capabilityVersion: 2, highWatermark: 4, items: [] },
        [activeRun],
        activeRun,
      ),
    ).toBeUndefined();
  });
});

function run(createdAt: number): Pick<ClientAgentRun, "id" | "createdAt" | "goal"> {
  return {
    id: createRunId(),
    createdAt: createTimestampMs(createdAt),
    goal: `goal ${String(createdAt)}`,
  };
}

function turn(
  runId: ClientAgentRun["id"],
  openedAt: number,
  items: SessionTurnPresentationTurnV3["items"],
  highWatermark = 0,
): SessionTurnPresentationTurnV3 {
  return {
    runId,
    conversationTurnId: `turn:${runId}`,
    runStatus: "RUNNING",
    openedAt: createTimestampMs(openedAt),
    highWatermark,
    items,
  };
}

function user(
  runId: ClientAgentRun["id"],
  text: string,
  createdAt = 0,
): SessionTurnPresentationTurnV3["items"][number] {
  return {
    id: `user:${runId}`,
    runId,
    conversationTurnId: `turn:${runId}`,
    ordinal: 0,
    status: "COMPLETED",
    createdAt: createTimestampMs(createdAt),
    kind: "USER",
    text,
  };
}
