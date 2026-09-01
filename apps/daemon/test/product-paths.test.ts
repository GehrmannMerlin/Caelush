import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProductPaths } from "../src/product-paths.js";

describe("product paths", () => {
  it("keeps all user-owned paths under one configurable product home", () => {
    const paths = resolveProductPaths({
      environment: { CAELUSH_HOME: "C:/test/caelush" },
      homeDirectory: homedir(),
    });

    expect(paths).toEqual({
      rootDirectory: "C:/test/caelush",
      databasePath: join("C:/test/caelush", "caelush.db"),
      runDirectory: join("C:/test/caelush", "run"),
      startupLockDirectory: join("C:/test/caelush", "run", "daemon-start.lock"),
      logsDirectory: join("C:/test/caelush", "logs"),
      daemonLogPath: join("C:/test/caelush", "logs", "daemon.log"),
    });
  });

  it("uses the supplied home directory when no override is present", () => {
    expect(
      resolveProductPaths({ environment: {}, homeDirectory: "C:/users/example" }).rootDirectory,
    ).toBe(join("C:/users/example", ".caelush"));
  });
});
