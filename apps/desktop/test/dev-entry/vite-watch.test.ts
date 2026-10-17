import { describe, expect, it } from "vitest";
import config from "../../vite.config.ts";

describe("Desktop Vite file watching", () => {
  it("ignores generated stage files written by the Electron runtime", () => {
    expect(config.server?.watch?.ignored).toEqual(expect.arrayContaining(["**/.stage/**"]));
  });
});
