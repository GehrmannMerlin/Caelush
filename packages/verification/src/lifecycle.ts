import { VerificationCheckSchema, type VerificationCheck } from "@caelush/protocol";

const transitions: Readonly<
  Record<VerificationCheck["status"], readonly VerificationCheck["status"][]>
> = {
  PENDING: ["RUNNING", "SKIPPED", "ERROR"],
  RUNNING: ["PASSED", "FAILED", "ERROR", "CANCELLED"],
  PASSED: [],
  FAILED: [],
  ERROR: [],
  SKIPPED: [],
  CANCELLED: [],
};

export function assertVerificationCheckTransition(
  previous: VerificationCheck,
  next: VerificationCheck,
): void {
  VerificationCheckSchema.parse(previous);
  VerificationCheckSchema.parse(next);

  if (
    previous.id !== next.id ||
    previous.planId !== next.planId ||
    previous.ordinal !== next.ordinal
  ) {
    throw new Error("Verification check identity cannot change");
  }
  if (JSON.stringify(previous.spec) !== JSON.stringify(next.spec)) {
    throw new Error("Verification check intent cannot change");
  }
  if (!transitions[previous.status].includes(next.status)) {
    throw new Error(`Invalid verification check transition ${previous.status} -> ${next.status}`);
  }
}
