import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  CaelushToolExecutionUpdateSanitizer,
  MAX_TRANSIENT_UPDATE_BYTES,
} from "../src/tool-update-sanitizer.js";

const invocation = {
  id: createToolInvocationId(),
  runId: createRunId(),
  stepId: createStepId(),
  toolName: "exec_command" as const,
  args: { cmd: "printf safe" },
  riskLevel: "CRITICAL" as const,
  status: "RUNNING" as const,
  createdAt: createTimestampMs(1_700_000_000_000),
};

describe("Phase 6E transient update sanitization", () => {
  it("sanitizes the semantic text once, then splits whole UTF-8 chunks", () => {
    const source = "中文☃".repeat(2_000);
    const updates = new CaelushToolExecutionUpdateSanitizer().sanitizeMany({
      toolName: invocation.toolName,
      invocation,
      update: { kind: "OUTPUT", stream: "stdout", chunk: source },
    });

    expect(updates.length).toBeGreaterThan(1);
    expect(updates.every((update) => update.kind === "OUTPUT")).toBe(true);
    expect(
      updates.every(
        (update) =>
          update.kind !== "OUTPUT" ||
          Buffer.byteLength(update.chunk, "utf8") <= MAX_TRANSIENT_UPDATE_BYTES,
      ),
    ).toBe(true);
    expect(updates.map((update) => (update.kind === "OUTPUT" ? update.chunk : "")).join("")).toBe(
      source,
    );
  });

  it("drops secrets and host paths before any chunk can reach a consumer", () => {
    const sanitizer = new CaelushToolExecutionUpdateSanitizer();
    expect(
      sanitizer
        .sanitizeMany({
          toolName: invocation.toolName,
          invocation,
          update: { kind: "OUTPUT", stream: "stdout", chunk: "Authorization: Bearer raw-token" },
        })
        .map((update) => (update.kind === "OUTPUT" ? update.chunk : ""))
        .join(""),
    ).not.toContain("raw-token");
    expect(
      sanitizer.sanitizeMany({
        toolName: invocation.toolName,
        invocation,
        update: { kind: "OUTPUT", stream: "stdout", chunk: "D:\\private\\secret.txt" },
      }),
    ).toEqual([]);
  });
});
