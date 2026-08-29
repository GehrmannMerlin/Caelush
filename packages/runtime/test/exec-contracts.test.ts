import { describe, expect, it } from "vitest";
import {
  MAX_EXEC_COMMAND_BYTES,
  MAX_EXEC_MODEL_OUTPUT_BYTES,
  MAX_EXEC_STDIN_BYTES,
  MAX_EXEC_YIELD_TIME_MS,
  MIN_EXEC_YIELD_TIME_MS,
  RuntimeExecError,
  type RuntimeExecRequest,
  type RuntimeExecResult,
  type RuntimeExecService,
  type RuntimeProcessInteractionRequest,
} from "../src/index.js";
import type { RunId } from "@caelush/protocol";

describe("runtime exec contracts", () => {
  it("keeps execution contracts JSON-safe and provider-independent", () => {
    const request: RuntimeExecRequest = {
      ownerRunId: "run_1" as RunId,
      command: "printf ready",
      tty: false,
      yieldTimeMs: 250,
    };
    const interaction: RuntimeProcessInteractionRequest = {
      ownerRunId: request.ownerRunId,
      sessionId: "proc_generation_random",
      chars: "",
      yieldTimeMs: 5000,
    };
    const result: RuntimeExecResult = {
      status: "EXITED",
      output: "ready",
      exitCode: 0,
      totalOutputBytes: 5,
      omittedBytes: 0,
    };
    const service: RuntimeExecService = {
      execute: async () => result,
      interact: async () => result,
    };

    expect(JSON.parse(JSON.stringify({ request, interaction, result }))).toEqual({
      request,
      interaction,
      result,
    });
    expect(service).toBeDefined();
  });

  it("publishes bounded execution constants and stable typed errors", () => {
    expect(MAX_EXEC_COMMAND_BYTES).toBe(64 * 1024);
    expect(MAX_EXEC_STDIN_BYTES).toBe(64 * 1024);
    expect(MAX_EXEC_MODEL_OUTPUT_BYTES).toBe(48 * 1024);
    expect(MIN_EXEC_YIELD_TIME_MS).toBe(250);
    expect(MAX_EXEC_YIELD_TIME_MS).toBe(30_000);

    const error = new RuntimeExecError("PROCESS_SESSION_NOT_FOUND");
    expect(error.code).toBe("PROCESS_SESSION_NOT_FOUND");
    expect(error.message).toBe("PROCESS_SESSION_NOT_FOUND");
  });
});
