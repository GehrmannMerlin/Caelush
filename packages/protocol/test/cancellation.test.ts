import {
  RunCancellationCauseSchema,
  RunCancellationIntentSchema,
  createRunId,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("RunCancellationIntent", () => {
  it("accepts a strict user-requested intent", () => {
    const intent = {
      runId: createRunId(),
      cause: "USER_REQUESTED" as const,
      requestedAt: 1_700_000_000_000,
    };

    expect(RunCancellationIntentSchema.parse(intent)).toEqual(intent);
    expect(RunCancellationCauseSchema.parse("USER_REQUESTED")).toBe("USER_REQUESTED");
  });

  it("rejects unknown causes, reasons, and keys", () => {
    const runId = createRunId();

    expect(
      RunCancellationIntentSchema.safeParse({
        runId,
        cause: "TIMEOUT",
        requestedAt: 1_700_000_000_000,
      }).success,
    ).toBe(false);
    expect(
      RunCancellationIntentSchema.safeParse({
        runId,
        cause: "USER_REQUESTED",
        requestedAt: 1_700_000_000_000,
        reason: "secret command",
      }).success,
    ).toBe(false);
    expect(
      RunCancellationIntentSchema.safeParse({
        runId,
        cause: "USER_REQUESTED",
        requestedAt: -1,
      }).success,
    ).toBe(false);
  });
});
