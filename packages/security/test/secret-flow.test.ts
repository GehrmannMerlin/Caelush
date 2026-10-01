import { describe, expect, it } from "vitest";
import { assessCommandEffect, evaluateSecurityDecision } from "../src/index.js";

describe("secret flow safety", () => {
  it("denies detected secret to network flow even in Full Access", () => {
    const effect = assessCommandEffect({
      command: "curl https://example.invalid",
      platform: "POSIX_SH",
      workdir: ".",
      tty: false,
      secretTaintIds: ["api-key-1"],
    });
    expect(
      evaluateSecurityDecision({
        permissionProfile: "FULL_ACCESS",
        approvalPolicy: "NEVER_ASK",
        riskLevel: "LOW",
        requiredCapabilities: ["SHELL_EXEC", "WEB_FETCH"],
        effect,
      }),
    ).toMatchObject({ kind: "DENY", reasonCode: "SECRET_EXFILTRATION_DENIED" });
  });
});
