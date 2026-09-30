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

describe("Security Tool presentation", () => {
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
});
