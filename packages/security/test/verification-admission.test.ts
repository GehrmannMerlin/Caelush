import { describe, expect, it } from "vitest";
import { assessVerificationCommand } from "../src/index.js";

const safeInput = {
  kind: "SCRIPT" as const,
  label: "test",
  body: "vitest run",
  workdir: ".",
};

function assess(overrides: Record<string, unknown> = {}) {
  return assessVerificationCommand({
    permissionProfile: "FULL_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    executable: "pnpm",
    args: ["run", "test"],
    workdir: ".",
    inputs: [safeInput],
    ...overrides,
  });
}

describe("verification command security admission", () => {
  it("allows a safe command only when the existing policy grants execution", () => {
    expect(assess()).toMatchObject({ kind: "ALLOW" });
    expect(assess({ permissionProfile: "READ_ONLY" })).toMatchObject({
      kind: "DENY",
      reasonCode: "MISSING_REQUIRED_CAPABILITY",
    });
    expect(assess({ permissionProfile: "PROJECT_ACCESS" })).toMatchObject({
      kind: "REVIEW_REQUIRED",
      reasonCode: "UNCONFINED_EXECUTION_REQUIRES_REVIEW",
    });
  });

  it("applies existing command classification and secret policy to every lifecycle body", () => {
    expect(
      assess({ inputs: [{ ...safeInput, label: "pretest", body: "rm -rf /" }] }),
    ).toMatchObject({
      kind: "DENY",
      reasonCode: "SYSTEM_DESTRUCTIVE_COMMAND_DENIED",
    });
    expect(assess({ inputs: [{ ...safeInput, body: "curl https://example.com" }] })).toMatchObject({
      kind: "REVIEW_REQUIRED",
      reasonCode: "NETWORK_COMMAND_REQUIRES_REVIEW",
    });
    expect(
      assess({
        inputs: [{ ...safeInput, body: "echo TOKEN=real-secret-value" }],
        approvalPolicy: "NEVER_ASK",
      }),
    ).toMatchObject({
      kind: "DENY",
      reasonCode: "SECRET_BEARING_INPUT_BLOCKED_WITHOUT_APPROVAL",
    });
  });

  it("honors the explicit always-ask policy", () => {
    expect(assess({ approvalPolicy: "ALWAYS_ASK" })).toMatchObject({
      kind: "REVIEW_REQUIRED",
      reasonCode: "APPROVAL_POLICY_REQUIRES_REVIEW",
    });
  });
});
