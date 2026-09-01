import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  MAX_PRINT_INPUT_BYTES,
  PrintInputError,
  readPrintPrompt,
  serializePrintResult,
  shouldEmitPrintEvent,
  type PrintResult,
} from "../src/application/print-host.js";

describe("print host input and output contracts", () => {
  it("accepts strict UTF-8 stdin and treats empty input as no prompt", async () => {
    await expect(
      readPrintPrompt({
        input: Readable.from([Buffer.from("解释这个项目", "utf8")]),
        isTTY: false,
      }),
    ).resolves.toBe("解释这个项目");
    await expect(
      readPrintPrompt({ input: Readable.from([]), isTTY: false }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid or oversized stdin and argument-plus-stdin ambiguity", async () => {
    await expect(
      readPrintPrompt({ input: Readable.from([Buffer.from([0xff])]), isTTY: false }),
    ).rejects.toBeInstanceOf(PrintInputError);
    await expect(
      readPrintPrompt({
        input: Readable.from([Buffer.from("stdin")]),
        isTTY: false,
        argument: "argument",
      }),
    ).rejects.toThrow("Provide the prompt either as an argument or through stdin, not both.");
    await expect(
      readPrintPrompt({
        input: Readable.from([Buffer.alloc(MAX_PRINT_INPUT_BYTES + 1)]),
        isTTY: false,
      }),
    ).rejects.toBeInstanceOf(PrintInputError);
  });

  it("does not read a TTY when the prompt argument is present", async () => {
    const input = Readable.from([]);
    await expect(readPrintPrompt({ input, isTTY: true, argument: "argument" })).resolves.toBe(
      "argument",
    );
  });

  it("treats a missing prompt on a TTY as usage input instead of waiting for stdin", async () => {
    await expect(
      readPrintPrompt({ input: Readable.from([]), isTTY: true }),
    ).resolves.toBeUndefined();
  });

  it("keeps output public and emits only USER_VISIBLE events", () => {
    const result: PrintResult = {
      version: "0.1.0",
      sessionId: "ses_01234567-89ab-7def-8123-456789abcdef",
      runId: "run_01234567-89ab-7def-8123-456789abcdef",
      status: "COMPLETED",
      success: true,
      finalText: "verified answer",
    };
    expect(JSON.parse(serializePrintResult(result))).toEqual(result);
    expect(shouldEmitPrintEvent({ visibility: "USER_VISIBLE" })).toBe(true);
    expect(shouldEmitPrintEvent({ visibility: "DEBUG" })).toBe(false);
    expect(
      serializePrintResult({
        ...result,
        status: "WAITING_APPROVAL",
        success: false,
        requiresApproval: true,
      }),
    ).toContain('"requiresApproval":true');
  });
});
