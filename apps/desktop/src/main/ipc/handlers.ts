import { setImmediate } from "node:timers";
import { BrowserWindow, ipcMain, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { AccountController, AccountOperationError } from "../account/controller.js";
import { AccountStateSchema } from "../account/state.js";
import type { AccountState } from "../account/state.js";
import type { DesktopLegacyDataImporter } from "../migration/legacy-data-import.js";
import type {
  LegacyDataImportResult,
  LegacyDataImportSummary,
} from "../../shared/legacy-data-contract.js";
import {
  AcceptedResponseSchema,
  DeviceRevocationResponseSchema,
  DeviceViewSchema,
  OperationSucceededResponseSchema,
} from "../cloud/schemas.js";
import { safeErrorForIpc } from "./safe-error.js";

export const IPC_CHANNELS = Object.freeze({
  account: Object.freeze({
    state: "caelush:account:state",
    getState: "caelush:account:get-state",
    register: "caelush:account:register",
    login: "caelush:account:login",
    logout: "caelush:account:logout",
    resendVerification: "caelush:account:resend-verification",
    verifyEmail: "caelush:account:verify-email",
    forgotPassword: "caelush:account:forgot-password",
    resetPassword: "caelush:account:reset-password",
    changePassword: "caelush:account:change-password",
    refreshNow: "caelush:account:refresh-now",
    listDevices: "caelush:account:list-devices",
    revokeDevice: "caelush:account:revoke-device",
  }),
  window: Object.freeze({
    minimize: "caelush:window:minimize",
    maximizeOrRestore: "caelush:window:maximize-or-restore",
    close: "caelush:window:close",
    getPlatform: "caelush:window:get-platform",
  }),
  feature: Object.freeze({
    workspace: "caelush:feature:workspace",
    browser: "caelush:feature:browser",
    update: "caelush:feature:update",
  }),
  legacyData: Object.freeze({
    inspect: "caelush:legacy-data:inspect",
    import: "caelush:legacy-data:import",
    resume: "caelush:legacy-data:resume",
    progress: "caelush:legacy-data:progress",
  }),
});

const NoInput = z.undefined();
const EmailInput = z.object({ email: z.email().max(320) }).strict();
const CredentialsInput = z
  .object({ email: z.email().max(320), password: z.string().min(1).max(1024) })
  .strict();
const RegisterInput = z
  .object({ email: z.email().max(320), password: z.string().min(1).max(1024) })
  .strict();
const VerifyEmailInput = z.object({ verificationToken: z.string().min(16).max(4096) }).strict();
const ResetPasswordInput = z
  .object({ resetToken: z.string().min(16).max(4096), newPassword: z.string().min(1).max(1024) })
  .strict();
const ChangePasswordInput = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();
const RevokeDeviceInput = z.object({ deviceId: z.uuid() }).strict();
const AcceptedOutput = AcceptedResponseSchema;
const SuccessOutput = OperationSucceededResponseSchema;
const ConnectedOutput = z.object({ connected: z.literal(true) }).strict();
const LogoutOutput = z.object({ serverRevoked: z.boolean() }).strict();
const DeviceListOutput = z.array(DeviceViewSchema).max(100);
const MaximizedOutput = z.object({ maximized: z.boolean() }).strict();
const MinimizedOutput = z.object({ minimized: z.literal(true) }).strict();
const ClosedOutput = z.object({ closed: z.literal(true) }).strict();
const PlatformOutput = z
  .object({ platform: z.string().max(32), arch: z.string().max(32), version: z.string().max(64) })
  .strict();
const WorkspaceUnavailable = z
  .object({ available: z.literal(false), reason: z.literal("D4_LOCAL_AGENT_PENDING") })
  .strict();
const UpdateUnavailable = z
  .object({ available: z.literal(false), reason: z.literal("D6_UPDATER_PENDING") })
  .strict();
const MAX_IPC_INPUT_BYTES = 20 * 1024;
export const IPC_OPERATION_TIMEOUT_MS = 15_000;
export const LEGACY_IMPORT_OPERATION_TIMEOUT_MS = 2 * 60 * 60_000;
const PRE_AUTHENTICATED_STATES = new Set([
  "LOGIN_REQUIRED",
  "SESSION_EXPIRED",
  "OFFLINE_GRANT_EXPIRED",
  "AUTHORIZED_OFFLINE",
  "DEVICE_REVOKED",
  "ERROR",
]);
const LOGOUT_STATES = new Set([
  "AUTHENTICATED_ONLINE",
  "AUTHORIZED_OFFLINE",
  "LOGIN_REQUIRED",
  "SESSION_EXPIRED",
  "OFFLINE_GRANT_EXPIRED",
  "DEVICE_REVOKED",
  "ERROR",
]);
const AUTHORIZED_STATES = new Set(["AUTHENTICATED_ONLINE", "AUTHORIZED_OFFLINE"]);
const LegacyDataSourceSummarySchema = z
  .object({
    candidateId: z.uuid(),
    sourceLabel: z.enum(["Default Caelush data", "Custom CAELUSH_HOME"]),
    sourceKind: z.enum(["DEFAULT_HOME", "CUSTOM_HOME"]),
    importable: z.boolean(),
    reason: z
      .enum(["SOURCE_UNREADABLE", "UNSUPPORTED_SCHEMA", "TARGET_NOT_EMPTY", "NO_IMPORTABLE_DATA"])
      .optional(),
    workspaces: z.number().int().nonnegative().safe(),
    sessions: z.number().int().nonnegative().safe(),
    runs: z.number().int().nonnegative().safe(),
    messages: z.number().int().nonnegative().safe(),
    durableEvents: z.number().int().nonnegative().safe(),
    contextCheckpoints: z.number().int().nonnegative().safe(),
    toolExecutions: z.number().int().nonnegative().safe(),
    providerCredentials: z.number().int().nonnegative().safe(),
    modelSelections: z.number().int().nonnegative().safe(),
    privateReplayFiles: z.number().int().nonnegative().safe(),
    estimatedBytes: z.number().int().nonnegative().safe(),
  })
  .strict();
const LegacyImportSummarySchema = z
  .object({
    sources: z.array(LegacyDataSourceSummarySchema).max(2),
    pendingRecovery: z.boolean(),
    recoveryState: z.enum(["IMPORT_STAGED", "DESTINATION_VERIFIED", "RECOVERY_BLOCKED"]).optional(),
  })
  .strict();
const LegacyImportInput = z.object({ candidateId: z.uuid(), confirmed: z.literal(true) }).strict();
const LegacyImportProgressSchema = z
  .object({
    progress: z.enum([
      "BACKUP_VERIFIED",
      "IMPORT_STAGED",
      "DESTINATION_VERIFIED",
      "CREDENTIALS_SECURED",
      "COMMITTED",
      "RECOVERY_REQUIRED",
    ]),
  })
  .strict();
const LegacyImportCountsSchema = z
  .object({
    workspaces: z.number().int().nonnegative().safe(),
    sessions: z.number().int().nonnegative().safe(),
    runs: z.number().int().nonnegative().safe(),
    messages: z.number().int().nonnegative().safe(),
    durableEvents: z.number().int().nonnegative().safe(),
    contextCheckpoints: z.number().int().nonnegative().safe(),
    toolExecutions: z.number().int().nonnegative().safe(),
    providerCredentials: z.number().int().nonnegative().safe(),
    modelSelections: z.number().int().nonnegative().safe(),
    privateReplayFiles: z.number().int().nonnegative().safe(),
    estimatedBytes: z.number().int().nonnegative().safe(),
  })
  .strict();
const LegacyImportResultSchema = z
  .object({
    state: z.literal("COMMITTED"),
    profileId: z.string().regex(/^u_[0-9a-f]{64}$/u),
    backupId: z.uuid(),
    credentialCount: z.number().int().nonnegative().safe(),
    imported: LegacyImportCountsSchema,
  })
  .strict();

export interface DesktopRendererTrust {
  readonly developmentOrigin: string | null;
}

export interface RegisterDesktopIpcOptions {
  readonly ipcMain?: IpcMain;
  readonly window: BrowserWindow;
  readonly controller: AccountController;
  readonly rendererTrust: DesktopRendererTrust;
  readonly platform: string;
  readonly arch: string;
  readonly version: string;
  readonly projectAccountState?: (state: AccountState) => AccountState;
  readonly beginAccountBoundary?: () => Promise<void>;
  readonly synchronizeAccountState?: (state: AccountState) => Promise<void>;
  readonly legacyImporter?: DesktopLegacyDataImporter;
}

export function registerDesktopIpc(options: RegisterDesktopIpcOptions): () => void {
  const main = options.ipcMain ?? ipcMain;
  const registered: string[] = [];
  const { account, window: windowChannels, feature } = IPC_CHANNELS;

  const register = <TInput, TOutput>(
    channel: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    action: (input: TInput, signal: AbortSignal) => Promise<unknown> | unknown,
    allowedStates?: ReadonlySet<string>,
    timeoutMs = IPC_OPERATION_TIMEOUT_MS,
  ) => {
    main.handle(channel, async (event: IpcMainInvokeEvent, rawInput: unknown) => {
      const abort = new AbortController();
      const onDestroyed = () => abort.abort();
      const onRenderGone = () => abort.abort();
      let timedOut = false;
      let rejectInterrupted!: (error: AccountOperationError) => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        rejectInterrupted = reject;
      });
      const onAbort = () => {
        if (!timedOut) {
          rejectInterrupted(
            new AccountOperationError("IPC_CANCELLED", "The desktop request was cancelled."),
          );
        }
      };
      abort.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
        rejectInterrupted(
          new AccountOperationError("IPC_TIMEOUT", "The desktop request timed out."),
        );
      }, timeoutMs);
      try {
        assertTrustedCaller(event, options.window, options.rendererTrust);
        validateInputSize(rawInput);
        const input = inputSchema.safeParse(rawInput);
        if (!input.success) {
          throw new AccountOperationError(
            "IPC_INPUT_INVALID",
            "The desktop request did not match the supported input.",
          );
        }
        if (
          allowedStates !== undefined &&
          !allowedStates.has(options.controller.getState().status)
        ) {
          throw new AccountOperationError(
            "ACCOUNT_STATE_INVALID",
            "This account operation is not available in the current state.",
          );
        }
        event.sender.once("destroyed", onDestroyed);
        event.sender.on("render-process-gone", onRenderGone);
        const rawOutput = await Promise.race([
          Promise.resolve().then(() => action(input.data, abort.signal)),
          interrupted,
        ]);
        const output = outputSchema.safeParse(rawOutput);
        if (!output.success) {
          throw new AccountOperationError(
            "IPC_RESPONSE_INVALID",
            "The desktop request could not return a safe response.",
          );
        }
        return { ok: true, value: output.data };
      } catch (error) {
        return { ok: false, error: safeErrorForIpc(error) };
      } finally {
        clearTimeout(timeout);
        abort.signal.removeEventListener("abort", onAbort);
        event.sender.removeListener("destroyed", onDestroyed);
        event.sender.removeListener("render-process-gone", onRenderGone);
      }
    });
    registered.push(channel);
  };

  const getProjectedState = () => {
    const state = options.controller.getState();
    return options.projectAccountState?.(state) ?? state;
  };
  const currentAuthorizedUserId = () => {
    const state = options.controller.getState();
    if (!AUTHORIZED_STATES.has(state.status) || state.account?.userId === undefined) {
      throw new AccountOperationError(
        "ACCOUNT_STATE_INVALID",
        "This account operation is not available in the current state.",
      );
    }
    return state.account.userId;
  };
  let legacyOperationTail: Promise<void> = Promise.resolve();
  const runLegacyOperation = async <TPrepared, TResult>(
    action: (userId: string) => Promise<TPrepared>,
    finalize: (userId: string, prepared: TPrepared) => Promise<TResult>,
  ): Promise<TResult> => {
    const previous = legacyOperationTail;
    let release!: () => void;
    legacyOperationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (options.legacyImporter === undefined || options.beginAccountBoundary === undefined) {
        throw new AccountOperationError(
          "LEGACY_IMPORT_UNAVAILABLE",
          "Legacy local data import is unavailable.",
        );
      }
      const userId = currentAuthorizedUserId();
      await options.beginAccountBoundary();
      try {
        if (currentAuthorizedUserId() !== userId) {
          throw new AccountOperationError(
            "ACCOUNT_STATE_INVALID",
            "The active account changed before local data import could start.",
          );
        }
        const prepared = await action(userId);
        const currentState = options.controller.getState();
        if (
          currentState.account?.userId !== userId ||
          !AUTHORIZED_STATES.has(currentState.status)
        ) {
          throw new AccountOperationError(
            "ACCOUNT_STATE_INVALID",
            "The active account changed during local data import.",
          );
        }
        if (options.synchronizeAccountState === undefined) {
          throw new AccountOperationError(
            "LEGACY_IMPORT_UNAVAILABLE",
            "Legacy local data import is unavailable.",
          );
        }
        await options.synchronizeAccountState(currentState);
        const projected = options.projectAccountState?.(currentState) ?? currentState;
        if (!projected.agentEntry.available) {
          throw new AccountOperationError(
            "LEGACY_IMPORT_RECOVERY_REQUIRED",
            "The imported Profile did not pass local Agent startup verification. Protected recovery is available.",
          );
        }
        return await finalize(userId, prepared);
      } finally {
        await synchronizeCurrentState();
      }
    } finally {
      release();
    }
  };
  const synchronizeCurrentState = async () => {
    try {
      await options.synchronizeAccountState?.(options.controller.getState());
    } catch {
      // Daemon startup state is exposed as a bounded agentEntry projection.
    }
  };
  register(account.getState, NoInput, AccountStateSchema, getProjectedState);
  register(
    account.register,
    RegisterInput,
    AcceptedOutput,
    (input, signal) => options.controller.register(input, signal),
    PRE_AUTHENTICATED_STATES,
  );
  register(
    account.login,
    CredentialsInput,
    ConnectedOutput,
    async (input, signal) => {
      await options.controller.login(input, signal);
      await synchronizeCurrentState();
      return { connected: true };
    },
    PRE_AUTHENTICATED_STATES,
  );
  register(
    account.logout,
    NoInput,
    LogoutOutput,
    async (_input, signal) => {
      await options.beginAccountBoundary?.();
      return options.controller.logout(signal);
    },
    LOGOUT_STATES,
  );
  register(
    account.resendVerification,
    EmailInput,
    AcceptedOutput,
    (input, signal) => options.controller.resendVerification(input, signal),
    PRE_AUTHENTICATED_STATES,
  );
  register(
    account.verifyEmail,
    VerifyEmailInput,
    SuccessOutput,
    (input, signal) => options.controller.verifyEmail(input, signal),
    PRE_AUTHENTICATED_STATES,
  );
  register(
    account.forgotPassword,
    EmailInput,
    AcceptedOutput,
    (input, signal) => options.controller.forgotPassword(input, signal),
    PRE_AUTHENTICATED_STATES,
  );
  register(
    account.resetPassword,
    ResetPasswordInput,
    SuccessOutput,
    (input, signal) => options.controller.resetPassword(input, signal),
    PRE_AUTHENTICATED_STATES,
  );
  register(
    account.changePassword,
    ChangePasswordInput,
    SuccessOutput,
    (input, signal) => options.controller.changePassword(input, signal),
    new Set(["AUTHENTICATED_ONLINE"]),
  );
  register(
    account.refreshNow,
    NoInput,
    AccountStateSchema,
    async (_input, signal) => {
      await options.controller.refreshNow(signal);
      await synchronizeCurrentState();
      return getProjectedState();
    },
    new Set([
      "AUTHENTICATED_ONLINE",
      "AUTHORIZED_OFFLINE",
      "SESSION_EXPIRED",
      "OFFLINE_GRANT_EXPIRED",
    ]),
  );
  register(
    account.listDevices,
    NoInput,
    DeviceListOutput,
    (_input, signal) => options.controller.listDevices(signal),
    new Set(["AUTHENTICATED_ONLINE"]),
  );
  register(
    account.revokeDevice,
    RevokeDeviceInput,
    DeviceRevocationResponseSchema,
    async (input, signal) => {
      const result = await options.controller.revokeDevice(input.deviceId, signal);
      await synchronizeCurrentState();
      return result;
    },
    new Set(["AUTHENTICATED_ONLINE"]),
  );

  if (options.legacyImporter !== undefined) {
    const { legacyData } = IPC_CHANNELS;
    register(
      legacyData.inspect,
      NoInput,
      LegacyImportSummarySchema,
      async () => {
        const userId = currentAuthorizedUserId();
        return options.legacyImporter!.inspect(userId);
      },
      AUTHORIZED_STATES,
    );
    register(
      legacyData.import,
      LegacyImportInput,
      LegacyImportResultSchema,
      (input) =>
        runLegacyOperation(
          (userId) =>
            options.legacyImporter!.stageImport(userId, input.candidateId, input.confirmed),
          (userId, prepared) => options.legacyImporter!.commitImport(userId, prepared),
        ),
      AUTHORIZED_STATES,
      LEGACY_IMPORT_OPERATION_TIMEOUT_MS,
    );
    register(
      legacyData.resume,
      NoInput,
      LegacyImportResultSchema,
      () =>
        runLegacyOperation(
          (userId) => options.legacyImporter!.stageResumeImport(userId),
          (userId, prepared) => options.legacyImporter!.commitImport(userId, prepared),
        ),
      AUTHORIZED_STATES,
      LEGACY_IMPORT_OPERATION_TIMEOUT_MS,
    );
  }

  register(windowChannels.minimize, NoInput, MinimizedOutput, () => {
    options.window.minimize();
    return { minimized: true };
  });
  register(windowChannels.maximizeOrRestore, NoInput, MaximizedOutput, () => {
    if (options.window.isMaximized()) options.window.unmaximize();
    else options.window.maximize();
    return { maximized: options.window.isMaximized() };
  });
  register(windowChannels.close, NoInput, ClosedOutput, () => {
    setImmediate(() => {
      if (!options.window.isDestroyed()) options.window.close();
    });
    return { closed: true };
  });
  register(windowChannels.getPlatform, NoInput, PlatformOutput, () => ({
    platform: options.platform,
    arch: options.arch,
    version: options.version,
  }));
  register(feature.workspace, NoInput, WorkspaceUnavailable, () => ({
    available: false,
    reason: "D4_LOCAL_AGENT_PENDING",
  }));
  register(feature.browser, NoInput, WorkspaceUnavailable, () => ({
    available: false,
    reason: "D4_LOCAL_AGENT_PENDING",
  }));
  register(feature.update, NoInput, UpdateUnavailable, () => ({
    available: false,
    reason: "D6_UPDATER_PENDING",
  }));

  const unsubscribe = options.controller.subscribe((state) => {
    if (options.window.isDestroyed() || options.window.webContents.isDestroyed()) return;
    if (!isTrustedUrl(options.window.webContents.mainFrame.url, options.rendererTrust)) return;
    const projected = options.projectAccountState?.(state) ?? state;
    const safeState = AccountStateSchema.safeParse(projected);
    if (safeState.success) options.window.webContents.send(account.state, safeState.data);
  });

  return () => {
    unsubscribe();
    for (const channel of registered) main.removeHandler(channel);
  };
}

function assertTrustedCaller(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  trust: DesktopRendererTrust,
): void {
  if (
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    event.sender !== window.webContents ||
    event.sender.isDestroyed() ||
    event.senderFrame === null ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedUrl(event.senderFrame.url, trust)
  ) {
    throw new AccountOperationError(
      "IPC_CALLER_INVALID",
      "The desktop request came from an untrusted frame.",
    );
  }
}

function isTrustedUrl(source: string, trust: DesktopRendererTrust): boolean {
  try {
    const url = new URL(source);
    if (
      url.protocol === "caelush-login:" &&
      url.hostname === "app" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    ) {
      return true;
    }
    if (trust.developmentOrigin === null) return false;
    return (
      url.origin === trust.developmentOrigin &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

function validateInputSize(value: unknown): void {
  if (value === undefined) return;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new AccountOperationError("IPC_INPUT_INVALID", "The desktop request input is invalid.");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_IPC_INPUT_BYTES) {
    throw new AccountOperationError(
      "IPC_INPUT_TOO_LARGE",
      "The desktop request exceeds its size limit.",
    );
  }
}
