import {
  createVerificationCheckId,
  createVerificationPlanId,
  type VerificationCheck,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { assertVerificationCheckTransition } from "../src/index.js";

function check(status: VerificationCheck["status"]): VerificationCheck {
  const startedAt = 1_700_000_000_100;
  const finishedAt = 1_700_000_000_200;
  return {
    id: createVerificationCheckId(),
    planId: createVerificationPlanId(),
    ordinal: 0,
    stage: "FAST_STATIC",
    requirement: "IF_AVAILABLE",
    spec: { kind: "PROJECT", purpose: "LINT", source: "SYSTEM" },
    status,
    createdAt: 1_700_000_000_000,
    ...(status === "RUNNING" || status === "PASSED" || status === "FAILED" || status === "CANCELLED"
      ? { startedAt }
      : {}),
    ...(status === "PASSED" || status === "FAILED" || status === "CANCELLED" ? { finishedAt } : {}),
    ...(status === "SKIPPED" ? { finishedAt, skipReason: "NOT_AVAILABLE" as const } : {}),
    ...(status === "ERROR" ? { finishedAt } : {}),
  };
}

function changeStatus(
  previous: VerificationCheck,
  status: VerificationCheck["status"],
): VerificationCheck {
  const {
    status: _status,
    startedAt: _startedAt,
    finishedAt: _finishedAt,
    skipReason: _skipReason,
    ...identity
  } = previous;
  return {
    ...identity,
    status,
    ...(status === "RUNNING" || status === "PASSED" || status === "FAILED" || status === "CANCELLED"
      ? { startedAt: 1_700_000_000_100 }
      : {}),
    ...(status === "PASSED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "SKIPPED" ||
    status === "ERROR"
      ? { finishedAt: 1_700_000_000_200 }
      : {}),
    ...(status === "SKIPPED" ? { skipReason: "NOT_AVAILABLE" as const } : {}),
  };
}

describe("verification check lifecycle", () => {
  it("accepts only the Phase 11B transitions", () => {
    const transitions: Array<[VerificationCheck["status"], VerificationCheck["status"]]> = [
      ["PENDING", "RUNNING"],
      ["PENDING", "SKIPPED"],
      ["PENDING", "ERROR"],
      ["RUNNING", "PASSED"],
      ["RUNNING", "FAILED"],
      ["RUNNING", "ERROR"],
      ["RUNNING", "CANCELLED"],
    ];

    for (const [from, to] of transitions) {
      const previous = check(from);
      expect(() =>
        assertVerificationCheckTransition(previous, changeStatus(previous, to)),
      ).not.toThrow();
    }
  });

  it("rejects terminal mutation and identity changes", () => {
    const terminal = check("PASSED");
    expect(() =>
      assertVerificationCheckTransition(terminal, { ...terminal, status: "RUNNING" }),
    ).toThrow();
    expect(() => assertVerificationCheckTransition(check("PENDING"), check("PASSED"))).toThrow();
    expect(() =>
      assertVerificationCheckTransition(check("PENDING"), {
        ...check("RUNNING"),
        id: check("PENDING").id,
      }),
    ).toThrow();
  });
});
