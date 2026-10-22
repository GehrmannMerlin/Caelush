import { describe, expect, it, vi } from "vitest";
import { createSessionId } from "@caelush/protocol";
import { createInitialAccountState } from "../../src/main/account/state.js";
import { registerDesktopIpc } from "../../src/main/ipc/handlers.js";

function fixture(status: "AUTHENTICATED_ONLINE" | "AUTHORIZED_OFFLINE" | "LOGIN_REQUIRED") {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const frame = { url: "caelush-login://app/?view=account" };
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const event = { sender, senderFrame: frame };
  const profileCenterController = {
    getSnapshot: vi.fn(async () => ({
      recentSessions: [{ id: createSessionId(), title: "Recent session", updatedAt: 20 }],
      usage: {
        allTime: { successfulRequests: 7, totalTokens: 400 },
        since: { successfulRequests: 2, totalTokens: 125 },
      },
    })),
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
    profileCenterController: profileCenterController as never,
    rendererTrust: { developmentOrigin: null, allowLoginIpc: true },
    platform: "win32",
    arch: "x64",
    version: "fixture",
  });
  return { handlers, event, frame, profileCenterController, dispose };
}

describe("typed profile center IPC", () => {
  it("allows only authorized account screens and validates both the query and projected response", async () => {
    const test = fixture("AUTHENTICATED_ONLINE");
    try {
      const invoke = test.handlers.get("caelush:profile-center:get-snapshot")!;
      expect(await invoke(test.event, { sinceMs: 1_000, timezoneOffsetMinutes: 0 })).toMatchObject({
        ok: true,
      });
      expect(test.profileCenterController.getSnapshot).toHaveBeenCalledWith(
        { sinceMs: 1_000, timezoneOffsetMinutes: 0 },
        expect.any(AbortSignal),
      );
      expect(await invoke(test.event, { sinceMs: -1 })).toMatchObject({
        ok: false,
        error: { code: "IPC_INPUT_INVALID" },
      });

      test.frame.url = "caelush-app://app/agent/";
      expect(await invoke(test.event, { sinceMs: 1_000 })).toMatchObject({
        ok: false,
        error: { code: "IPC_CALLER_INVALID" },
      });
    } finally {
      test.dispose();
    }

    const offline = fixture("AUTHORIZED_OFFLINE");
    try {
      expect(
        await offline.handlers.get("caelush:profile-center:get-snapshot")!(offline.event, {
          sinceMs: 1_000,
        }),
      ).toMatchObject({ ok: true });
    } finally {
      offline.dispose();
    }

    const locked = fixture("LOGIN_REQUIRED");
    try {
      expect(
        await locked.handlers.get("caelush:profile-center:get-snapshot")!(locked.event, {
          sinceMs: 1_000,
        }),
      ).toMatchObject({ ok: false, error: { code: "ACCOUNT_STATE_INVALID" } });
      expect(locked.profileCenterController.getSnapshot).not.toHaveBeenCalled();
    } finally {
      locked.dispose();
    }
  });
});
