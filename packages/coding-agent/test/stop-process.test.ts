import { createStopProcessTool } from "@caelush/coding-agent";
import { ToolExecutionUncertainError } from "@caelush/agent";
import {
  RuntimeInvariantError,
  RuntimeExecError,
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
} from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT,
  executionInput,
  processFake,
  testSignal,
} from "./support/operations-fixtures.js";

/**
 * `stop_process` — the owner-scoped Coding builtin.
 *
 * ```text
 * exec_command   start a process   →  session_id
 * write_stdin    observe it       →  output + status
 * stop_process   end it           →  EXITED / KILLED
 * ```
 *
 * Two things are worth pinning hard here, because they are the entire reason the Tool exists:
 *
 * - the input is a **session handle and nothing else** — the Tool never forwards a pid, an image name,
 *   a wildcard or a model-claimed owner, so the Runtime's `sessionId + ownerRunId` authority is the only
 *   thing that can decide whether a process may be stopped;
 * - an unconfirmable termination maps to the canonical **uncertain** signal, never to an ordinary
 *   failure a model would simply retry.
 */

/** The termination port the Tool under test calls. */
type Terminate = NonNullable<Parameters<typeof processFake>[0]["terminate"]>;

function toolWith(terminate: Terminate) {
  const fake = processFake({
    execute: async () => ({}) as never,
    interact: async () => ({}) as never,
    terminate,
  });
  const definition = createStopProcessTool(fake.process);
  return { tool: definition.tool, definition, fake };
}

function terminated(result: Record<string, unknown>) {
  return async () => result as never;
}

describe("stop_process target builtin", () => {
  it("declares the frozen name, description, schema and security", () => {
    const { tool, definition } = toolWith(terminated({ status: "EXITED" }));

    expect(tool.name).toBe("stop_process");
    expect(tool.description).toBe("Stop managed process.");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        session_id: {
          type: "string",
          minLength: 1,
          description: "Opaque managed process session ID returned by exec_command.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    });
    // Capability judgement: the Tool can only ever *end* a process. It cannot start one and cannot run
    // a command, so borrowing `SHELL_EXEC`/`PROCESS_START` from `exec_command` would overstate it.
    expect(definition.security).toEqual({
      riskLevel: "CRITICAL",
      requiredCapabilities: ["PROCESS_KILL"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.promptSnippet).toContain("stop_process");
  });

  it("forwards only the owned session handle — the owner comes from the execution identity", async () => {
    const { tool, fake } = toolWith(terminated({ status: "EXITED", sessionId: "s1" }));
    const signal = testSignal();

    await tool.execute(executionInput({ session_id: "s1" }, { runId: "run_owner", signal }));

    const call = fake.calls.terminate[0] as Record<string, unknown>;
    expect(call).toMatchObject({ environment: ENVIRONMENT, ownerRunId: "run_owner", sessionId: "s1" });
    // The exact key set is the contract: no pid, no image name, no wildcard, no `all`.
    expect(Object.keys(call).sort()).toEqual(["environment", "ownerRunId", "sessionId"]);
  });

  it("ignores a model-supplied owner, pid or image name instead of trusting it", async () => {
    const { tool, fake } = toolWith(terminated({ status: "EXITED", sessionId: "s1" }));

    await tool.execute(
      executionInput(
        {
          session_id: "s1",
          ownerRunId: "run_someone_else",
          owner_run_id: "run_someone_else",
          pid: 4242,
          name: "node",
          all: true,
        },
        { runId: "run_owner" },
      ),
    );

    const call = fake.calls.terminate[0] as Record<string, unknown>;
    expect(call).toMatchObject({ ownerRunId: "run_owner", sessionId: "s1" });
    expect(Object.keys(call).sort()).toEqual(["environment", "ownerRunId", "sessionId"]);
    expect(call["pid"]).toBeUndefined();
    expect(call["name"]).toBeUndefined();
  });

  it("reports a confirmed termination with the signal the Runtime proved", async () => {
    const { tool } = toolWith(
      terminated({
        status: "EXITED",
        sessionId: "s1",
        signal: "KILLED",
        output: "shutting down",
        totalOutputBytes: 13,
        omittedBytes: 0,
        tty: false,
        durationMs: 12,
      }),
    );

    await expect(tool.execute(executionInput({ session_id: "s1" }))).resolves.toEqual({
      isError: false,
      content: "shutting down\n\nProcess terminated (session_id=s1, signal KILLED).",
      details: {
        ok: true,
        status: "EXITED",
        sessionId: "s1",
        signal: "KILLED",
        totalOutputBytes: 13,
        omittedBytes: 0,
        tty: false,
        durationMs: 12,
      },
    });
  });

  it("reports an exit code when that is what the Runtime saw", async () => {
    const { tool } = toolWith(
      terminated({ status: "EXITED", sessionId: "s1", exitCode: 0, output: "stopped" }),
    );

    await expect(tool.execute(executionInput({ session_id: "s1" }))).resolves.toEqual({
      isError: false,
      content: "stopped\n\nProcess terminated (session_id=s1, exit code 0).",
      details: {
        ok: true,
        status: "EXITED",
        sessionId: "s1",
        exitCode: 0,
        totalOutputBytes: 0,
        omittedBytes: 0,
        tty: false,
      },
    });
  });

  it("reports a still-running process without pretending it ended", async () => {
    const { tool } = toolWith(terminated({ status: "RUNNING", sessionId: "s1" }));

    await expect(tool.execute(executionInput({ session_id: "s1" }))).resolves.toEqual({
      isError: false,
      content: "(no new output)\n\nProcess is still running (session_id=s1).",
      details: {
        ok: true,
        status: "RUNNING",
        sessionId: "s1",
        totalOutputBytes: 0,
        omittedBytes: 0,
        tty: false,
      },
    });
  });

  it("refuses a missing or empty session id without calling the port", async () => {
    const { tool, fake } = toolWith(terminated({ status: "EXITED" }));

    for (const value of [{}, { session_id: "" }, { session_id: 42 }, { session_id: null }]) {
      const result = await tool.execute(executionInput(value));
      expect(result).toEqual({
        isError: true,
        content: "Tool operation failed: PROCESS_SESSION_NOT_FOUND.",
        details: { ok: false, error: "PROCESS_SESSION_NOT_FOUND" },
      });
    }
    expect(fake.calls.terminate).toEqual([]);
  });

  it("maps an unknown session to its safe code", async () => {
    const { tool } = toolWith(async () => {
      throw new RuntimeExecError("PROCESS_SESSION_NOT_FOUND");
    });

    await expect(tool.execute(executionInput({ session_id: "nope" }))).resolves.toEqual({
      isError: true,
      content: "Tool operation failed: PROCESS_SESSION_NOT_FOUND.",
      details: { ok: false, error: "PROCESS_SESSION_NOT_FOUND" },
    });
  });

  it("converts a stale or unconfirmable termination into the canonical uncertain signal", async () => {
    const stale = toolWith(async () => {
      throw new RuntimeProcessStaleSessionError();
    }).tool;
    const uncertain = toolWith(async () => {
      throw new RuntimeProcessUncertainError();
    }).tool;
    const invariant = toolWith(async () => {
      throw new RuntimeInvariantError("guarantee violated");
    }).tool;

    // A foreign session is refused without disclosing whose it is; the model is told to stop, not retry.
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

  it("emits PROCESS_STOPPED only for a confirmed termination", () => {
    const { definition } = toolWith(terminated({ status: "EXITED" }));
    const request = {
      invocationId: "inv" as never,
      externalCallId: "c",
      args: { session_id: "s1" },
    };
    const result = (details: Record<string, unknown>, isError = false) =>
      ({ content: "x", details, isError }) as never;

    expect(
      definition.effectProjector?.({
        request,
        result: result({ ok: true, status: "EXITED", signal: "KILLED" }),
        now: 1,
      }),
    ).toEqual([{ type: "PROCESS_STOPPED", sessionId: "s1", status: "KILLED" }]);

    // Still running: nothing ended, so nothing is claimed.
    expect(
      definition.effectProjector?.({
        request,
        result: result({ ok: true, status: "RUNNING" }),
        now: 1,
      }),
    ).toEqual([]);

    // A failed attempt is not an effect.
    expect(
      definition.effectProjector?.({
        request,
        result: result({ ok: false, error: "PROCESS_SESSION_NOT_FOUND" }, true),
        now: 1,
      }),
    ).toEqual([]);
  });

  it("projects a PROCESS_TERMINATION preview that carries no secret material", () => {
    const { definition } = toolWith(terminated({ status: "EXITED" }));

    expect(definition.securityFactsProjector?.({ session_id: "s1" })).toEqual({
      resourceAccesses: [],
      secretScanInputs: [],
      structuralPreview: { kind: "PROCESS_TERMINATION", sessionId: "s1" },
    });

    expect(() => definition.securityFactsProjector?.({ session_id: 42 })).toThrow();
    expect(() => definition.securityFactsProjector?.({})).toThrow();
  });
});
