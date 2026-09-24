import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import type { ToolInvocation } from "@caelush/protocol";
import {
  createRuntimeProgressSignalProjector,
  type CodingRuntimeProgressEnvelope,
} from "../src/tools/runtime-progress-signal-projector.js";
import { describe, expect, it } from "vitest";

const sessionId = createSessionId();
const runId = createRunId();
const stepId = createStepId();

function invocation(
  toolName: ToolInvocation["toolName"],
  args: ToolInvocation["args"],
): ToolInvocation {
  return {
    id: createToolInvocationId(),
    runId,
    stepId,
    toolName,
    args,
    riskLevel: "CRITICAL",
    status: "RUNNING",
    createdAt: createTimestampMs(1_700_000_000_000),
  };
}

function input(
  toolName: ToolInvocation["toolName"],
  update: CodingRuntimeProgressEnvelope["update"],
  args: ToolInvocation["args"] = {},
  existingInvocation?: ToolInvocation,
): CodingRuntimeProgressEnvelope {
  return {
    sessionId,
    toolName,
    invocation: existingInvocation ?? invocation(toolName, args),
    update,
  };
}

function projector() {
  return createRuntimeProgressSignalProjector({
    eventIdFactory: { create: createEventId },
    clock: { now: () => createTimestampMs(1_700_000_000_100) },
  });
}

describe("RuntimeProgressSignalProjector", () => {
  it("maps one sanitized output update to one ordered canonical signal", () => {
    const project = projector();
    const shellInvocation = invocation("exec_command", {});
    const shell = project.project(
      input(
        "exec_command",
        { kind: "OUTPUT", stream: "stdout", chunk: "one" },
        {},
        shellInvocation,
      ),
    );
    const shell2 = project.project(
      input(
        "exec_command",
        { kind: "OUTPUT", stream: "stderr", chunk: "two" },
        {},
        shellInvocation,
      ),
    );
    const process = project.project(
      input(
        "write_stdin",
        { kind: "OUTPUT", stream: "stdout", chunk: "three" },
        { session_id: "proc_real" },
      ),
    );
    const generic = project.project(
      input("read_file", { kind: "OUTPUT", stream: "stdout", chunk: "four" }),
    );

    expect(shell).toMatchObject({
      type: "shell.output",
      schemaVersion: 2,
      sessionId,
      payload: { stream: "stdout", chunk: "one" },
      durability: { kind: "EPHEMERAL", deliveryClass: "ORDERED", streamSequence: 1 },
    });
    expect(shell2).toMatchObject({
      type: "shell.output",
      durability: { streamSequence: 2 },
    });
    expect(process).toMatchObject({
      type: "process.output",
      payload: { processId: "proc_real", chunk: "three" },
      durability: { streamKey: "process:proc_real", streamSequence: 1 },
    });
    expect(generic).toMatchObject({ type: "tool.output", schemaVersion: 2 });
  });

  it("fails closed when process identity is absent and ignores non-output updates", () => {
    const project = projector();
    expect(
      project.project(input("write_stdin", { kind: "OUTPUT", stream: "stdout", chunk: "lost" })),
    ).toBeNull();
    expect(
      project.project(
        input("exec_command", { kind: "PROGRESS", message: "half", completed: 1, total: 2 }),
      ),
    ).toBeNull();
    expect(
      project.project(input("exec_command", { kind: "STATUS", message: "running" })),
    ).toBeNull();
  });
});
