import { describe, expect, it, vi } from "vitest";
import { createInitialAccountState } from "../../src/main/account/state.js";
import { IPC_OPERATION_TIMEOUT_MS, registerDesktopIpc } from "../../src/main/ipc/handlers.js";

function fixture() {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const lifecycleListeners = new Map<string, () => void>();
  const ipcMain = {
    handle: vi.fn(
      (channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>) =>
        handlers.set(channel, listener),
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const frame = { url: "caelush-app://app/" };
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => {
      lifecycleListeners.set(event, listener);
    }),
    on: vi.fn((event: string, listener: () => void) => {
      lifecycleListeners.set(event, listener);
    }),
    removeListener: vi.fn(),
  };
  const window = {
    webContents: sender,
    isDestroyed: () => false,
    isMaximized: () => false,
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
  };
  const controller = {
    getState: () => createInitialAccountState("LOGIN_REQUIRED"),
    subscribe: (listener: (state: unknown) => void) => {
      listener(createInitialAccountState("LOGIN_REQUIRED"));
      return () => undefined;
    },
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(async () => ({ serverRevoked: true })),
    resendVerification: vi.fn(),
    verifyEmail: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
    changePassword: vi.fn(),
    refreshNow: vi.fn(),
    listDevices: vi.fn(),
    revokeDevice: vi.fn(),
  };
  const dispose = registerDesktopIpc({
    ipcMain: ipcMain as never,
    window: window as never,
    controller: controller as never,
    rendererTrust: { developmentOrigin: null },
    platform: "win32",
    arch: "x64",
    version: "0.1.0",
  });
  const event = () => ({ sender, senderFrame: frame });
  return {
    handlers,
    ipcMain,
    frame,
    sender,
    window,
    controller,
    dispose,
    event,
    destroyRenderer: () => lifecycleListeners.get("destroyed")?.(),
  };
}

describe("Desktop IPC security boundary", () => {
  it("registers only named methods and rejects a wrong frame origin", async () => {
    const test = fixture();
    expect(test.handlers.has("caelush:account:get-state")).toBe(true);
    expect(test.handlers.has("caelush:window:maximize-or-restore")).toBe(true);
    expect(test.handlers.has("caelush:invoke")).toBe(false);
    expect(test.handlers.has("caelush:workspace:open")).toBe(false);

    test.frame.url = "https://attacker.example/";
    const result = (await test.handlers.get("caelush:account:get-state")?.(
      test.event(),
      undefined,
    )) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("IPC_CALLER_INVALID");
    test.dispose();
  });

  it("rejects malformed input before reaching account authority and denies online-only work", async () => {
    const test = fixture();
    const register = test.handlers.get("caelush:account:register");
    const malformed = (await register?.(test.event(), {
      email: "not-an-email",
      password: "x",
    })) as { ok: boolean; error?: { code: string } };
    expect(malformed.ok).toBe(false);
    expect(malformed.error?.code).toBe("IPC_INPUT_INVALID");
    expect(test.controller.register).not.toHaveBeenCalled();

    const devices = (await test.handlers.get("caelush:account:list-devices")?.(
      test.event(),
      undefined,
    )) as { ok: boolean; error?: { code: string } };
    expect(devices.ok).toBe(false);
    expect(devices.error?.code).toBe("ACCOUNT_STATE_INVALID");
    expect(test.controller.listDevices).not.toHaveBeenCalled();
    test.dispose();
  });

  it("rejects a privileged custom-protocol origin with an unexpected port", async () => {
    const test = fixture();
    test.frame.url = "caelush-app://app:9443/";
    const result = (await test.handlers.get("caelush:account:get-state")?.(
      test.event(),
      undefined,
    )) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("IPC_CALLER_INVALID");
    test.dispose();
  });

  it("aborts an IPC operation that exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const test = fixture();
      let receivedSignal: AbortSignal | undefined;
      vi.mocked(test.controller.login).mockImplementation((_input, signal) => {
        receivedSignal = signal;
        return new Promise(() => undefined);
      });
      const pending = test.handlers.get("caelush:account:login")?.(test.event(), {
        email: "person@example.test",
        password: "secret-for-test-only",
      });
      await vi.advanceTimersByTimeAsync(IPC_OPERATION_TIMEOUT_MS);
      const result = (await pending) as { ok: boolean; error?: { code: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("IPC_TIMEOUT");
      expect(receivedSignal?.aborted).toBe(true);
      test.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an in-flight IPC action when its renderer is destroyed", async () => {
    const test = fixture();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(test.controller.login).mockImplementation((_input, signal) => {
      receivedSignal = signal;
      return new Promise(() => undefined);
    });
    const pending = test.handlers.get("caelush:account:login")?.(test.event(), {
      email: "person@example.test",
      password: "secret-for-test-only",
    });
    await Promise.resolve();
    test.destroyRenderer();
    const result = (await pending) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("IPC_CANCELLED");
    expect(receivedSignal?.aborted).toBe(true);
    test.dispose();
  });
});
