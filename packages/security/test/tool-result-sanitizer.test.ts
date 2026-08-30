import { createRunId, createStepId, createToolInvocationId, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushToolResultSanitizer } from "../src/index.js";

describe("Tool result sanitizer", () => {
  it("redacts content and details before they can become observations", () => {
    const result = new CaelushToolResultSanitizer().sanitize({
      toolName: "read_file",
      invocation: {
        id: createToolInvocationId(),
        runId: createRunId(),
        stepId: createStepId(),
        toolName: "read_file",
        args: { path: ".env" },
        riskLevel: "LOW",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
      result: {
        content: "API_KEY=fake-api-value-123456",
        details: { password: "fake-password-value" },
        isError: false,
      },
    });

    expect(result.content).toBe("API_KEY=[REDACTED]");
    expect(result.details).toEqual({ password: "[REDACTED]" });
    expect(JSON.stringify(result)).not.toContain("fake-");
  });
});
