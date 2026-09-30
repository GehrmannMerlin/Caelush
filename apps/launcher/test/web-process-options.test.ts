import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import type { DaemonDiscoveryResult } from "../src/daemon-discovery.js";

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcess);

import { runWebHost } from "../src/web.js";

describe("launcher browser opener", () => {
  it("hides the detached URL opener window", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-launcher-web-opener-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "web");

    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    childProcess.spawn.mockReturnValue(child);
    const workspace = { id: createWorkspaceId() };
    const daemon = {
      mode: "LOCAL_REUSED" as const,
      url: "http://127.0.0.1:43120",
      client: {
        createWorkspace: vi.fn(async () => ({
          id: workspace.id,
          canonicalPath: "C:\\workspace",
          displayName: "workspace",
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1,
        })),
      },
      info: {},
    } as unknown as DaemonDiscoveryResult;

    try {
      await runWebHost({
        webBuildRoot: root,
        ensureDaemon: async () => daemon,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
      });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          detached: true,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        }),
      );
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
