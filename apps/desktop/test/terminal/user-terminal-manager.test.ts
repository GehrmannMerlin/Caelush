import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopUserTerminalManager } from "../../src/main/terminal/user-terminal-manager.js";

const workspaceId = createWorkspaceId();
const ownerId = 44;

function terminalFixture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const inputs: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 8821,
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
      return true;
    }),
  });
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      inputs.push(line);
      if (JSON.parse(line).type === "close") queueMicrotask(() => child.emit("exit", 0, null));
    }
  });
  const sent: unknown[] = [];
  const spawned = vi.fn(() => {
    queueMicrotask(() => stdout.write('{"type":"ready"}\n'));
    return child;
  });
  const manager = new DesktopUserTerminalManager({
    authorizeWorkspace: async (id) => {
      return {
        workspaceId: id,
        rootPath: "C:\\Work\\Project",
        userId: "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857",
        profileId: `u_${"a".repeat(64)}`,
        generationId: "9f16de4b-87a8-4f34-9504-a9a55e4f3d32",
        signal: new AbortController().signal,
      };
    },
    nodeExecutablePath: "C:\\Caelush\\node.exe",
    helperPath: "C:\\Caelush\\user-terminal-helper.mjs",
    spawnHelper: spawned,
    sendOutput: (_owner, output) => sent.push(output),
    killProcessTree: vi.fn(async () => child.emit("exit", null, "SIGTERM")),
    platform: "win32",
  });
  return { manager, child, stdin, stdout, sent, spawned, inputs };
}

describe("independent USER_TERMINAL sessions", () => {
  it("starts an opaque session with Main selected cwd and writes only bounded user input", async () => {
    const { manager, spawned, inputs } = terminalFixture();
    await manager.activateWorkspace(ownerId, workspaceId);

    const session = await manager.create({ ownerId, workspaceId, cols: 100, rows: 30 });
    const startMessage = JSON.parse(inputs.shift()!) as {
      type: string;
      cwd: string;
      shell: string;
      cols: number;
      rows: number;
    };

    expect(session.terminalId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(session.identity).toBe("USER_TERMINAL");
    expect(startMessage).toMatchObject({
      type: "start",
      cwd: "C:\\Work\\Project",
      shell: "WINDOWS_POWERSHELL",
      cols: 100,
      rows: 30,
    });
    expect(spawned).toHaveBeenCalledWith({
      nodeExecutablePath: "C:\\Caelush\\node.exe",
      helperPath: "C:\\Caelush\\user-terminal-helper.mjs",
      cwd: "C:\\Work\\Project",
      env: expect.any(Object),
    });

    await manager.write(ownerId, session.terminalId, "Write-Output '你好';\r");
    const input = JSON.parse(inputs.shift()!) as {
      type: string;
      data: string;
    };
    expect(input).toEqual({ type: "write", data: "Write-Output '你好';\r" });
    expect(() => manager.write(ownerId, session.terminalId, "x".repeat(16_385))).toThrowError(
      expect.objectContaining({ code: "TERMINAL_INPUT_TOO_LARGE" }),
    );
  });

  it("binds resize, close, and output subscription to the owning renderer", async () => {
    const { manager, child, stdout, sent, inputs } = terminalFixture();
    await manager.activateWorkspace(ownerId, workspaceId);
    const session = await manager.create({ ownerId, workspaceId, cols: 80, rows: 24 });
    inputs.shift();

    expect(() => manager.write(ownerId + 1, session.terminalId, "whoami\r")).toThrowError(
      expect.objectContaining({ code: "TERMINAL_SESSION_INVALID" }),
    );
    expect(() => manager.resize(ownerId, session.terminalId, { cols: 1, rows: 24 })).toThrowError(
      expect.objectContaining({ code: "TERMINAL_RESIZE_INVALID" }),
    );
    await manager.resize(ownerId, session.terminalId, { cols: 120, rows: 40 });
    expect(JSON.parse(inputs.shift()!)).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    });

    manager.subscribeOutput(ownerId, session.terminalId);
    const vtSequence = "\u001b[32mPS>\u001b[0m \u001b]52;c;blocked\u0007";
    stdout.write(`${JSON.stringify({ type: "output", data: vtSequence })}\n`);
    expect(sent).toContainEqual({ terminalId: session.terminalId, data: vtSequence });

    await manager.close(ownerId, session.terminalId);
    expect(child.kill).not.toHaveBeenCalled();
    expect(() => manager.write(ownerId + 1, session.terminalId, "whoami\r")).toThrowError(
      expect.objectContaining({ code: "TERMINAL_SESSION_INVALID" }),
    );
  });

  it("limits concurrent sessions and closes them when the bound Workspace changes", async () => {
    const { manager, spawned } = terminalFixture();
    await manager.activateWorkspace(ownerId, workspaceId);
    const first = await manager.create({ ownerId, workspaceId, cols: 80, rows: 24 });
    await manager.subscribeOutput(ownerId, first.terminalId);

    await manager.activateWorkspace(ownerId, createWorkspaceId());

    expect(spawned).toHaveBeenCalledOnce();
    expect(() => manager.write(ownerId, first.terminalId, "whoami\r")).toThrowError(
      expect.objectContaining({ code: "TERMINAL_SESSION_INVALID" }),
    );
  });
});
