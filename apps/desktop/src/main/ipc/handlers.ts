import { setImmediate } from "node:timers";
import { BrowserWindow, ipcMain, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { WorkspaceIdSchema } from "@caelush/protocol";
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
import { DesktopWorkspacePanelController } from "../workspace/panel-controller.js";

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
  workspace: Object.freeze({
    availability: "caelush:workspace:get-availability",
    availabilityState: "caelush:workspace:availability-state",
    activate: "caelush:workspace:activate",
    listEntries: "caelush:workspace:list-entries",
    previewText: "caelush:workspace:preview-text",
    listEditors: "caelush:workspace:list-editors",
    openInEditor: "caelush:workspace:open-in-editor",
    terminalCreate: "caelush:workspace:terminal:create",
    terminalWrite: "caelush:workspace:terminal:write",
    terminalResize: "caelush:workspace:terminal:resize",
    terminalClose: "caelush:workspace:terminal:close",
    terminalSubscribe: "caelush:workspace:terminal:subscribe",
    terminalUnsubscribe: "caelush:workspace:terminal:unsubscribe",
    terminalAcknowledge: "caelush:workspace:terminal:acknowledge",
    terminalOutput: "caelush:workspace:terminal:output",
  }),
  browser: Object.freeze({
    availability: "caelush:browser:get-availability",
    createLease: "caelush:browser:create-lease",
    navigate: "caelush:browser:navigate",
    goBack: "caelush:browser:go-back",
    goForward: "caelush:browser:go-forward",
    reload: "caelush:browser:reload",
    setBounds: "caelush:browser:set-bounds",
    closeLease: "caelush:browser:close-lease",
    state: "caelush:browser:state",
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
const PanelAvailability = z.union([
  z.object({ available: z.literal(true) }).strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.enum(["ACCOUNT_NOT_AUTHORIZED", "DAEMON_STARTING"]),
    })
    .strict(),
]);
const WorkspaceIdInput = z.object({ workspaceId: WorkspaceIdSchema }).strict();
const ActivateWorkspaceInput = z.object({ workspaceId: WorkspaceIdSchema.nullable() }).strict();
const ListEntriesInput = z
  .object({
    workspaceId: WorkspaceIdSchema,
    relativePath: z.string().max(4096),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();
const PreviewTextInput = z
  .object({ workspaceId: WorkspaceIdSchema, relativePath: z.string().min(1).max(4096) })
  .strict();
const WorkspaceEntryOutput = z
  .object({
    name: z.string().max(255),
    relativePath: z.string().max(4096),
    kind: z.enum(["FILE", "DIRECTORY", "SYMLINK", "OTHER"]),
    extension: z.string().max(32),
    sizeBytes: z.number().int().nonnegative().safe().optional(),
    modifiedAtMs: z.number().int().safe().optional(),
    canExpand: z.boolean(),
    canPreview: z.boolean(),
  })
  .strict();
const DirectoryPageOutput = z
  .object({
    workspaceId: WorkspaceIdSchema,
    relativePath: z.string().max(4096),
    parentPath: z.string().max(4096).nullable(),
    items: z.array(WorkspaceEntryOutput).max(500),
    nextOffset: z.number().int().nonnegative().safe().optional(),
    hasMore: z.boolean(),
  })
  .strict();
const PreviewOutput = z.union([
  z
    .object({
      supported: z.literal(true),
      workspaceId: WorkspaceIdSchema,
      relativePath: z.string().max(4096),
      name: z.string().max(255),
      sizeBytes: z.number().int().nonnegative().safe(),
      modifiedAtMs: z.number().int().safe(),
      text: z.string().max(1_048_576),
    })
    .strict(),
  z
    .object({
      supported: z.literal(false),
      reason: z.literal("BINARY"),
      workspaceId: WorkspaceIdSchema,
      relativePath: z.string().max(4096),
      name: z.string().max(255),
      sizeBytes: z.number().int().nonnegative().safe(),
      modifiedAtMs: z.number().int().safe(),
    })
    .strict(),
]);
const EditorListOutput = z
  .array(
    z
      .object({ id: z.enum(["vscode", "cursor"]), name: z.enum(["Visual Studio Code", "Cursor"]) })
      .strict(),
  )
  .max(2);
const OpenEditorInput = z
  .object({
    editorId: z.enum(["vscode", "cursor"]),
    workspaceId: WorkspaceIdSchema,
    relativeFilePath: z.string().min(1).max(4096).optional(),
  })
  .strict();
const TerminalIdInput = z.object({ terminalId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
const TerminalCreateInput = z
  .object({
    workspaceId: WorkspaceIdSchema,
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(300),
  })
  .strict();
const TerminalWriteInput = TerminalIdInput.extend({ data: z.string().max(16 * 1024) }).strict();
const TerminalResizeInput = TerminalIdInput.extend({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(300),
}).strict();
const TerminalAckInput = TerminalIdInput.extend({
  bytes: z
    .number()
    .int()
    .min(0)
    .max(16 * 1024),
}).strict();
const TerminalAcceptedOutput = z.object({ accepted: z.literal(true) }).strict();
const TerminalSessionOutput = z
  .object({
    terminalId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    workspaceId: WorkspaceIdSchema,
    cwd: z.string().max(4096),
    identity: z.literal("USER_TERMINAL"),
    shell: z.literal("WINDOWS_POWERSHELL"),
    cols: z.number().int(),
    rows: z.number().int(),
  })
  .strict();
const TerminalOutputSchema = z
  .object({
    terminalId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    data: z
      .string()
      .max(16 * 1024)
      .optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().max(32).nullable().optional(),
    errorCode: z.enum(["TERMINAL_OUTPUT_BACKPRESSURE", "TERMINAL_UNAVAILABLE"]).optional(),
  })
  .strict();
const BrowserBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(10000),
    y: z.number().int().min(0).max(10000),
    width: z.number().int().min(1).max(10000),
    height: z.number().int().min(1).max(10000),
  })
  .strict();
const BrowserBoundsInput = BrowserBoundsSchema.nullable();
const BrowserLeaseInput = z.object({ leaseId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
const BrowserCreateInput = z.object({ bounds: BrowserBoundsSchema }).strict();
const BrowserNavigateInput = BrowserLeaseInput.extend({
  url: z.string().min(1).max(2048),
}).strict();
const BrowserBoundsUpdateInput = BrowserLeaseInput.extend({ bounds: BrowserBoundsInput }).strict();
const BrowserStateOutput = z
  .object({
    leaseId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    url: z.string().max(2048),
    loading: z.boolean(),
    errorCode: z.enum(["BROWSER_NAVIGATION_FAILED", "BROWSER_GUEST_CRASHED"]).optional(),
  })
  .strict();
const SubscribedOutput = z.object({ subscribed: z.boolean() }).strict();
const AcknowledgedOutput = z.object({ acknowledged: z.literal(true) }).strict();
const UpdatedOutput = z.object({ updated: z.literal(true) }).strict();
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
  readonly desktopPanels?: DesktopWorkspacePanelController;
}

type IpcCallerPolicy = "LOGIN" | "AGENT" | "LOGIN_OR_AGENT";

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
    callerPolicy: IpcCallerPolicy = "LOGIN",
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
        assertTrustedCaller(event, options.window, options.rendererTrust, callerPolicy);
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
  register(
    windowChannels.getPlatform,
    NoInput,
    PlatformOutput,
    () => ({
      platform: options.platform,
      arch: options.arch,
      version: options.version,
    }),
    undefined,
    IPC_OPERATION_TIMEOUT_MS,
    "LOGIN_OR_AGENT",
  );

  if (options.desktopPanels !== undefined) {
    const panels = options.desktopPanels;
    const { workspace, browser } = IPC_CHANNELS;
    register(
      workspace.availability,
      NoInput,
      PanelAvailability,
      () => panels.getAvailability(),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.activate,
      ActivateWorkspaceInput,
      z.object({ selected: z.literal(true) }).strict(),
      (input, signal) =>
        panels.activateWorkspace(options.window.webContents.id, input.workspaceId, signal),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.listEntries,
      ListEntriesInput,
      DirectoryPageOutput,
      (input, signal) => panels.listEntries(options.window.webContents.id, input, signal),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.previewText,
      PreviewTextInput,
      PreviewOutput,
      (input, signal) => panels.previewText(options.window.webContents.id, input, signal),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.listEditors,
      WorkspaceIdInput,
      EditorListOutput,
      (input, signal) =>
        panels.listEditors(options.window.webContents.id, input.workspaceId, signal),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.openInEditor,
      OpenEditorInput,
      z.object({ opened: z.literal(true), editorId: z.enum(["vscode", "cursor"]) }).strict(),
      (input, signal) =>
        panels.openInEditor(
          options.window.webContents.id,
          {
            editorId: input.editorId,
            workspaceId: input.workspaceId,
            ...(input.relativeFilePath === undefined
              ? {}
              : { relativeFilePath: input.relativeFilePath }),
          },
          signal,
        ),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.terminalCreate,
      TerminalCreateInput,
      TerminalSessionOutput,
      (input, signal) => panels.createTerminal(options.window.webContents.id, input, signal),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.terminalWrite,
      TerminalWriteInput,
      TerminalAcceptedOutput,
      (input) => panels.writeTerminal(options.window.webContents.id, input.terminalId, input.data),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.terminalResize,
      TerminalResizeInput,
      TerminalAcceptedOutput,
      (input) =>
        panels.resizeTerminal(
          options.window.webContents.id,
          input.terminalId,
          input.cols,
          input.rows,
        ),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.terminalClose,
      TerminalIdInput,
      ClosedOutput,
      (input) => panels.closeTerminal(options.window.webContents.id, input.terminalId),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.terminalSubscribe,
      TerminalIdInput,
      SubscribedOutput,
      (input) => panels.subscribeTerminal(options.window.webContents.id, input.terminalId),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.terminalUnsubscribe,
      TerminalIdInput,
      SubscribedOutput,
      (input) => panels.unsubscribeTerminal(options.window.webContents.id, input.terminalId),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      workspace.terminalAcknowledge,
      TerminalAckInput,
      AcknowledgedOutput,
      (input) =>
        panels.acknowledgeTerminal(options.window.webContents.id, input.terminalId, input.bytes),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );

    register(
      browser.availability,
      NoInput,
      PanelAvailability,
      () => panels.getAvailability(),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      browser.createLease,
      BrowserCreateInput,
      BrowserStateOutput,
      (input) => panels.createBrowserLease(options.window.webContents.id, input.bounds),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      browser.navigate,
      BrowserNavigateInput,
      BrowserStateOutput,
      (input, signal) =>
        panels.navigateBrowser(options.window.webContents.id, input.leaseId, input.url, signal),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      browser.goBack,
      BrowserLeaseInput,
      BrowserStateOutput,
      (input) => panels.goBackBrowser(options.window.webContents.id, input.leaseId),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      browser.goForward,
      BrowserLeaseInput,
      BrowserStateOutput,
      (input) => panels.goForwardBrowser(options.window.webContents.id, input.leaseId),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      browser.reload,
      BrowserLeaseInput,
      BrowserStateOutput,
      (input) => panels.reloadBrowser(options.window.webContents.id, input.leaseId),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      browser.setBounds,
      BrowserBoundsUpdateInput,
      UpdatedOutput,
      (input) =>
        panels.setBrowserBounds(options.window.webContents.id, input.leaseId, input.bounds),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
    register(
      browser.closeLease,
      BrowserLeaseInput,
      ClosedOutput,
      (input) => panels.closeBrowserLease(options.window.webContents.id, input.leaseId),
      AUTHORIZED_STATES,
      IPC_OPERATION_TIMEOUT_MS,
      "AGENT",
    );
  }

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
  policy: IpcCallerPolicy,
): void {
  if (
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    event.sender !== window.webContents ||
    event.sender.isDestroyed() ||
    event.senderFrame === null ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedCallerUrl(event.senderFrame.url, trust, policy)
  ) {
    throw new AccountOperationError(
      "IPC_CALLER_INVALID",
      "The desktop request came from an untrusted frame.",
    );
  }
}

function isTrustedCallerUrl(
  source: string,
  trust: DesktopRendererTrust,
  policy: IpcCallerPolicy,
): boolean {
  if (trust.developmentOrigin !== null) {
    try {
      const development = new URL(trust.developmentOrigin);
      const candidate = new URL(source);
      if (
        candidate.origin === development.origin &&
        candidate.protocol === "http:" &&
        candidate.hostname === "127.0.0.1" &&
        candidate.username === "" &&
        candidate.password === "" &&
        candidate.search === "" &&
        candidate.hash === "" &&
        ["/", "/agent", "/agent/"].includes(candidate.pathname)
      ) {
        return policy !== "LOGIN";
      }
    } catch {
      // Continue with the production custom origins.
    }
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  const baseValid =
    url.port === "" && url.username === "" && url.password === "" && url.hash === "";
  const login = baseValid && url.protocol === "caelush-login:" && url.hostname === "app";
  const agent =
    baseValid &&
    url.protocol === "caelush-app:" &&
    url.hostname === "app" &&
    (url.pathname === "/agent" || url.pathname === "/agent/");
  if (policy === "LOGIN") return login;
  if (policy === "AGENT") return agent;
  return login || agent;
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
