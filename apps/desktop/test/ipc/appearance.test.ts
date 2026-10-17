import { describe, expect, it, vi } from "vitest";
import type { AppearanceSnapshot, ThemePreference } from "@caelush/ui-theme";
import { IPC_CHANNELS, registerDesktopIpc } from "../../src/main/ipc/handlers.js";
import { createInitialAccountState } from "../../src/main/account/state.js";

function fixture() {
  const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>();
  const eventHandlers = new Map<
    string,
    (event: { sender: unknown; senderFrame: unknown; returnValue: unknown }) => void
  >();
  const frame = { url: "caelush-login://app/?view=account&section=appearance" };
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const event = { sender, senderFrame: frame };
  const snapshot: AppearanceSnapshot = Object.freeze({
    preference: "light",
    resolvedTheme: "light",
    revision: 0,
  });
  let publish: ((next: AppearanceSnapshot) => void) | undefined;
  const unsubscribe = vi.fn();
  const appearanceController = {
    getSnapshot: vi.fn(() => snapshot),
    setPreference: vi.fn(async (preference: ThemePreference) =>
      Object.freeze({
        preference,
        resolvedTheme: preference === "system" ? "dark" : preference,
        revision: 1,
      }),
    ),
    subscribe: vi.fn((listener: (next: AppearanceSnapshot) => void) => {
      publish = listener;
      return unsubscribe;
    }),
  };
  const dispose = registerDesktopIpc({
    ipcMain: {
      handle: (channel: string, handler: never) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
      on: (channel: string, handler: never) => eventHandlers.set(channel, handler),
      removeListener: (channel: string) => eventHandlers.delete(channel),
    } as never,
    window: { webContents: sender, isDestroyed: () => false } as never,
    controller: {
      getState: () => createInitialAccountState(),
      subscribe: () => () => undefined,
    } as never,
    rendererTrust: { developmentOrigin: null, allowLoginIpc: true },
    platform: "win32",
    arch: "x64",
    version: "fixture",
    appearanceController: appearanceController as never,
  });
  return {
    handlers,
    eventHandlers,
    frame,
    sender,
    event,
    appearanceController,
    publish: (next: AppearanceSnapshot) => publish?.(next),
    unsubscribe,
    dispose,
  };
}

describe("Desktop appearance IPC", () => {
  it("reads and updates the preference from the trusted login and Agent renderers", async () => {
    const test = fixture();
    try {
      const getSnapshot = test.handlers.get(IPC_CHANNELS.appearance.getSnapshot)!;
      const setPreference = test.handlers.get(IPC_CHANNELS.appearance.setPreference)!;
      expect(await getSnapshot(test.event)).toMatchObject({
        ok: true,
        value: { preference: "light", resolvedTheme: "light", revision: 0 },
      });
      expect(await setPreference(test.event, { preference: "dark" })).toMatchObject({
        ok: true,
        value: { preference: "dark", resolvedTheme: "dark", revision: 1 },
      });

      test.frame.url = "caelush-app://app/agent/";
      expect(await getSnapshot(test.event)).toMatchObject({ ok: true });
      expect(await setPreference(test.event, { preference: "system" })).toMatchObject({
        ok: true,
        value: { preference: "system", resolvedTheme: "dark", revision: 1 },
      });
      expect(test.appearanceController.setPreference).toHaveBeenNthCalledWith(2, "system");
    } finally {
      test.dispose();
    }
  });

  it("rejects malformed preferences, untrusted origins, guests, and subframes", async () => {
    const test = fixture();
    try {
      const getSnapshot = test.handlers.get(IPC_CHANNELS.appearance.getSnapshot)!;
      const setPreference = test.handlers.get(IPC_CHANNELS.appearance.setPreference)!;
      for (const input of [{ preference: "sepia" }, { preference: "dark", extra: true }, "dark"])
        expect(await setPreference(test.event, input)).toMatchObject({
          ok: false,
          error: { code: "IPC_INPUT_INVALID" },
        });

      test.frame.url = "https://example.com/";
      expect(await getSnapshot(test.event)).toMatchObject({
        ok: false,
        error: { code: "IPC_CALLER_INVALID" },
      });
      test.frame.url = "caelush-login://app/";
      expect(await getSnapshot({ ...test.event, sender: { ...test.sender } })).toMatchObject({
        ok: false,
        error: { code: "IPC_CALLER_INVALID" },
      });
      expect(
        await getSnapshot({ ...test.event, senderFrame: { url: test.frame.url } }),
      ).toMatchObject({
        ok: false,
        error: { code: "IPC_CALLER_INVALID" },
      });
      expect(test.appearanceController.setPreference).not.toHaveBeenCalled();
    } finally {
      test.dispose();
    }
  });

  it("broadcasts increasing snapshots only while the main frame stays trusted", () => {
    const test = fixture();
    try {
      const next: AppearanceSnapshot = Object.freeze({
        preference: "dark",
        resolvedTheme: "dark",
        revision: 1,
      });
      test.publish(next);
      expect(test.sender.send).toHaveBeenCalledWith(IPC_CHANNELS.appearance.snapshot, next);

      test.frame.url = "https://example.com/";
      test.publish(Object.freeze({ ...next, revision: 2 }));
      expect(test.sender.send).toHaveBeenCalledTimes(1);
    } finally {
      test.dispose();
    }
    expect(test.unsubscribe).toHaveBeenCalledOnce();
  });

  it("provides an in-memory startup snapshot only to trusted main frames", () => {
    const test = fixture();
    try {
      const initialize = test.eventHandlers.get(IPC_CHANNELS.appearance.initialSnapshot)!;
      const event = { ...test.event, returnValue: undefined as unknown };
      initialize(event);
      expect(event.returnValue).toEqual(test.appearanceController.getSnapshot());

      test.frame.url = "https://example.com/";
      event.returnValue = undefined;
      initialize(event);
      expect(event.returnValue).toBeNull();
    } finally {
      test.dispose();
    }
    expect(test.eventHandlers.size).toBe(0);
  });

  it("sends the validated startup snapshot in its first synchronous reply", () => {
    const test = fixture();
    try {
      const initialize = test.eventHandlers.get(IPC_CHANNELS.appearance.initialSnapshot)!;
      const event = { ...test.event, returnValue: undefined as unknown };
      let assignments = 0;
      let firstReply: unknown;
      Object.defineProperty(event, "returnValue", {
        configurable: true,
        get: () => firstReply,
        set: (value: unknown) => {
          assignments += 1;
          if (assignments === 1) firstReply = value;
        },
      });

      initialize(event);

      expect(assignments).toBe(1);
      expect(firstReply).toEqual({ preference: "light", resolvedTheme: "light", revision: 0 });
    } finally {
      test.dispose();
    }
  });
});
