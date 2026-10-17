import electron = require("electron");
import type { AccountState } from "../main/account/state.js";
import type { DesktopApi } from "./api-types.js";
import type { AppearanceSnapshot, ThemePreference } from "@caelush/ui-theme/appearance";
import type { LegacyImportProgress } from "../shared/legacy-data-contract.js";
import type { DesktopReleaseHistoryItem, DesktopUpdateState } from "../shared/update-contract.js";

const channels = {
  appearance: {
    initialSnapshot: "caelush:appearance:initial-snapshot",
    getSnapshot: "caelush:appearance:get-snapshot",
    setPreference: "caelush:appearance:set-preference",
    snapshot: "caelush:appearance:snapshot",
  },
  archive: {
    listSessions: "caelush:archive:list-sessions",
    listWorkspaces: "caelush:archive:list-workspaces",
    getState: "caelush:archive:get-state",
    archive: "caelush:archive:archive",
    restore: "caelush:archive:restore",
    previewDeletion: "caelush:archive:preview-deletion",
    permanentlyDelete: "caelush:archive:permanently-delete",
    readTranscript: "caelush:archive:read-transcript",
  },
  profileCenter: {
    getSnapshot: "caelush:profile-center:get-snapshot",
    getModelSettings: "caelush:profile-center:get-model-settings",
    connectProvider: "caelush:profile-center:connect-provider",
    disconnectProvider: "caelush:profile-center:disconnect-provider",
  },
  account: {
    state: "caelush:account:state",
    getState: "caelush:account:get-state",
    retryAgentStartup: "caelush:account:retry-agent-startup",
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
    getProfile: "caelush:account:get-profile",
    getSidebarProfile: "caelush:account:get-sidebar-profile",
    updateProfile: "caelush:account:update-profile",
    selectAvatar: "caelush:account:select-avatar",
  },
  window: {
    minimize: "caelush:window:minimize",
    maximizeOrRestore: "caelush:window:maximize-or-restore",
    close: "caelush:window:close",
    getPlatform: "caelush:window:get-platform",
  },
  feature: {
    workspace: "caelush:feature:workspace",
    browser: "caelush:feature:browser",
    update: "caelush:feature:update",
  },
  update: {
    getState: "caelush:update:get-state",
    getReleaseHistory: "caelush:update:get-release-history",
    check: "caelush:update:check",
    download: "caelush:update:download",
    install: "caelush:update:install",
    cancelDownload: "caelush:update:cancel-download",
    deferInstall: "caelush:update:defer-install",
    state: "caelush:update:state",
  },
  workspace: {
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
  },
  browser: {
    availability: "caelush:browser:get-availability",
    createLease: "caelush:browser:create-lease",
    navigate: "caelush:browser:navigate",
    goBack: "caelush:browser:go-back",
    goForward: "caelush:browser:go-forward",
    reload: "caelush:browser:reload",
    setBounds: "caelush:browser:set-bounds",
    closeLease: "caelush:browser:close-lease",
    state: "caelush:browser:state",
  },
  legacyData: {
    inspect: "caelush:legacy-data:inspect",
    import: "caelush:legacy-data:import",
    resume: "caelush:legacy-data:resume",
    progress: "caelush:legacy-data:progress",
  },
} as const;

class DesktopApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DesktopApiError";
  }
}

function unwrapIpcResult<T>(result: unknown): T {
  if (
    result === null ||
    typeof result !== "object" ||
    !("ok" in result) ||
    typeof result.ok !== "boolean"
  ) {
    throw new DesktopApiError(
      "IPC_RESPONSE_INVALID",
      "The desktop request returned an invalid response.",
    );
  }
  if (!result.ok) {
    const error = "error" in result ? result.error : null;
    if (
      error === null ||
      typeof error !== "object" ||
      !("code" in error) ||
      typeof error.code !== "string" ||
      !("message" in error) ||
      typeof error.message !== "string"
    ) {
      throw new DesktopApiError(
        "IPC_RESPONSE_INVALID",
        "The desktop request returned an invalid response.",
      );
    }
    throw new DesktopApiError(error.code, error.message.slice(0, 512));
  }
  if (!("value" in result)) {
    throw new DesktopApiError(
      "IPC_RESPONSE_INVALID",
      "The desktop request returned an invalid response.",
    );
  }
  return result.value as T;
}

const accountApi: DesktopApi["account"] = {
  getState: async () =>
    unwrapIpcResult<AccountState>(await electron.ipcRenderer.invoke(channels.account.getState)),
  retryAgentStartup: async () =>
    unwrapIpcResult<AccountState>(
      await electron.ipcRenderer.invoke(channels.account.retryAgentStartup),
    ),
  subscribeState(listener: (state: AccountState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: AccountState) => listener(state);
    electron.ipcRenderer.on(channels.account.state, handler);
    return () => electron.ipcRenderer.removeListener(channels.account.state, handler);
  },
  register: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.register, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["register"]>>>(result),
      ),
  login: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.login, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["login"]>>>(result),
      ),
  logout: async () =>
    unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["logout"]>>>(
      await electron.ipcRenderer.invoke(channels.account.logout),
    ),
  resendVerification: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.resendVerification, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["resendVerification"]>>>(result),
      ),
  verifyEmail: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.verifyEmail, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["verifyEmail"]>>>(result),
      ),
  forgotPassword: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.forgotPassword, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["forgotPassword"]>>>(result),
      ),
  resetPassword: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.resetPassword, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["resetPassword"]>>>(result),
      ),
  changePassword: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.changePassword, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["changePassword"]>>>(result),
      ),
  refreshNow: async () =>
    unwrapIpcResult<AccountState>(await electron.ipcRenderer.invoke(channels.account.refreshNow)),
  listDevices: async () =>
    unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["listDevices"]>>>(
      await electron.ipcRenderer.invoke(channels.account.listDevices),
    ),
  revokeDevice: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.revokeDevice, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["revokeDevice"]>>>(result),
      ),
  getProfile: async () =>
    unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["getProfile"]>>>(
      await electron.ipcRenderer.invoke(channels.account.getProfile),
    ),
  getSidebarProfile: async () =>
    unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["getSidebarProfile"]>>>(
      await electron.ipcRenderer.invoke(channels.account.getSidebarProfile),
    ),
  updateProfile: (input) =>
    electron.ipcRenderer
      .invoke(channels.account.updateProfile, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["updateProfile"]>>>(result),
      ),
  selectAvatar: async () =>
    unwrapIpcResult<Awaited<ReturnType<DesktopApi["account"]["selectAvatar"]>>>(
      await electron.ipcRenderer.invoke(channels.account.selectAvatar),
    ),
};

const legacyDataApi: DesktopApi["legacyData"] = {
  inspect: async () =>
    unwrapIpcResult<Awaited<ReturnType<DesktopApi["legacyData"]["inspect"]>>>(
      await electron.ipcRenderer.invoke(channels.legacyData.inspect),
    ),
  import: (input) =>
    electron.ipcRenderer
      .invoke(channels.legacyData.import, input)
      .then((result) =>
        unwrapIpcResult<Awaited<ReturnType<DesktopApi["legacyData"]["import"]>>>(result),
      ),
  resume: async () =>
    unwrapIpcResult<Awaited<ReturnType<DesktopApi["legacyData"]["resume"]>>>(
      await electron.ipcRenderer.invoke(channels.legacyData.resume),
    ),
  subscribeProgress(listener) {
    const allowed = new Set<LegacyImportProgress>([
      "BACKUP_VERIFIED",
      "IMPORT_STAGED",
      "DESTINATION_VERIFIED",
      "CREDENTIALS_SECURED",
      "COMMITTED",
      "RECOVERY_REQUIRED",
    ]);
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (
        value !== null &&
        typeof value === "object" &&
        "progress" in value &&
        typeof value.progress === "string" &&
        allowed.has(value.progress as LegacyImportProgress)
      ) {
        listener(value.progress as LegacyImportProgress);
      }
    };
    electron.ipcRenderer.on(channels.legacyData.progress, handler);
    return () => electron.ipcRenderer.removeListener(channels.legacyData.progress, handler);
  },
};

const desktopWorkspaceApi: DesktopApi["workspace"] = {
  getAvailability: async () =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.availability)),
  subscribeAvailability(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (
        value !== null &&
        typeof value === "object" &&
        "available" in value &&
        typeof value.available === "boolean"
      ) {
        listener(value.available);
      }
    };
    electron.ipcRenderer.on(channels.workspace.availabilityState, handler);
    return () => electron.ipcRenderer.removeListener(channels.workspace.availabilityState, handler);
  },
  activate: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.activate, input)),
  listEntries: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.listEntries, input)),
  previewText: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.previewText, input)),
  listEditors: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.listEditors, input)),
  openInEditor: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.openInEditor, input)),
  terminal: Object.freeze({
    create: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.terminalCreate, input)),
    write: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.terminalWrite, input)),
    resize: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.terminalResize, input)),
    close: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.workspace.terminalClose, input)),
    acknowledgeOutput: async (input) =>
      unwrapIpcResult(
        await electron.ipcRenderer.invoke(channels.workspace.terminalAcknowledge, input),
      ),
    async subscribeOutput(terminalId, listener) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(terminalId)) {
        throw new DesktopApiError(
          "TERMINAL_SESSION_INVALID",
          "The user terminal session is unavailable.",
        );
      }
      const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (isTerminalOutput(value, terminalId)) listener(value);
      };
      electron.ipcRenderer.on(channels.workspace.terminalOutput, handler);
      try {
        unwrapIpcResult(
          await electron.ipcRenderer.invoke(channels.workspace.terminalSubscribe, { terminalId }),
        );
      } catch (error) {
        electron.ipcRenderer.removeListener(channels.workspace.terminalOutput, handler);
        throw error;
      }
      return () => {
        electron.ipcRenderer.removeListener(channels.workspace.terminalOutput, handler);
        void electron.ipcRenderer
          .invoke(channels.workspace.terminalUnsubscribe, { terminalId })
          .catch(() => undefined);
      };
    },
  }),
};

const desktopBrowserApi: DesktopApi["browser"] = {
  getAvailability: async () =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.browser.availability)),
  createLease: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.browser.createLease, input)),
  navigate: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.browser.navigate, input)),
  goBack: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.browser.goBack, input)),
  goForward: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.browser.goForward, input)),
  reload: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.browser.reload, input)),
  setBounds: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.browser.setBounds, input)),
  closeLease: async (input) =>
    unwrapIpcResult(await electron.ipcRenderer.invoke(channels.browser.closeLease, input)),
  subscribeState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isBrowserState(value)) listener(value);
    };
    electron.ipcRenderer.on(channels.browser.state, handler);
    return () => electron.ipcRenderer.removeListener(channels.browser.state, handler);
  },
};

function isTerminalOutput(
  value: unknown,
  terminalId: string,
): value is Parameters<Parameters<DesktopApi["workspace"]["terminal"]["subscribeOutput"]>[1]>[0] {
  return (
    value !== null &&
    typeof value === "object" &&
    "terminalId" in value &&
    value.terminalId === terminalId &&
    (!("data" in value) || typeof value.data === "string") &&
    (!("errorCode" in value) ||
      value.errorCode === "TERMINAL_OUTPUT_BACKPRESSURE" ||
      value.errorCode === "TERMINAL_UNAVAILABLE")
  );
}

function isBrowserState(
  value: unknown,
): value is Parameters<Parameters<DesktopApi["browser"]["subscribeState"]>[0]>[0] {
  return (
    value !== null &&
    typeof value === "object" &&
    "leaseId" in value &&
    typeof value.leaseId === "string" &&
    "url" in value &&
    typeof value.url === "string" &&
    "loading" in value &&
    typeof value.loading === "boolean"
  );
}

function isAppearanceSnapshot(value: unknown): value is AppearanceSnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    "preference" in value &&
    (value.preference === "light" ||
      value.preference === "dark" ||
      value.preference === "system") &&
    "resolvedTheme" in value &&
    (value.resolvedTheme === "light" || value.resolvedTheme === "dark") &&
    "revision" in value &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

const initialAppearanceSnapshot: AppearanceSnapshot = (() => {
  try {
    const snapshot: unknown = electron.ipcRenderer.sendSync(channels.appearance.initialSnapshot);
    if (isAppearanceSnapshot(snapshot)) return Object.freeze({ ...snapshot });
  } catch {
    // Older or untrusted renderer configurations retain the light default.
  }
  return Object.freeze({ preference: "light", resolvedTheme: "light", revision: 0 });
})();

const api: DesktopApi = Object.freeze({
  appearance: Object.freeze({
    capabilityVersion: 1 as const,
    initialSnapshot: initialAppearanceSnapshot,
    getSnapshot: async () =>
      unwrapIpcResult<AppearanceSnapshot>(
        await electron.ipcRenderer.invoke(channels.appearance.getSnapshot),
      ),
    setPreference: async (preference: ThemePreference) =>
      unwrapIpcResult<AppearanceSnapshot>(
        await electron.ipcRenderer.invoke(channels.appearance.setPreference, { preference }),
      ),
    subscribe(listener: (snapshot: AppearanceSnapshot) => void) {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (isAppearanceSnapshot(value)) listener(value);
      };
      electron.ipcRenderer.on(channels.appearance.snapshot, handler);
      return () => electron.ipcRenderer.removeListener(channels.appearance.snapshot, handler);
    },
  }),
  archive: Object.freeze<NonNullable<DesktopApi["archive"]>>({
    capabilityVersion: 1,
    listSessions: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.archive.listSessions, input)),
    listWorkspaces: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.archive.listWorkspaces, input)),
    getState: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.archive.getState, input)),
    archive: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.archive.archive, input)),
    restore: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.archive.restore, input)),
    previewDeletion: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.archive.previewDeletion, input)),
    permanentlyDelete: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.archive.permanentlyDelete, input)),
    readTranscript: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.archive.readTranscript, input)),
  }),
  profileCenter: Object.freeze<NonNullable<DesktopApi["profileCenter"]>>({
    capabilityVersion: 1,
    getSnapshot: async (input) =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.profileCenter.getSnapshot, input)),
    getModelSettings: async () =>
      unwrapIpcResult(await electron.ipcRenderer.invoke(channels.profileCenter.getModelSettings)),
    connectProvider: async (input) =>
      unwrapIpcResult(
        await electron.ipcRenderer.invoke(channels.profileCenter.connectProvider, input),
      ),
    disconnectProvider: async (input) =>
      unwrapIpcResult(
        await electron.ipcRenderer.invoke(channels.profileCenter.disconnectProvider, input),
      ),
  }),
  protocolVersion: 1,
  account: Object.freeze(accountApi),
  window: Object.freeze({
    minimize: async () =>
      unwrapIpcResult<Awaited<ReturnType<DesktopApi["window"]["minimize"]>>>(
        await electron.ipcRenderer.invoke(channels.window.minimize),
      ),
    maximizeOrRestore: async () =>
      unwrapIpcResult<Awaited<ReturnType<DesktopApi["window"]["maximizeOrRestore"]>>>(
        await electron.ipcRenderer.invoke(channels.window.maximizeOrRestore),
      ),
    close: async () =>
      unwrapIpcResult<Awaited<ReturnType<DesktopApi["window"]["close"]>>>(
        await electron.ipcRenderer.invoke(channels.window.close),
      ),
    getPlatform: async () =>
      unwrapIpcResult<Awaited<ReturnType<DesktopApi["window"]["getPlatform"]>>>(
        await electron.ipcRenderer.invoke(channels.window.getPlatform),
      ),
  }),
  workspace: Object.freeze(desktopWorkspaceApi),
  browser: Object.freeze(desktopBrowserApi),
  update: Object.freeze({
    getReleaseHistory: async () =>
      unwrapIpcResult<DesktopReleaseHistoryItem[]>(
        await electron.ipcRenderer.invoke(channels.update.getReleaseHistory),
      ),
    getState: async () =>
      unwrapIpcResult<DesktopUpdateState>(
        await electron.ipcRenderer.invoke(channels.update.getState),
      ),
    check: async () =>
      unwrapIpcResult<DesktopUpdateState>(await electron.ipcRenderer.invoke(channels.update.check)),
    download: async () =>
      unwrapIpcResult<DesktopUpdateState>(
        await electron.ipcRenderer.invoke(channels.update.download),
      ),
    install: async () =>
      unwrapIpcResult<DesktopUpdateState>(
        await electron.ipcRenderer.invoke(channels.update.install),
      ),
    cancelDownload: async () =>
      unwrapIpcResult<DesktopUpdateState>(
        await electron.ipcRenderer.invoke(channels.update.cancelDownload),
      ),
    deferInstall: async () =>
      unwrapIpcResult<DesktopUpdateState>(
        await electron.ipcRenderer.invoke(channels.update.deferInstall),
      ),
    subscribeState: (listener: (state: DesktopUpdateState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) =>
        listener(state);
      electron.ipcRenderer.on(channels.update.state, handler);
      return () => electron.ipcRenderer.removeListener(channels.update.state, handler);
    },
    getAvailability: async () =>
      unwrapIpcResult<Awaited<ReturnType<DesktopApi["update"]["getAvailability"]>>>(
        await electron.ipcRenderer.invoke(channels.feature.update),
      ),
  }),
  legacyData: Object.freeze(legacyDataApi),
});

electron.contextBridge.exposeInMainWorld("caelushDesktop", api);
