import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import type { DaemonDiscoveryResult } from "../src/daemon-discovery.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { runWebHost } from "../src/web.js";

const daemon = {
  mode: "LOCAL_STARTED" as const,
  url: "http://127.0.0.1:43120",
  client: {
    getHealth: vi.fn(),
    getInfo: vi.fn(),
    createWorkspace: vi.fn(async () => ({
      id: createWorkspaceId(),
      canonicalPath: "D:/Develop/Caelush",
      displayName: "Caelush",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    })),
  },
  info: {} as never,
} satisfies DaemonDiscoveryResult;

describe("launcher Web host", () => {
  it("registers the current workspace and opens its scoped Web URL", async () => {
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
    const workspaceId = daemon.client.createWorkspace.mock.results[0]?.value;
    const registered = await workspaceId;
    const expectedUrl = `http://127.0.0.1:43120/?workspace=${encodeURIComponent(registered.id)}`;
    expect(stdout).toEqual([`${expectedUrl}\n`]);
    expect(openUrl).toHaveBeenCalledWith(expectedUrl);
    expect(daemon.client.createWorkspace).toHaveBeenCalledWith({ path: "D:\\Develop\\Caelush" });
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

  it("registers a new current workspace when the healthy daemon is reused", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-launcher-web-reused-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "web");
    const createWorkspace = vi.fn(async (input: { readonly path: string }) => ({
      id: createWorkspaceId(),
      canonicalPath: input.path,
      displayName: input.path.split(/[\\/]/).at(-1) ?? "workspace",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    }));
    const reusedDaemon = {
      ...daemon,
      mode: "LOCAL_REUSED" as const,
      client: { ...daemon.client, createWorkspace },
    };
    const ensureDaemon = vi.fn(async () => reusedDaemon);
    const stdout: string[] = [];

    await runWebHost({
      workspacePath: "D:\\Develop\\ProjectA",
      webBuildRoot: root,
      ensureDaemon,
      openUrl: vi.fn(),
      writeStdout: (text) => stdout.push(text),
    });
    await runWebHost({
      workspacePath: "D:\\Develop\\ProjectB",
      webBuildRoot: root,
      ensureDaemon,
      openUrl: vi.fn(),
      writeStdout: (text) => stdout.push(text),
    });

    expect(ensureDaemon).toHaveBeenCalledTimes(2);
    expect(createWorkspace.mock.calls.map(([input]) => input.path)).toEqual([
      "D:\\Develop\\ProjectA",
      "D:\\Develop\\ProjectB",
    ]);
    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toContain("?workspace=");
    expect(stdout[1]).toContain("?workspace=");

    await rm(root, { recursive: true, force: true });
  });
});
