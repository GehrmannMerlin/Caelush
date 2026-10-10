import { join } from "node:path";
import { app, BrowserWindow, dialog, protocol, safeStorage, session } from "electron";
import { AccountController } from "./account/controller.js";
import type { AccountState } from "./account/state.js";
import { CloudAccountClient } from "./cloud/client.js";
import { DpapiVault } from "./credentials/vault.js";
import { ProviderCredentialVault } from "./credentials/provider-credential-vault.js";
import { DesktopProviderCredentialMigrator } from "./migration/provider-credential-migration.js";
import { DesktopLegacyDataImporter } from "./migration/legacy-data-import.js";
import { BUILD_CONFIGURATION, trustedOfflineKeys } from "./build-config.js";
import { registerDesktopIpc } from "./ipc/handlers.js";
import { registerAppProtocol } from "./protocol/app-protocol.js";
import { DesktopLocalProxy } from "./protocol/local-proxy.js";
import {
  ProfileManager,
  ProfileManagerError,
  WindowsProfilePermissions,
} from "./profiles/profile-manager.js";
import { resolveDesktopDaemonResources, resolveDesktopWebRoot } from "./daemon/resources.js";
import { DesktopDaemonSupervisor } from "./daemon/supervisor.js";
import { createMainWindow } from "./windows/create-window.js";
import { createRendererTrust } from "./windows/security-policy.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "caelush-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: "caelush-login",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

app.setName("Caelush Desktop");
if (process.platform === "win32") app.setAppUserModelId("com.caelush.desktop");

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let disposeIpc: (() => void) | null = null;
  let unsubscribeAccount: (() => void) | null = null;
  let safeQuitApproved = false;
  let shutdownInProgress = false;
  const rendererTrust = createRendererTrust(app.isPackaged, process.env.CAELUSH_DESKTOP_DEV_URL);
  const cloud = new CloudAccountClient(BUILD_CONFIGURATION.cloudOrigin);
  const vault = new DpapiVault(join(app.getPath("userData"), "credentials.dpapi"), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptStringAsync: (value) => safeStorage.encryptStringAsync(value),
    decryptStringAsync: async (value) =>
      (await safeStorage.decryptStringAsync(Buffer.from(value))).result,
  });
  const account = new AccountController({
    vault,
    cloud,
    trustedOfflinePublicKeys: trustedOfflineKeys(),
  });
  const providerCredentialVault = new ProviderCredentialVault(vault);
  const providerCredentialMigrator = new DesktopProviderCredentialMigrator({
    vault,
    credentials: providerCredentialVault,
  });
  const localAppDataDirectory = process.env.LOCALAPPDATA;
  const profileManager = localAppDataDirectory
    ? new ProfileManager({
        localAppDataDirectory,
        platform: process.platform,
        permissions: new WindowsProfilePermissions(process.platform),
      })
    : {
        selectForUser: async () => {
          throw new ProfileManagerError(
            "PROFILE_PATH_UNSAFE",
            "The Windows local account profile directory is unavailable.",
          );
        },
      };
  const legacyImporter = new DesktopLegacyDataImporter({
    profileManager,
    vault,
    credentialMigrator: providerCredentialMigrator,
    assertAuthorized: (cloudUserId) => {
      const state = account.getState();
      if (
        (state.status !== "AUTHENTICATED_ONLINE" && state.status !== "AUTHORIZED_OFFLINE") ||
        state.account?.userId !== cloudUserId
      ) {
        throw new Error("The active account changed during local data import.");
      }
    },
    onProgress: (progress) => {
      if (mainWindow === null || mainWindow.isDestroyed() || !isTrustedCurrentWindow()) return;
      mainWindow.webContents.send("caelush:legacy-data:progress", { progress });
    },
  });
  const supervisor = new DesktopDaemonSupervisor({
    profileManager,
    credentialVault: providerCredentialVault,
    credentialMigrator: providerCredentialMigrator,
    resolveResources: () =>
      resolveDesktopDaemonResources({
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      }),
    productVersion: app.getVersion(),
    onlineExpiry: () => account.getOnlineSessionExpiresAt(),
    onAuthorizationExpired: (state) => {
      if (state === "ONLINE") account.expireOnlineSession();
      else account.expireOfflineGrant();
    },
    onStateChange: publishProjectedAccountState,
  });
  const proxy = new DesktopLocalProxy({
    acquireLease: (requestSignal) => supervisor.acquireProxyLease(requestSignal),
  });

  function projectAccountState(state: AccountState): AccountState {
    return { ...state, agentEntry: supervisor.getAgentEntry(state) };
  }

  function publishProjectedAccountState(): void {
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed())
      return;
    if (!isTrustedCurrentWindow()) return;
    mainWindow.webContents.send("caelush:account:state", projectAccountState(account.getState()));
  }

  function isTrustedCurrentWindow(): boolean {
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return false;
    }
    try {
      const url = new URL(mainWindow.webContents.mainFrame.url);
      return (
        (url.protocol === "caelush-login:" && url.hostname === "app") ||
        (rendererTrust.developmentOrigin !== null && url.origin === rendererTrust.developmentOrigin)
      );
    } catch {
      return false;
    }
  }

  async function closeManagedDaemon(): Promise<void> {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    try {
      await supervisor.closeForApplicationQuit();
    } finally {
      shutdownInProgress = false;
    }
  }

  app.on("second-instance", () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const appPath = app.getAppPath();
    registerAppProtocol({
      rendererRoot: join(appPath, "dist", "renderer"),
      agentRoot: resolveDesktopWebRoot({
        packaged: app.isPackaged,
        appPath,
        resourcesPath: process.resourcesPath,
      }),
      localProxy: proxy,
      isAgentAvailable: () => supervisor.getAgentEntry(account.getState()).available,
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    unsubscribeAccount = account.subscribe((state) => {
      void supervisor
        .synchronizeAccountState(state)
        .catch(() => undefined)
        .finally(publishProjectedAccountState);
    });
    openMainWindow();
    void account.initialize().then(async () => {
      try {
        await supervisor.synchronizeAccountState(account.getState());
      } catch {
        publishProjectedAccountState();
      }
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      safeQuitApproved = false;
      openMainWindow();
      void supervisor.synchronizeAccountState(account.getState()).catch(() => undefined);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (!safeQuitApproved) {
      event.preventDefault();
      if (shutdownInProgress) return;
      void closeManagedDaemon()
        .then(() => {
          safeQuitApproved = true;
          app.quit();
        })
        .catch(() => showSafeShutdownBlocked());
      return;
    }
    unsubscribeAccount?.();
    unsubscribeAccount = null;
    disposeIpc?.();
    disposeIpc = null;
  });

  function openMainWindow(): void {
    if (mainWindow !== null && !mainWindow.isDestroyed()) return;
    const appPath = app.getAppPath();
    mainWindow = createMainWindow({
      appPath,
      preloadPath: join(appPath, "dist", "preload", "index.cjs"),
      rendererTrust,
    });
    disposeIpc = registerDesktopIpc({
      window: mainWindow,
      controller: account,
      rendererTrust,
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      projectAccountState,
      beginAccountBoundary: () => supervisor.beginAccountBoundary(),
      synchronizeAccountState: (state) => supervisor.synchronizeAccountState(state),
      legacyImporter,
    });
    mainWindow.on("close", (event) => {
      if (safeQuitApproved) return;
      event.preventDefault();
      if (shutdownInProgress) return;
      void closeManagedDaemon()
        .then(() => {
          safeQuitApproved = true;
          mainWindow?.close();
        })
        .catch(() => showSafeShutdownBlocked());
    });
    mainWindow.on("closed", () => {
      disposeIpc?.();
      disposeIpc = null;
      mainWindow = null;
    });
  }

  function showSafeShutdownBlocked(): void {
    const message =
      "Caelush is waiting for the local Agent to reach a safe shutdown point. The signed-in Profile remains active; retry closing Desktop after the local operation finishes.";
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Local Agent is still active",
        message,
        buttons: ["OK"],
        noLink: true,
      });
    } else {
      openMainWindow();
      if (mainWindow !== null) {
        void dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "Local Agent is still active",
          message,
          buttons: ["OK"],
          noLink: true,
        });
      }
    }
  }
}
