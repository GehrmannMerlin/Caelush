import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rotateDaemonLog, safeDaemonLogLine } from "../src/logs.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("daemon logs", () => {
  it("rotates at the bounded size and sanitizes secret-shaped values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-logs-"));
    directories.push(directory);
    const logPath = join(directory, "daemon.log");
    writeFileSync(logPath, "x".repeat(32));

    await rotateDaemonLog(logPath, 32);
    expect(readFileSync(`${logPath}.1`, "utf8")).toHaveLength(32);
    expect(safeDaemonLogLine("CAELUSH_PROVIDER_API_KEY=secret-value")).toBe(
      "CAELUSH_PROVIDER_API_KEY=[redacted]",
    );
  });
});
