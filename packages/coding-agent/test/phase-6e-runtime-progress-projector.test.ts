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
import { describe, expect, it, vi } from "vitest";

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
  it("keeps a mixed Unicode chunk intact across the exact 8 KiB boundary", () => {
    const source = `${"x".repeat(8 * 1024 - 1)}😀中文z`;
    const events = projector().projectMany?.(
      input("exec_command", { kind: "OUTPUT", stream: "stdout", chunk: source }),
    );

    expect(events).toHaveLength(2);
    expect(events!.map((event) => event.payload.chunk)).toEqual([
      "x".repeat(8 * 1024 - 1),
      "😀中文z",
    ]);
    expect(
      events!.every((event) => Buffer.byteLength(event.payload.chunk, "utf8") <= 8 * 1024),
    ).toBe(true);
    expect(events!.every((event) => event.payload.chunk.isWellFormed())).toBe(true);
    expect(events!.map((event) => event.durability.streamSequence)).toEqual([1, 2]);
    expect(events!.map((event) => event.payload.chunk).join("")).toBe(source);
  });

  it("projects 1 MiB shell, process and generic output without growing-prefix re-encoding", () => {
    const source = "r".repeat(1024 * 1024);
    const sourceBytes = Buffer.byteLength(source, "utf8");
    const project = projector();
    const originalEncode = TextEncoder.prototype.encode;
    let encodedBytes = 0;
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
      this: TextEncoder,
      value?: string,
    ) {
      const encoded = originalEncode.call(this, value);
      encodedBytes += encoded.byteLength;
      if (encodedBytes > sourceBytes * 16) {
        throw new Error("runtime splitting repeatedly encoded a growing prefix");
      }
      return encoded;
    });

    let shellEvents;
    let processEvents;
    let toolEvents;
    try {
      shellEvents = project.projectMany?.(
        input("exec_command", { kind: "OUTPUT", stream: "stdout", chunk: source }),
      );
      processEvents = project.projectMany?.(
        input(
          "write_stdin",
          { kind: "OUTPUT", stream: "stdout", chunk: source },
          { session_id: "proc_large" },
        ),
      );
      toolEvents = project.projectMany?.(
        input("read_file", { kind: "OUTPUT", stream: "stdout", chunk: source }),
      );
    } finally {
      encodeSpy.mockRestore();
    }

    expect(encodedBytes).toBeLessThanOrEqual(sourceBytes * 6);
    for (const events of [shellEvents!, processEvents!, toolEvents!]) {
      const chunks = events.map((event) => event.payload.chunk);
      expect(events).toHaveLength(128);
      expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 8 * 1024)).toBe(true);
      expect(chunks.join("")).toBe(source);
      expect(events.map((event) => event.durability.streamSequence)).toEqual(
        Array.from({ length: 128 }, (_, index) => index + 1),
      );
    }
    expect(shellEvents!.every((event) => event.type === "shell.output")).toBe(true);
    expect(processEvents!.every((event) => event.type === "process.output")).toBe(true);
    expect(toolEvents!.every((event) => event.type === "tool.output")).toBe(true);
  });

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
