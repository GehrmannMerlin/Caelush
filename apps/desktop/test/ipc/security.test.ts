import { describe, expect, it, vi } from "vitest";
import { createInitialAccountState } from "../../src/main/account/state.js";
import {
  IPC_CHANNELS,
  IPC_OPERATION_TIMEOUT_MS,
  registerDesktopIpc,
} from "../../src/main/ipc/handlers.js";

function fixture(
  options: {
    readonly status?: "LOGIN_REQUIRED" | "AUTHENTICATED_ONLINE" | "AUTHORIZED_OFFLINE";
    readonly userId?: string;
    readonly legacyImporter?: unknown;
    readonly beginAccountBoundary?: () => Promise<void>;
    readonly synchronizeAccountState?: () => Promise<void>;
    readonly projectAccountState?: (state: never) => never;
  } = {},
) {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const lifecycleListeners = new Map<string, () => void>();
  const ipcMain = {
    handle: vi.fn(
      (channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>) =>
        handlers.set(channel, listener),
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const frame = { url: "caelush-login://app/" };
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
  const currentState =
    options.userId === undefined
      ? createInitialAccountState(options.status ?? "LOGIN_REQUIRED")
      : {
          ...createInitialAccountState(options.status ?? "AUTHENTICATED_ONLINE"),
          account: {
            userId: options.userId,
            email: "person@example.test",
            emailVerified: true,
            entitlements: [],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        };
  const controller = {
    getState: () => currentState,
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
    ...(options.legacyImporter === undefined
      ? {}
      : { legacyImporter: options.legacyImporter as never }),
    ...(options.beginAccountBoundary === undefined
      ? {}
      : { beginAccountBoundary: options.beginAccountBoundary }),
    ...(options.synchronizeAccountState === undefined
      ? {}
      : { synchronizeAccountState: options.synchronizeAccountState as never }),
    ...(options.projectAccountState === undefined
      ? {}
      : { projectAccountState: options.projectAccountState as never }),
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
    test.frame.url = "caelush-login://app:9443/";
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

  it("does not expose Desktop account IPC to the Agent origin", async () => {
    const test = fixture();
    test.frame.url = "caelush-app://app/agent/";
    const result = (await test.handlers.get("caelush:account:get-state")?.(
      test.event(),
      undefined,
    )) as { ok: boolean; error?: { code: string } };
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

  it("keeps legacy import Main-selected, account-bound, and behind daemon shutdown", async () => {
    const order: string[] = [];
    const userId = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
    const candidateId = "651ab583-ef57-4190-8bd3-a0f5f90bc1bd";
    const result = {
      state: "COMMITTED",
      profileId: `u_${"a".repeat(64)}`,
      backupId: "7d4a8e98-8f2f-4adb-a442-dcf956c7b579",
      credentialCount: 1,
      imported: {
        workspaces: 1,
        sessions: 2,
        runs: 2,
        messages: 3,
        durableEvents: 4,
        contextCheckpoints: 1,
        toolExecutions: 2,
        providerCredentials: 1,
        modelSelections: 1,
        privateReplayFiles: 1,
        estimatedBytes: 4096,
      },
    };
    const prepared = { ...result, state: "DESTINATION_VERIFIED" };
    const legacyImporter = {
      inspect: vi.fn(async () => ({ sources: [], pendingRecovery: false })),
      stageImport: vi.fn(
        async (selectedUserId: string, selectedCandidateId: string, confirmed: true) => {
          order.push("import");
          expect(selectedUserId).toBe(userId);
          expect(selectedCandidateId).toBe(candidateId);
          expect(confirmed).toBe(true);
          return prepared;
        },
      ),
      stageResumeImport: vi.fn(),
      commitImport: vi.fn(async () => {
        order.push("import-committed");
        return result;
      }),
    };
    const beginAccountBoundary = vi.fn(async () => {
      order.push("daemon-stopped");
    });
    const synchronizeAccountState = vi.fn(async () => {
      order.push("daemon-resynchronized");
    });
    const test = fixture({
      status: "AUTHORIZED_OFFLINE",
      userId,
      legacyImporter,
      beginAccountBoundary,
      synchronizeAccountState,
      projectAccountState: (state) => ({ ...state, agentEntry: { available: true } }) as never,
    });
    const handler = test.handlers.get(IPC_CHANNELS.legacyData.import);
    expect(handler).toBeDefined();
    const malformed = (await handler?.(test.event(), {
      candidateId,
      confirmed: true,
      sourcePath: "C:\\Users\\someone\\.caelush",
    })) as { ok: boolean; error?: { code: string } };
    expect(malformed.ok).toBe(false);
    expect(malformed.error?.code).toBe("IPC_INPUT_INVALID");
    expect(beginAccountBoundary).not.toHaveBeenCalled();
    expect(legacyImporter.stageImport).not.toHaveBeenCalled();

    const completed = (await handler?.(test.event(), { candidateId, confirmed: true })) as {
      ok: boolean;
      value?: unknown;
    };
    expect(completed).toEqual({ ok: true, value: result });
    expect(beginAccountBoundary).toHaveBeenCalledOnce();
    expect(legacyImporter.commitImport).toHaveBeenCalledOnce();
    expect(synchronizeAccountState).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "daemon-stopped",
      "import",
      "daemon-resynchronized",
      "import-committed",
      "daemon-resynchronized",
    ]);
    test.dispose();
  });

  it("does not commit an import when the profile-bound Daemon fails its first startup", async () => {
    const userId = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
    const prepared = {
      state: "DESTINATION_VERIFIED",
      profileId: `u_${"a".repeat(64)}`,
      backupId: "7d4a8e98-8f2f-4adb-a442-dcf956c7b579",
      credentialCount: 0,
      imported: {
        workspaces: 1,
        sessions: 1,
        runs: 1,
        messages: 2,
        durableEvents: 2,
        contextCheckpoints: 0,
        toolExecutions: 0,
        providerCredentials: 0,
        modelSelections: 0,
        privateReplayFiles: 0,
        estimatedBytes: 1024,
      },
    };
    const legacyImporter = {
      inspect: vi.fn(),
      stageImport: vi.fn(async () => prepared),
      stageResumeImport: vi.fn(),
      commitImport: vi.fn(),
    };
    const test = fixture({
      userId,
      legacyImporter,
      beginAccountBoundary: vi.fn(async () => undefined),
      synchronizeAccountState: vi.fn(async () => undefined),
      projectAccountState: (state) =>
        ({ ...state, agentEntry: { available: false, reason: "DAEMON_START_FAILED" } }) as never,
    });

    const result = (await test.handlers.get(IPC_CHANNELS.legacyData.import)?.(test.event(), {
      candidateId: "651ab583-ef57-4190-8bd3-a0f5f90bc1bd",
      confirmed: true,
    })) as { readonly ok: boolean; readonly error?: { readonly code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("LEGACY_IMPORT_RECOVERY_REQUIRED");
    expect(legacyImporter.stageImport).toHaveBeenCalledOnce();
    expect(legacyImporter.commitImport).not.toHaveBeenCalled();
    test.dispose();
  });

  it("serializes import and recovery through profile restart and commit", async () => {
    const userId = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
    const candidateId = "651ab583-ef57-4190-8bd3-a0f5f90bc1bd";
    const prepared = {
      state: "DESTINATION_VERIFIED",
      profileId: `u_${"a".repeat(64)}`,
      backupId: "7d4a8e98-8f2f-4adb-a442-dcf956c7b579",
      credentialCount: 0,
      imported: {
        workspaces: 1,
        sessions: 1,
        runs: 1,
        messages: 2,
        durableEvents: 2,
        contextCheckpoints: 0,
        toolExecutions: 0,
        providerCredentials: 0,
        modelSelections: 0,
        privateReplayFiles: 0,
        estimatedBytes: 1024,
      },
    };
    const committed = { ...prepared, state: "COMMITTED" };
    const order: string[] = [];
    let releaseFirstStage!: () => void;
    let notifyFirstStage!: () => void;
    const firstStage = new Promise<void>((resolve) => {
      notifyFirstStage = resolve;
    });
    const stageGate = new Promise<void>((resolve) => {
      releaseFirstStage = resolve;
    });
    let isFirstStage = true;
    const legacyImporter = {
      inspect: vi.fn(),
      stageImport: vi.fn(async () => {
        order.push("stage-start");
        if (isFirstStage) {
          isFirstStage = false;
          notifyFirstStage();
          await stageGate;
        }
        order.push("stage-finish");
        return prepared;
      }),
      stageResumeImport: vi.fn(async () => prepared),
      commitImport: vi.fn(async () => {
        order.push("commit");
        return committed;
      }),
    };
    const test = fixture({
      userId,
      legacyImporter,
      beginAccountBoundary: vi.fn(async () => {
        order.push("boundary");
      }),
      synchronizeAccountState: vi.fn(async () => {
        order.push("daemon-ready");
      }),
      projectAccountState: (state) => ({ ...state, agentEntry: { available: true } }) as never,
    });
    const handler = test.handlers.get(IPC_CHANNELS.legacyData.import);
    if (handler === undefined) throw new Error("missing legacy import handler");

    const first = handler(test.event(), { candidateId, confirmed: true });
    await firstStage;
    const second = handler(test.event(), { candidateId, confirmed: true });
    await Promise.resolve();
    expect(legacyImporter.stageImport).toHaveBeenCalledOnce();
    expect(test.controller.getState().status).toBe("AUTHENTICATED_ONLINE");
    expect(order).toEqual(["boundary", "stage-start"]);

    releaseFirstStage();
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      { ok: true, value: committed },
      { ok: true, value: committed },
    ]);
    expect(legacyImporter.stageImport).toHaveBeenCalledTimes(2);
    expect(legacyImporter.commitImport).toHaveBeenCalledTimes(2);
    expect(order.indexOf("commit")).toBeLessThan(order.lastIndexOf("boundary"));
    test.dispose();
  });
});
