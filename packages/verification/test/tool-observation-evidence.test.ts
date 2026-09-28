import {
  createObservationId,
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type ToolObservation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createToolObservationEvidence,
  type VerificationEvidenceSanitizer,
} from "../src/index.js";

const sanitizer: VerificationEvidenceSanitizer = {
  redactText(value) {
    return value.replaceAll("secret-value", "[REDACTED]");
  },
  boundText(value, maxBytes) {
    if (Buffer.byteLength(value, "utf8") <= maxBytes) {
      return { text: value, omittedBytes: 0, truncated: false };
    }
    return { text: value.slice(0, maxBytes), omittedBytes: value.length - maxBytes, truncated: true };
  },
};

function observation(input: {
  readonly content: string;
  readonly createdAt: number;
  readonly isError?: boolean;
  readonly details?: ToolObservation["details"];
}): ToolObservation {
  return {
    id: createObservationId(),
    runId: createRunId(),
    stepId: createStepId(),
    kind: "TOOL",
    toolInvocationId: createToolInvocationId(),
    content: input.content,
    ...(input.details === undefined ? {} : { details: input.details }),
    isError: input.isError ?? false,
    createdAt: createTimestampMs(input.createdAt),
  };
}

describe("tool observation evidence", () => {
  it("projects bounded sanitized command observations without raw invocation arguments", () => {
    const planId = createVerificationPlanId();
    const checkId = createVerificationCheckId();
    const older = observation({
      createdAt: 100,
      content: "javac exit=0\nsecret-value",
      details: {
        status: "EXITED",
        exitCode: 0,
        totalOutputBytes: 23,
        workdir: "N001_JavaHello",
        untrustedPayload: { shouldNotBeCopied: true },
      },
    });
    const newer = observation({
      createdAt: 200,
      content: "Hello, Caelush!\njava exit=0",
      details: { status: "EXITED", exitCode: 0 },
    });

    const evidence = createToolObservationEvidence({
      planId,
      checkId,
      candidateHash: "a".repeat(64),
      capturedAt: createTimestampMs(300),
      evidenceIdFactory: createVerificationEvidenceId,
      observations: [
        {
          observation: newer,
          toolName: "exec_command",
          invocationStatus: "COMPLETED",
        },
        {
          observation: older,
          toolName: "exec_command",
          invocationStatus: "COMPLETED",
        },
      ],
      sanitizer,
    });

    expect(evidence).toHaveLength(2);
    expect(evidence.every((item) => item.kind === "COMMAND")).toBe(true);
    expect(evidence.map((item) => item.details)).toEqual([
      expect.objectContaining({
        source: "AGENT_TOOL_OBSERVATION",
        toolName: "exec_command",
        exitCode: 0,
        content: "javac exit=0\n[REDACTED]",
      }),
      expect.objectContaining({ content: "Hello, Caelush!\njava exit=0" }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain("secret-value");
    expect(JSON.stringify(evidence)).not.toContain("shouldNotBeCopied");
    expect(JSON.stringify(evidence)).not.toContain('"workdir"');
  });
});
