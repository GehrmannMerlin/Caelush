import { createWriteStdinTool } from "@caelush/coding-agent";
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
 * `write_stdin` — the target Coding builtin.
 *
 * The empty poll is the case worth pinning: `chars` omitted or empty is a *poll*, not a write, and the
 * yield resolver is told which it is. A Tool that treated an empty poll as a write would either change
 * the wait or send a spurious empty line.
 */

function toolWith(interact: Parameters<typeof processFake>[0]["interact"]) {
  const fake = processFake({ execute: async () => ({}) as never, interact });
  const definition = createWriteStdinTool(fake.process);
  return { tool: definition.tool, definition, fake };
}

function interacted(result: Record<string, unknown>) {
  return async () => result as never;
}

describe("write_stdin target builtin", () => {
  it("declares the frozen name, description, schema and defaults", () => {
    const { tool, definition } = toolWith(interacted({ status: "EXITED" }));

    expect(tool.name).toBe("write_stdin");
    expect(tool.description).toBe("Poll process.");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, description: "Opaque process session ID." },
        chars: {
          type: "string",
          default: "",
          description: "Characters to write; omit or use empty text to poll.",
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
      required: ["session_id"],
      additionalProperties: false,
    });
    expect(definition.security).toEqual({
      riskLevel: "CRITICAL",
      requiredCapabilities: ["SHELL_EXEC", "PROCESS_START", "PROCESS_KILL"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.promptSnippet).toContain("write_stdin");
  });

  it("sends a poll as empty chars with the polling yield default", async () => {
    const { tool, fake } = toolWith(interacted({ status: "RUNNING", sessionId: "s1" }));
    const signal = testSignal();

    await tool.execute(executionInput({ session_id: "s1" }, { signal }));

    const call = fake.calls.interact[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      environment: ENVIRONMENT,
      sessionId: "s1",
      chars: "",
      signal,
    });
    // A poll waits the longer default so an idle process gets a real chance to produce output.
    expect(call["yieldTimeMs"]).toBe(5000);
    expect(typeof call["ownerRunId"]).toBe("string");
    expect(typeof call["onOutput"]).toBe("function");
  });

  it("sends explicit chars with the writing yield default", async () => {
    const { tool, fake } = toolWith(interacted({ status: "RUNNING", sessionId: "s1" }));

    await tool.execute(executionInput({ session_id: "s1", chars: "yes\n" }));

    // A write waits far less than a poll: the caller has something to say, so it does not need the long
    // idle window that makes a poll useful.
    expect(fake.calls.interact[0]).toMatchObject({ chars: "yes\n", yieldTimeMs: 250 });
  });

  it("honours an explicit yield time", async () => {
    const { tool, fake } = toolWith(interacted({ status: "RUNNING", sessionId: "s1" }));

    await tool.execute(executionInput({ session_id: "s1", yield_time_ms: 250 }));

    expect(fake.calls.interact[0]).toMatchObject({ yieldTimeMs: 250 });
  });

  it("reports a still-running process", async () => {
    const { tool } = toolWith(
      interacted({ status: "RUNNING", sessionId: "s1", output: "more", totalOutputBytes: 4 }),
    );

    await expect(tool.execute(executionInput({ session_id: "s1" }))).resolves.toMatchObject({
      isError: false,
      content: "more\n\nProcess is still running (session_id=s1).",
      details: { ok: true, status: "RUNNING", sessionId: "s1", tty: false },
    });
  });

  it("reports an ended process with the fields the legacy Tool reported", async () => {
    const { tool } = toolWith(
      interacted({
        status: "EXITED",
        sessionId: "s1",
        exitCode: 0,
        signal: "KILLED",
        output: "done",
        totalOutputBytes: 4,
        omittedBytes: 0,
        tty: true,
        durationMs: 12,
        charsAcceptedBytes: 4,
      }),
    );

    await expect(tool.execute(executionInput({ session_id: "s1" }))).resolves.toMatchObject({
      isError: false,
      content: "done\n\nProcess exited with exit code 0.",
      details: {
        ok: true,
        status: "EXITED",
        sessionId: "s1",
        exitCode: 0,
        signal: "KILLED",
        tty: true,
        durationMs: 12,
        charsAcceptedBytes: 4,
      },
    });
  });

  it("renders a no-output poll as '(no new output)'", async () => {
    const { tool } = toolWith(interacted({ status: "RUNNING", sessionId: "s1" }));

    await expect(tool.execute(executionInput({ session_id: "s1" }))).resolves.toMatchObject({
      isError: false,
      content: "(no new output)\n\nProcess is still running (session_id=s1).",
    });
  });

  it("projects the port's onOutput onto the canonical transient update channel", async () => {
    const published: unknown[] = [];
    const { tool } = toolWith(async (input) => {
      input.onOutput?.("stdout", "tick");
      return { status: "RUNNING", sessionId: "s1" } as never;
    });

    await tool.execute(
      executionInput({ session_id: "s1" }, { publish: (update) => published.push(update) }),
    );

    expect(published).toEqual([{ kind: "OUTPUT", stream: "stdout", chunk: "tick" }]);
  });

  it("refuses a missing session or a malformed chars/yield without calling the port", async () => {
    const { tool, fake } = toolWith(interacted({ status: "RUNNING" }));

    for (const value of [{}, { session_id: 42 }]) {
      const result = await tool.execute(executionInput(value));
      expect(result).toMatchObject({
        isError: true,
        content: "Tool operation failed: PROCESS_SESSION_NOT_FOUND.",
        details: { ok: false, error: "PROCESS_SESSION_NOT_FOUND" },
      });
    }
    for (const chars of [7, null]) {
      const result = await tool.execute(executionInput({ session_id: "s1", chars }));
      expect(result).toMatchObject({ isError: true, details: { error: "INVALID_STDIN" } });
    }
    for (const yield_time_ms of [0, 249, 30001, 1.5]) {
      const result = await tool.execute(executionInput({ session_id: "s1", yield_time_ms }));
      expect(result).toMatchObject({ isError: true, details: { error: "INVALID_YIELD_TIME" } });
    }
    expect(fake.calls.interact).toEqual([]);
  });

  it("maps an unknown session to its safe code", async () => {
    const { tool } = toolWith(async () => {
      throw new RuntimeExecError("PROCESS_SESSION_NOT_FOUND");
    });

    await expect(tool.execute(executionInput({ session_id: "nope" }))).resolves.toMatchObject({
      isError: true,
      details: { ok: false, error: "PROCESS_SESSION_NOT_FOUND" },
    });
  });

  it("converts a stale or uncertain session into the canonical uncertain signal", async () => {
    const stale = toolWith(async () => {
      throw new RuntimeProcessStaleSessionError("a previous runtime generation");
    }).tool;
    const uncertain = toolWith(async () => {
      throw new RuntimeProcessUncertainError("the process fate is unknown");
    }).tool;
    const invariant = toolWith(async () => {
      throw new RuntimeInvariantError("guarantee violated");
    }).tool;

    await expect(stale.execute(executionInput({ session_id: "s1" }))).rejects.toBeInstanceOf(
      ToolExecutionUncertainError,
    );
    await expect(uncertain.execute(executionInput({ session_id: "s1" }))).rejects.toBeInstanceOf(
      ToolExecutionUncertainError,
    );
    await expect(invariant.execute(executionInput({ session_id: "s1" }))).rejects.toBeInstanceOf(
      RuntimeInvariantError,
    );
  });

  it("produces PROCESS_STOPPED only when an interaction proved the process ended", () => {
    const { definition } = toolWith(interacted({ status: "RUNNING" }));
    const request = { invocationId: "inv" as never, externalCallId: "c", args: { session_id: "s1" } };
    const result = (details: Record<string, unknown>, isError = false) =>
      ({ content: "x", details, isError }) as never;

    expect(
      definition.effectProjector?.({
        request,
        result: result({ ok: true, status: "EXITED", signal: "KILLED" }),
        now: 1,
      }),
    ).toEqual([{ type: "PROCESS_STOPPED", sessionId: "s1", status: "KILLED" }]);

    expect(
      definition.effectProjector?.({
        request,
        result: result({ ok: true, status: "EXITED", exitCode: 0 }),
        now: 1,
      }),
    ).toEqual([{ type: "PROCESS_STOPPED", sessionId: "s1" }]);

    expect(
      definition.effectProjector?.({
        request,
        result: result({ ok: true, status: "RUNNING" }),
        now: 1,
      }),
    ).toEqual([]);

    expect(
      definition.effectProjector?.({
        request,
        result: result({ ok: false, error: "INVALID_STDIN" }, true),
        now: 1,
      }),
    ).toEqual([]);
  });

  it("projects a PROCESS_INPUT preview with the input byte count and a STDIN secret-scan input", () => {
    const { definition } = toolWith(interacted({ status: "RUNNING" }));

    expect(definition.securityFactsProjector?.({ session_id: "s1", chars: "abc" })).toEqual({
      resourceAccesses: [],
      secretScanInputs: [{ kind: "STDIN", text: "abc" }],
      structuralPreview: { kind: "PROCESS_INPUT", sessionId: "s1", inputBytes: 3 },
    });
  });
});
