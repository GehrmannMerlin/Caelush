import { createSessionId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CliArgsError, parseCliArgs } from "../src/bootstrap/cli-args.js";

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
    ["conflicting flags", ["--continue", "--resume"]],
    ["two exact IDs", ["-r", createSessionId(), createSessionId()]],
    ["unknown flag", ["--unknown"]],
    ["malformed Session ID", ["--resume", "not-a-session"]],
    ["missing exact value", ["--resume", ""]],
  ])("rejects %s", (_description, argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliArgsError);
  });
});
