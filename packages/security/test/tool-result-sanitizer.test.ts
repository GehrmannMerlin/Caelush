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

  it("hides sensitive-file search match bodies while retaining relative metadata", () => {
    const result = new CaelushToolResultSanitizer().sanitize({
      toolName: "search_text",
      invocation: {
        id: createToolInvocationId(),
        runId: createRunId(),
        stepId: createStepId(),
        toolName: "search_text",
        args: { path: ".env", pattern: "TOKEN" },
        riskLevel: "LOW",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
      result: {
        content: ".env:1: TOKEN=SECRET_SENTINEL_VALUE",
        details: {
          matches: [{ path: ".env", line: 1, text: "TOKEN=SECRET_SENTINEL_VALUE" }],
        },
        isError: false,
      },
    });

    expect(result.content).toContain("[REDACTED:SENSITIVE_FILE_CONTENT]");
    expect(result.content).not.toContain("SECRET_SENTINEL_VALUE");
    expect(result.details).toEqual({
      matches: [{ path: ".env", line: 1, text: "[REDACTED:SENSITIVE_FILE_CONTENT]" }],
    });
  });

  it("replaces sensitive Git diff bodies with a bounded structural marker", () => {
    const result = new CaelushToolResultSanitizer().sanitize({
      toolName: "git_diff",
      invocation: {
        id: createToolInvocationId(),
        runId: createRunId(),
        stepId: createStepId(),
        toolName: "git_diff",
        args: { path: ".env" },
        riskLevel: "LOW",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
      result: {
        content: "+API_KEY=SECRET_DIFF_VALUE",
        details: { path: ".env", scope: "WORKTREE" },
        isError: false,
      },
    });

    expect(result.content).toBe("[SENSITIVE DIFF CONTENT REDACTED]");
    expect(JSON.stringify(result)).not.toContain("SECRET_DIFF_VALUE");
  });
});
