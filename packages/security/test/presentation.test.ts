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

    expect(value.title).toBe("Interact with process");
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

    expect(value.title).toBe("Read file");
    expect(value.summary).toContain("Read file");
    expect(value.output?.chunk).not.toContain("real-value");
    expect(Buffer.byteLength(value.output?.chunk ?? "", "utf8")).toBeLessThanOrEqual(8192);
  });
});
