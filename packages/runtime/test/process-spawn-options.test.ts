import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcess);

import { createPipeProcessAdapter } from "../src/exec/pipe-process-adapter.js";
import { LocalGitRunner } from "../src/git/git-runner.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    readonly stdin: {
      destroyed: boolean;
      write: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    readonly stdout: EventEmitter;
    readonly stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(child, {
    stdin: {
      destroyed: false,
      write: vi.fn(),
      destroy: vi.fn(),
    },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    killed: false,
    kill: vi.fn(),
  });
  return child;
}

describe("Windows child-process launch options", () => {
  beforeEach(() => {
    childProcess.spawn.mockReset();
  });

  it("hides the ordinary Runtime process window", async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const adapter = await createPipeProcessAdapter({
      launch: { executable: "powershell.exe", args: ["-NoProfile", "-Command", "Write-Output ok"] },
      cwd: "C:\\workspace",
      env: {},
    });

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoProfile", "-Command", "Write-Output ok"],
      expect.objectContaining({
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
    await adapter.close();
  });

  it("hides the Git process window", async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const result = new LocalGitRunner().run({
      cwd: "C:\\workspace",
      args: ["status", "--short"],
    });
    child.emit("close", 0, null);

    await expect(result).resolves.toMatchObject({ exitCode: 0 });
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "git",
      ["status", "--short"],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
  });
});
