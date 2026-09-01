import { createSessionId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CliArgsError, parseCliArgs } from "../src/bootstrap/cli-args.js";

const printSessionId = "ses_01234567-89ab-7def-8123-456789abcdef";

describe("CLI launch arguments", () => {
  it.each([
    [[], { kind: "NEW" }],
    [["-c"], { kind: "CONTINUE" }],
    [["--continue"], { kind: "CONTINUE" }],
    [["-r"], { kind: "RESUME_PICKER" }],
    [["--resume"], { kind: "RESUME_PICKER" }],
  ])("parses %j", (argv, expected) => {
    expect(parseCliArgs(argv)).toEqual(expected);
  });

  it("parses an exact Session ID", () => {
    const sessionId = createSessionId();

    expect(parseCliArgs(["-r", sessionId])).toEqual({ kind: "RESUME_EXACT", sessionId });
    expect(parseCliArgs(["--resume", sessionId])).toEqual({ kind: "RESUME_EXACT", sessionId });
  });

  it.each([
    [["-p"], { kind: "PRINT", outputFormat: "text", launchIntent: { kind: "NEW" } }],
    [
      ["--print", "explain this"],
      {
        kind: "PRINT",
        prompt: "explain this",
        outputFormat: "text",
        launchIntent: { kind: "NEW" },
      },
    ],
    [["-c", "-p"], { kind: "PRINT", outputFormat: "text", launchIntent: { kind: "CONTINUE" } }],
    [
      ["-r", printSessionId, "-p", "--output-format", "json"],
      {
        kind: "PRINT",
        prompt: undefined,
        outputFormat: "json",
        launchIntent: { kind: "RESUME_EXACT", sessionId: printSessionId },
      },
    ],
  ])("parses print mode %j", (argv, expected) => {
    expect(parseCliArgs(argv)).toEqual(expected);
  });

  it.each([
    ["conflicting flags", ["--continue", "--resume"]],
    ["two exact IDs", ["-r", createSessionId(), createSessionId()]],
    ["unknown flag", ["--unknown"]],
    ["malformed Session ID", ["--resume", "not-a-session"]],
    ["missing exact value", ["--resume", ""]],
    ["resume picker with print", ["--resume", "-p"]],
    ["output format without print", ["--output-format", "json"]],
    ["unknown output format", ["-p", "prompt", "--output-format", "yaml"]],
    ["duplicate print", ["-p", "-p"]],
    ["multiple prompts", ["-p", "one", "two"]],
  ])("rejects %s", (_description, argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliArgsError);
  });
});
