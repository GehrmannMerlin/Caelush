import { describe, expect, it, vi } from "vitest";
import { registerDesktopIpc } from "../../src/main/ipc/handlers.js";
import { createInitialAccountState } from "../../src/main/account/state.js";
import { safeErrorForIpc } from "../../src/main/ipc/safe-error.js";
import { CaelushClientHttpError } from "@caelush/client";
function fixture(status = "AUTHENTICATED_ONLINE") {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const frame = { url: "caelush-login://app/?view=account&section=archives" };
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const event = { sender, senderFrame: frame };
  const archiveController = {
    listSessions: vi.fn(async () => ({
      items: [],
      matchedCount: 0,
      totalCounts: { sessions: 0, workspaces: 0 },
      catalogRevision: 1,
    })),
    listWorkspaces: vi.fn(),
    getState: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    previewDeletion: vi.fn(),
    permanentlyDelete: vi.fn(),
    readTranscript: vi.fn(),
  };
  const dispose = registerDesktopIpc({
    ipcMain: {
      handle: (channel: string, handler: never) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as never,
    window: { webContents: sender, isDestroyed: () => false } as never,
    controller: {
      getState: () => ({ ...createInitialAccountState(), status }),
      subscribe: () => () => undefined,
    } as never,
    archiveController: archiveController as never,
    rendererTrust: { developmentOrigin: null, allowLoginIpc: true },
    platform: "win32",
    arch: "x64",
    version: "fixture",
  });
  return { handlers, frame, event, archiveController, dispose };
}
describe("typed account archive IPC", () => {
  it("uses existing caller/state/shape guards and strict output validation", async () => {
    const test = fixture();
    try {
      const invoke = test.handlers.get("caelush:archive:list-sessions")!;
      expect(await invoke(test.event, {})).toMatchObject({ ok: true });
      for (const raw of [{ baseUrl: "https://evil" }, { limit: 101 }, { query: "x".repeat(201) }])
        expect(await invoke(test.event, raw)).toMatchObject({
          ok: false,
          error: { code: "IPC_INPUT_INVALID" },
        });
      test.frame.url = "caelush-app://app/agent/";
      expect(await invoke(test.event, {})).toMatchObject({
        ok: false,
        error: { code: "IPC_CALLER_INVALID" },
      });
      expect(test.archiveController.listSessions).toHaveBeenCalledTimes(1);
      test.frame.url = "caelush-login://app/";
      test.archiveController.listSessions.mockResolvedValue({
        rawSecret: "must-not-leak",
      } as never);
      const result = await invoke(test.event, {});
      expect(result).toMatchObject({ ok: false, error: { code: "IPC_RESPONSE_INVALID" } });
      expect(JSON.stringify(result)).not.toContain("rawSecret");
      const permanent = test.handlers.get("caelush:archive:permanently-delete")!;
      expect(await permanent(test.event, { confirmationToken: "x".repeat(8193) })).toMatchObject({
        ok: false,
        error: { code: "IPC_INPUT_INVALID" },
      });
    } finally {
      test.dispose();
    }
    const locked = fixture("LOGIN_REQUIRED");
    try {
      expect(
        await locked.handlers.get("caelush:archive:list-sessions")!(locked.event, {}),
      ).toMatchObject({ ok: false, error: { code: "ACCOUNT_STATE_INVALID" } });
      expect(locked.archiveController.listSessions).not.toHaveBeenCalled();
    } finally {
      locked.dispose();
    }
  });
  it("preserves only static safe business error messages", () => {
    const safe = safeErrorForIpc(
      new CaelushClientHttpError({
        status: 409,
        code: "ARCHIVE_SELECTION_CHANGED",
        message: "hostToken=secret; stack; SQL",
      }),
    );
    expect(safe.code).toBe("ARCHIVE_SELECTION_CHANGED");
    expect(safe.message).not.toContain("secret");
    expect(safe.message).not.toContain("SQL");
  });
});
