import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION } from "@caelush/daemon/version";
import { PRODUCT_VERSION } from "../src/version.js";

describe("product version ownership", () => {
  it("keeps launcher, daemon, and repository product versions aligned", () => {
    const launcherManifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    const daemonManifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "daemon", "package.json"), "utf8"),
    ) as { version: string };
    const rootManifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8"),
    ) as { version: string };

    expect(
      new Set([
        PRODUCT_VERSION,
        DAEMON_VERSION,
        launcherManifest.version,
        daemonManifest.version,
        rootManifest.version,
      ]),
    ).toEqual(new Set(["0.1.0"]));
  });
});
