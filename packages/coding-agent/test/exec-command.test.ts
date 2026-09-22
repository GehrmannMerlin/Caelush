import { createExecCommandTool } from "@caelush/coding-agent";
import { ToolExecutionUncertainError } from "@caelush/agent";
import {
  RuntimeInvariantError,
  RuntimeExecError,
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
} from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT, executionInput, processFake, testSignal } from "./support/operations-fixtures.js";

/**
 * `exec_command` — the target Coding builtin.
 *
 * Two things make this Tool's tests load-bearing beyond its arguments:
 *
 * ```text
 * updates     the Tool projects the port's onOutput onto the canonical transient channel, which is
 *             the integration Phase 4B's infrastructure was built for
 * uncertain   a stale or uncertain process session must become ToolExecutionUncertainError, never a
 *             retryable failure — the model must not be invited to run the command again
 * ```
 */

function toolWith(execute: Parameters<typeof processFake>[0]["execute"]) {
  const fake = processFake({ execute, interact: async () => ({}) });
  const definition = createExecCommandTool(fake.exec);
  return { tool: definition.tool, definition, fake };
}

function executed(result: Record<string, unknown>) {
  return async () => result as never;
}

describe("exec_command target builtin", () => {
  it("declares the frozen name, description, schema and defaults", () => {
    const { tool, definition } = toolWith(executed({ status: "EXITED", exitCode: 0 }));

    expect(tool.name).toBe("exec_command");
    expect(tool.description).toBe("Run command.");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        cmd: { type: "string", minLength: 1, description: "Shell command to execute." },
        workdir: {
          type: "string",
          minLength: 1,
          default: ".",
          description: "Workspace-relative working directory; defaults to the workspace root '.'.",
        },
        tty: {
          type: "boolean",
          default: false,
          description: "Use a terminal-backed process; defaults to false.",
        },
        yield_time_ms: {
          type: "integer",
          minimum: 250,
          maximum: 30000,
          default: 10000,
          description:
            "yield_time_ms is observation wait in milliseconds, not a timeout; defaults to 10000.",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    });
    expect(definition.security).toEqual({
      riskLevel: "CRITICAL",
      requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.promptSnippet).toContain("exec_command");
  });

  it("forwards command, workdir, tty, yield time, owner Run and the signal", async () => {
    const { tool, fake } = toolWith(
      executed({ status: "EXITED", exitCode: 0, output: "hi", totalOutputBytes: 3, omittedBytes: 0 }),
    );
    const signal = testSignal();

    await tool.execute(
      executionInput({ cmd: "echo hi", workdir: "src", tty: true, yield_time_ms: 3000 }, { signal }),
    );

    const call = fake.calls.execute[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      environment: ENVIRONMENT,
      command: "echo hi",
      workdir: "src",
      tty: true,
      yieldTimeMs: 3000,
      signal,
    });
    expect(typeof call["ownerRunId"]).toBe("string");
    expect(typeof call["onOutput"]).toBe("function");
  });

  it("defaults tty to false and yield time to the Runtime default", async () => {
    const { tool, fake } = toolWith(executed({ status: "EXITED", exitCode: 0 }));

    await tool.execute(executionInput({ cmd: "echo hi" }));

    expect(fake.calls.execute[0]).toMatchObject({ tty: false, yieldTimeMs: 10000 });
    expect(Object.hasOwn(fake.calls.execute[0] as object, "workdir")).toBe(false);
  });

  it("reports a RUNNING process with its session and no exit code", async () => {
    const { tool } = toolWith(
      executed({
        status: "RUNNING",
        sessionId: "session-1",
        output: "partial",
        totalOutputBytes: 7,
        omittedBytes: 1,
      }),
    );

    const result = await tool.execute(executionInput({ cmd: "sleep 30" }));

    expect(result).toMatchObject({
      isError: false,
      content: "partial\n\nProcess is still running (session_id=session-1).",
      details: {
        ok: true,
        status: "RUNNING",
        sessionId: "session-1",
        totalOutputBytes: 7,
        omittedBytes: 1,
        tty: false,
        workdir: ".",
      },
    });
    expect(result.details).not.toHaveProperty("exitCode");
  });

  it("reports an EXITED process with its exit code and signal", async () => {
    const { tool } = toolWith(
      executed({ status: "EXITED", exitCode: 3, signal: "SIGTERM", output: "bye" }),
    );

    const result = await tool.execute(executionInput({ cmd: "exit 3" }));

    expect(result).toMatchObject({
      isError: false,
      content: "bye\n\nProcess exited with exit code 3 by signal SIGTERM.",
      details: { status: "EXITED", exitCode: 3, signal: "SIGTERM" },
    });
  });

  it("renders a no-output exit as '(no new output)'", async () => {
    const { tool } = toolWith(executed({ status: "EXITED" }));

    await expect(tool.execute(executionInput({ cmd: "true" }))).resolves.toMatchObject({
      isError: false,
      content: "(no new output)\n\nProcess exited.",
      details: { status: "EXITED" },
    });
  });

  it("projects the port's onOutput onto the canonical transient update channel", async () => {
    const published: unknown[] = [];
    const { tool } = toolWith(async (input) => {
      input.onOutput?.("stdout", "one ");
      input.onOutput?.("stderr", "two");
      return { status: "EXITED", exitCode: 0 } as never;
    });

    await tool.execute(
      executionInput({ cmd: "echo" }, { publish: (update) => published.push(update) }),
    );

    expect(published).toEqual([
      { kind: "OUTPUT", stream: "stdout", chunk: "one " },
      { kind: "OUTPUT", stream: "stderr", chunk: "two" },
    ]);
  });

  it("refuses an invalid command, workdir, tty or yield time without calling the port", async () => {
    const { tool, fake } = toolWith(executed({ status: "EXITED" }));

    for (const value of [{}, { cmd: 42 }, { cmd: "x", workdir: 7 }, { cmd: "x", tty: "yes" }]) {
      const result = await tool.execute(executionInput(value));
      expect(result).toMatchObject({
        isError: true,
        content: "Tool operation failed: INVALID_COMMAND.",
        details: { ok: false, error: "INVALID_COMMAND" },
      });
    }
    for (const yield_time_ms of [0, 249, 30001, 1.5, "3000"]) {
      const result = await tool.execute(executionInput({ cmd: "x", yield_time_ms }));
      expect(result).toMatchObject({
        isError: true,
        content: "Tool operation failed: INVALID_YIELD_TIME.",
        details: { error: "INVALID_YIELD_TIME" },
      });
    }
    expect(fake.calls.execute).toEqual([]);
  });

  it("maps a failed spawn to an ordinary safe failure", async () => {
    const { tool } = toolWith(async () => {
      throw new RuntimeExecError("SPAWN_FAILED");
    });

    await expect(tool.execute(executionInput({ cmd: "nope" }))).resolves.toMatchObject({
      isError: true,
      details: { ok: false, error: "SPAWN_FAILED" },
    });
  });

  it("converts a stale or uncertain process session into the canonical uncertain signal", async () => {
    const stale = toolWith(async () => {
      throw new RuntimeProcessStaleSessionError("a previous runtime generation");
    }).tool;
    const uncertain = toolWith(async () => {
      throw new RuntimeProcessUncertainError("the process fate is unknown");
    }).tool;
    const invariant = toolWith(async () => {
      throw new RuntimeInvariantError("guarantee violated");
    }).tool;

    await expect(stale.execute(executionInput({ cmd: "x" }))).rejects.toBeInstanceOf(
      ToolExecutionUncertainError,
    );
    await expect(uncertain.execute(executionInput({ cmd: "x" }))).rejects.toBeInstanceOf(
      ToolExecutionUncertainError,
    );
    await expect(invariant.execute(executionInput({ cmd: "x" }))).rejects.toBeInstanceOf(
      RuntimeInvariantError,
    );
  });

  it("produces SHELL_STARTED plus either PROCESS_STARTED or SHELL_COMPLETED", () => {
    const { definition } = toolWith(executed({ status: "EXITED" }));
    const request = { invocationId: "inv-1" as never, externalCallId: "c", args: {} };

    expect(
      definition.effectProjector?.({
        request,
        result: {
          content: "x",
          details: { ok: true, status: "RUNNING", sessionId: "s1" },
          isError: false,
        },
        now: 1,
      }),
    ).toEqual([
      { type: "SHELL_STARTED", invocationId: "inv-1" },
      { type: "PROCESS_STARTED", sessionId: "s1" },
    ]);

    expect(
      definition.effectProjector?.({
        request,
        result: {
          content: "x",
          details: { ok: true, status: "EXITED", exitCode: 0, signal: "SIGKILL" },
          isError: false,
        },
        now: 1,
      }),
    ).toEqual([
      { type: "SHELL_STARTED", invocationId: "inv-1" },
      { type: "SHELL_COMPLETED", invocationId: "inv-1", exitCode: 0, signal: "SIGKILL" },
    ]);

    expect(
      definition.effectProjector?.({
        request,
        result: { content: "x", details: { ok: false, error: "INVALID_COMMAND" }, isError: true },
        now: 1,
      }),
    ).toEqual([]);
  });

  it("projects a SHELL_COMMAND fact and a COMMAND secret-scan input", () => {
    const { definition } = toolWith(executed({ status: "EXITED" }));

    expect(definition.securityFactsProjector?.({ cmd: "rm -rf build", workdir: "src" })).toEqual({
      resourceAccesses: [],
      shellCommand: { command: "rm -rf build", workdir: "src", tty: false },
      secretScanInputs: [{ kind: "COMMAND", text: "rm -rf build" }],
      structuralPreview: {
        kind: "SHELL_COMMAND",
        command: "rm -rf build",
        workdir: "src",
        tty: false,
      },
    });
  });
});
