import { describe, expect, it } from "vitest";
import { DAEMON_VERSION } from "../src/version.js";

describe("daemon version", () => {
  it("comes from daemon package metadata", () => {
    expect(DAEMON_VERSION).toBe("1.0.1");
    expect(DAEMON_VERSION).not.toBe("");
  });
});
