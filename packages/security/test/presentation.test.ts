import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type JsonObject,
  type ToolInvocation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushToolPresentation } from "../src/index.js";

const identityTerminalSanitizer = (value: string): string => value;

function invocation(
  toolName: "exec_command" | "read_file" | "write_stdin",
  args: Record<string, unknown>,
): ToolInvocation {
  return {
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    toolName,
    args: args as JsonObject,
    riskLevel: "CRITICAL" as const,
    status: "RUNNING" as const,
    createdAt: createTimestampMs(1),
  };
}

function failedInvocation(error: NonNullable<ToolInvocation["error"]>): ToolInvocation {
  return {
    ...invocation("exec_command", { cmd: "git status --short" }),
    status: "FAILED",
    error,
  };
}

describe("Security Tool presentation", () => {
  it.each([0, 3])("summarizes an EXITED process with exit code %i", (exitCode) => {
    const value = new CaelushToolPresentation({
      terminalOutputSanitizer: identityTerminalSanitizer,
    }).presentResult({
      invocation: invocation("exec_command", { cmd: "pnpm test" }),
      result: {
        content: `Process exited with exit code ${exitCode}.`,
        details: { status: "EXITED", exitCode },
        isError: false,
      },
    });

    expect(value.summary).toBe(`进程已退出（退出码 ${exitCode}）`);
  });

  it("redacts command secrets and terminal controls before display", () => {
    const value = new CaelushToolPresentation({
      terminalOutputSanitizer: identityTerminalSanitizer,
    }).presentShellCommand({
      invocation: invocation("exec_command", {
        cmd: "printf 'API_KEY=real-value' && curl -H 'Authorization: Bearer real-token' https://u:p@example.test/?token=secret",
      }),
    });

    expect(value).toContain("[REDACTED]");
    expect(value).not.toContain("real-value");
    expect(value).not.toContain("real-token");
    expect(value).not.toContain("secret");
    expect(value).not.toContain("\u001b");
  });

  it("never includes write_stdin chars in its invocation summary", () => {
    const value = new CaelushToolPresentation({
      terminalOutputSanitizer: identityTerminalSanitizer,
    }).presentInvocation({
      invocation: invocation("write_stdin", {
        session_id: "process-1",
        chars: "password=real-value",
      }),
    });

    expect(value.title).toBe("与进程交互");
    expect(value.summary).toContain("进程");
    expect(value.summary).not.toContain("real-value");
    expect(value.summary).not.toContain("password");
  });

  it("redacts and bounds result output while preserving a safe summary", () => {
    const value = new CaelushToolPresentation({
      terminalOutputSanitizer: identityTerminalSanitizer,
    }).presentResult({
      invocation: invocation("read_file", { path: ".env" }),
      result: {
        content: `${"x".repeat(10_000)} API_KEY=real-value`,
        details: { path: ".env", linesReturned: 10 },
        isError: false,
      },
    });

    expect(value.title).toBe("读取文件");
    expect(value.summary).toContain("读取文件");
    expect(value.output?.chunk).not.toContain("real-value");
    expect(Buffer.byteLength(value.output?.chunk ?? "", "utf8")).toBeLessThanOrEqual(8192);
  });

  it("uses Chinese system-owned Tool labels while preserving user commands and paths", () => {
    const presentation = new CaelushToolPresentation({
      terminalOutputSanitizer: identityTerminalSanitizer,
    });
    const value = presentation.presentInvocation({
      invocation: invocation("read_file", { path: "src/index.ts" }),
    });

    expect(value.title).toBe("读取文件");
    expect(value.summary).toContain("src/index.ts");
    expect(value.summary).not.toContain("Read");
  });

  it("summarizes Tool failures from durable codes and never leaks raw error details", () => {
    const presentation = new CaelushToolPresentation({
      terminalOutputSanitizer: identityTerminalSanitizer,
    });
    const cases: readonly {
      readonly name: string;
      readonly error: NonNullable<ToolInvocation["error"]>;
      readonly expected: string;
    }[] = [
      {
        name: "execution failure",
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message: "RAW_ERROR_MESSAGE_SECRET",
          retryable: false,
          details: { diagnostic: "RAW_ERROR_DETAILS_SECRET" },
        },
        expected: "工具执行失败",
      },
      {
        name: "output refusal",
        error: {
          code: "TOOL_OUTPUT_ERROR",
          message: "RAW_ERROR_MESSAGE_SECRET",
          retryable: false,
          details: { diagnostic: "RAW_ERROR_DETAILS_SECRET" },
        },
        expected: "工具输出无法安全使用",
      },
      {
        name: "unknown outcome",
        error: {
          code: "TOOL_OUTCOME_UNKNOWN",
          message: "RAW_ERROR_MESSAGE_SECRET",
          retryable: true,
          details: { diagnostic: "RAW_ERROR_DETAILS_SECRET" },
        },
        expected: "工具结果未知，请勿自动重试",
      },
      {
        name: "legacy uncertain disposition",
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message: "RAW_ERROR_MESSAGE_SECRET",
          retryable: true,
          details: {
            executionDisposition: "UNCERTAIN_SIDE_EFFECT",
            diagnostic: "RAW_ERROR_DETAILS_SECRET",
          },
        },
        expected: "工具结果未知，请勿自动重试",
      },
      {
        name: "explicit retryable error",
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message: "RAW_ERROR_MESSAGE_SECRET",
          retryable: true,
          details: { diagnostic: "RAW_ERROR_DETAILS_SECRET" },
        },
        expected: "工具执行失败（可重试）",
      },
    ];

    for (const testCase of cases) {
      const result = presentation.presentResult({
        invocation: failedInvocation(testCase.error),
        result: { content: "safe result output", details: { status: "FAILED" }, isError: true },
      });
      expect(result.summary, testCase.name).toBe(testCase.expected);
      expect(JSON.stringify(result), testCase.name).not.toContain("RAW_ERROR_MESSAGE_SECRET");
      expect(JSON.stringify(result), testCase.name).not.toContain("RAW_ERROR_DETAILS_SECRET");
    }
  });

  it("does not infer retryability from isError alone", () => {
    const presentation = new CaelushToolPresentation({
      terminalOutputSanitizer: identityTerminalSanitizer,
    });
    const failed = {
      ...invocation("exec_command", { cmd: "git status --short" }),
      status: "FAILED" as const,
    };

    const result = presentation.presentResult({
      invocation: failed,
      result: { content: "safe result output", details: { status: "FAILED" }, isError: true },
    });

    expect(result.summary).toBe("工具执行失败");
    expect(result.summary).not.toContain("可重试");
  });

  it("does not present a refused result as available", () => {
    const presentation = new CaelushToolPresentation({
      terminalOutputSanitizer: identityTerminalSanitizer,
    });
    const details = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, index) => [`entry_${index}`, index]),
    ) as JsonObject;

    const result = presentation.presentResult({
      invocation: failedInvocation({
        code: "TOOL_OUTPUT_ERROR",
        message: "safe internal message",
        retryable: false,
      }),
      result: { content: "safe result output", details, isError: true },
    });

    expect(result.summary).toBe("工具输出无法安全使用");
  });
});
