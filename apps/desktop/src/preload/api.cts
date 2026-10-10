import electron = require("electron");
import type { AccountState } from "../main/account/state.js";
import type { DesktopApi } from "./api-types.js";
import type { LegacyImportProgress } from "../shared/legacy-data-contract.js";

const channels = {
  account: {
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

const api: DesktopApi = Object.freeze({
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
  workspace: Object.freeze({
    getAvailability: async () =>
      unwrapIpcResult<Awaited<ReturnType<DesktopApi["workspace"]["getAvailability"]>>>(
        await electron.ipcRenderer.invoke(channels.feature.workspace),
      ),
  }),
  browser: Object.freeze({
    getAvailability: async () =>
      unwrapIpcResult<Awaited<ReturnType<DesktopApi["browser"]["getAvailability"]>>>(
        await electron.ipcRenderer.invoke(channels.feature.browser),
      ),
  }),
  update: Object.freeze({
    getAvailability: async () =>
      unwrapIpcResult<Awaited<ReturnType<DesktopApi["update"]["getAvailability"]>>>(
        await electron.ipcRenderer.invoke(channels.feature.update),
      ),
  }),
  legacyData: Object.freeze(legacyDataApi),
});

electron.contextBridge.exposeInMainWorld("caelushDesktop", api);
