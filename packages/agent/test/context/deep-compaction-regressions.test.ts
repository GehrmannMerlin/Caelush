import { describe, expect, it } from "vitest";

import { createContextCompactionPlanner } from "@caelush/agent";

import {
  createLongOpenTurnFixture,
  createMultiRunCompactionFixture,
  createMultiRunPlannerPolicy,
} from "./support/deep-compaction-fixtures.js";

describe("deep compaction regression fixtures", () => {
  it("models closed source Runs with sequence numbers that restart at one", () => {
    const fixture = createMultiRunCompactionFixture();

    expect(fixture.history.units.filter((unit) => unit.status === "CLOSED")).toHaveLength(2);
    expect(
      fixture.history.units
        .filter((unit) => unit.kind === "CONVERSATION_TURN")
        .map((unit) => unit.messages[0]?.sequence),
    ).toEqual([1, 1, 1]);
    expect(fixture.runIds[0]).not.toBe(fixture.runIds[1]);
    expect(fixture.runIds[1]).not.toBe(fixture.runIds[2]);
  });

  it("covers_multiple_runs_in_one_operation", () => {
    const fixture = createMultiRunCompactionFixture();
    const plan = createContextCompactionPlanner().plan({
      history: fixture.history,
      policy: createMultiRunPlannerPolicy(),
      reason: "PROACTIVE_PRESSURE",
    });

    expect(plan).not.toBeNull();
    expect(plan?.selectedUnitIds).toEqual(fixture.expectedOldUnitIds);
    expect(plan?.selectedUnitIds).not.toContain(fixture.currentUnitId);
    expect(plan?.sourceCoverageDelta?.map((range) => String(range.runId))).toEqual(
      fixture.runIds.slice(0, 2).map(String),
    );
  });

  it("provides 100 closed Tool batches followed by one open batch", () => {
    const fixture = createLongOpenTurnFixture();

    expect(fixture.closedProtocolUnitCount).toBe(100);
    expect(fixture.openProtocolUnitCount).toBe(1);
  });
});
