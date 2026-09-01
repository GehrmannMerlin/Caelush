import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DaemonDiscoveryResult } from "../src/daemon-discovery.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { runWebHost } from "../src/web.js";

const daemon = {
  mode: "LOCAL_STARTED" as const,
  url: "http://127.0.0.1:43120",
  client: { getHealth: vi.fn(), getInfo: vi.fn() },
  info: {} as never,
} satisfies DaemonDiscoveryResult;

describe("launcher Web host", () => {
  it("passes the current workspace and Web build root to daemon discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-launcher-web-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "web");
    const ensureDaemon = vi.fn(async () => daemon);
    const stdout: string[] = [];
    const openUrl = vi.fn();

    const result = await runWebHost({
      environment: { CAELUSH_PROVIDER_API_KEY: "must-not-be-printed" },
      workspacePath: "D:\\Develop\\Caelush",
      webBuildRoot: root,
      ensureDaemon,
      openUrl,
      writeStdout: (text) => stdout.push(text),
    });

    expect(result).toBe(EXIT_CODES.SUCCESS);
    expect(stdout).toEqual(["http://127.0.0.1:43120/\n"]);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:43120/");
    expect(ensureDaemon).toHaveBeenCalledWith({
      environment: {
        CAELUSH_PROVIDER_API_KEY: "must-not-be-printed",
        CAELUSH_WORKSPACE_PATH: "D:\\Develop\\Caelush",
        CAELUSH_WEB_BUILD_ROOT: root,
      },
    });
    expect(stdout.join(" ")).not.toContain("must-not-be-printed");

    await rm(root, { recursive: true, force: true });
  });

  it("fails safely before daemon discovery when the Web build is absent", async () => {
    const ensureDaemon = vi.fn(async () => daemon);
    const stderr: string[] = [];

    const result = await runWebHost({
      webBuildRoot: join(tmpdir(), "caelush-web-assets-do-not-exist"),
      ensureDaemon,
      writeStderr: (text) => stderr.push(text),
    });

    expect(result).toBe(EXIT_CODES.BOOTSTRAP_FAILURE);
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(stderr.join(" ")).toBe("Caelush Web assets are unavailable. Run the Web build first.\n");
  });
});
