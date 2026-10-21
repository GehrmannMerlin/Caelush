import type { AgentRun, RunCorrectionRecoveryRecordV1, RunResourcePolicy } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CODING_EXECUTION_DISCIPLINE } from "@caelush/coding-agent";
import { resolveRunCodingExecutionDiscipline } from "../src/services/coding-execution-policy.js";

const runId = "run_policy_test" as AgentRun["id"];
const run = (resourcePolicy?: RunResourcePolicy) => ({
  id: runId,
  ...(resourcePolicy === undefined ? {} : { resourcePolicy }),
});

const recovery: RunCorrectionRecoveryRecordV1 = {
  version: 1,
  runId,
  decisionId: "a".repeat(64),
  stateRevision: 1,
  continuationRevision: 1,
  reason: "LEGACY_NO_PROGRESS",
  fromCorrectionVersion: "HISTORICAL_V1",
  effectiveCorrectionVersion: "AUTONOMOUS_CORRECTION_V2",
  authority: "DAEMON_AUTO_CORRECTION_V1",
  committedAt: 1 as RunCorrectionRecoveryRecordV1["committedAt"],
};

describe("per-Run Coding execution discipline", () => {
  it("applies the V2 discipline only to the frozen V2 version", () => {
    expect(
      resolveRunCodingExecutionDiscipline(
        run({ correctionVersion: "AUTONOMOUS_CORRECTION_V2" } as RunResourcePolicy),
        null,
      ),
    ).toBe(CODING_EXECUTION_DISCIPLINE);
  });

  it("leaves an unupgraded historical Run on its original policy", () => {
    expect(resolveRunCodingExecutionDiscipline(run(), null)).toBeUndefined();
  });

  it("applies V2 after an explicit durable recovery upgrade for the same Run", () => {
    expect(resolveRunCodingExecutionDiscipline(run(), recovery)).toBe(CODING_EXECUTION_DISCIPLINE);
    expect(
      resolveRunCodingExecutionDiscipline({ id: "run_other" as AgentRun["id"] }, recovery),
    ).toBeUndefined();
  });
});
