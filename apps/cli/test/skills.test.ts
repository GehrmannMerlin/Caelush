import { describe, expect, it } from "vitest";
import { CliArgsError, parseCliArgs } from "../src/bootstrap/cli-args.js";

describe("CLI explicit Skill arguments", () => {
  it("parses repeatable names onto the Run launch intent", () => {
    expect(parseCliArgs(["--skill", "review-notes", "--skill", "release-checklist"])).toEqual({
      kind: "NEW",
      skillNames: ["review-notes", "release-checklist"],
    });
  });

  it("preserves Skills inside a print command's launch intent", () => {
    expect(parseCliArgs(["-p", "inspect this", "--skill", "review-notes"])).toEqual({
      kind: "PRINT",
      prompt: "inspect this",
      outputFormat: "text",
      launchIntent: { kind: "NEW", skillNames: ["review-notes"] },
    });
  });

  it("keeps no-Skill launch arguments unchanged", () => {
    expect(parseCliArgs(["--continue"])).toEqual({ kind: "CONTINUE" });
  });

  it.each([["--skill"], ["--skill", ""], ["--skill", "../private"]])(
    "rejects a missing or invalid Skill name: %j",
    (...argv) => expect(() => parseCliArgs(argv)).toThrow(CliArgsError),
  );
});
