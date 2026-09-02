import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_VERSION } from "../src/version.js";
import { HELP_TEXT } from "../src/help.js";

describe("static product commands", () => {
  it("uses package metadata as the product version", () => {
    expect(PRODUCT_VERSION).toBe("0.1.0");
  });

  it("documents the product command and all supported launch forms", () => {
    for (const fragment of [
      "caelush",
      "caelush --continue",
      "caelush --resume",
      "caelush --resume <SESSION_ID>",
      "caelush --print <PROMPT>",
      "caelush doctor",
      "--help",
      "--version",
    ]) {
      expect(HELP_TEXT).toContain(fragment);
    }
  });

  it("keeps the Windows shim on the executable launcher entry", () => {
    const shim = readFileSync(join(import.meta.dirname, "..", "bin", "caelush.cmd"), "utf8");
    expect(shim).toContain("dist\\main.js");
    expect(shim).not.toContain("dist\\index.js");
  });
});
