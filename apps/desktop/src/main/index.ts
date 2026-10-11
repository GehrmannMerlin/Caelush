import { basename, join } from "node:path";
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
import {
  resolveDesktopDaemonResources,
  resolveDesktopWebRoot,
  verifyPackagedDesktopResources,
} from "./daemon/resources.js";
import { DesktopDaemonSupervisor } from "./daemon/supervisor.js";
import { DesktopWorkspacePanelController } from "./workspace/panel-controller.js";
import { createMainWindow } from "./windows/create-window.js";
import { createRendererTrust } from "./windows/security-policy.js";

logD6Startup("MAIN_MODULE", {
  electronVersion: process.versions.electron ?? "unknown",
  executablePath: process.execPath,
  cwd: process.cwd(),
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  packaged: app.isPackaged,
});
process.on("uncaughtExceptionMonitor", (error) => {
  logD6Startup("UNCAUGHT_EXCEPTION", { name: error.name });
});

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
  let desktopPanels: DesktopWorkspacePanelController | null = null;
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
    const profileAvailable = supervisor.getActiveProfileIdentity() !== null;
    if (!profileAvailable && desktopPanels !== null) {
      void desktopPanels.closeAll().catch(() => undefined);
    }
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed())
      return;
    if (isTrustedCurrentWindow()) {
      mainWindow.webContents.send("caelush:account:state", projectAccountState(account.getState()));
    }
    if (isTrustedAgentWindow()) {
      mainWindow.webContents.send("caelush:workspace:availability-state", {
        available: profileAvailable,
      });
    }
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
    logD6Startup("DAEMON_GRACEFUL_CLOSE_STARTED");
    try {
      await desktopPanels?.closeAll();
      const daemonExitCode = await supervisor.closeForApplicationQuit();
      logD6Startup("DAEMON_GRACEFUL_CLOSE_COMPLETED", { daemonExitCode });
    } catch (error) {
      logD6Startup("DAEMON_GRACEFUL_CLOSE_FAILED", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      throw error;
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

  app.whenReady().then(async () => {
    logD6Startup("APP_WHEN_READY", { userDataPath: app.getPath("userData") });
    if (app.isPackaged) {
      try {
        const verified = await verifyPackagedDesktopResources(
          {
            packaged: true,
            appPath: app.getAppPath(),
            resourcesPath: process.resourcesPath,
          },
          (stage) => logD6Startup("RESOURCE_VERIFY", { stage }),
        );
        logD6Startup("MANIFEST_VERIFIED", { verifiedFileCount: verified.verifiedFileCount });
      } catch (error) {
        logD6Startup("MANIFEST_REJECT", { reason: safeResourceVerificationFailure(error) });
        dialog.showErrorBox(
          "Caelush resources could not be verified",
          "The installed Caelush files are incomplete or do not match this application version. Repair or reinstall Caelush before continuing.",
        );
        app.quit();
        return;
      }
    }
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
    logD6Startup("APP_PROTOCOL_REGISTERED");
    unsubscribeAccount = account.subscribe((state) => {
      void supervisor
        .synchronizeAccountState(state)
        .catch(() => undefined)
        .finally(publishProjectedAccountState);
    });
    openMainWindow();
    logD6Startup("ACCOUNT_INITIALIZATION_STARTED");
    void account
      .initialize()
      .then(async () => {
        logD6Startup("ACCOUNT_INITIALIZATION_COMPLETED");
        try {
          await supervisor.synchronizeAccountState(account.getState());
        } catch {
          publishProjectedAccountState();
        }
      })
      .catch((error: unknown) => {
        logD6Startup("ACCOUNT_INITIALIZATION_FAILED", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
        publishProjectedAccountState();
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
    logD6Startup("BROWSER_WINDOW_CREATED", { url: mainWindow.webContents.getURL() });
    mainWindow.webContents.on("dom-ready", () => logD6Startup("RENDERER_DOM_READY"));
    mainWindow.webContents.on("did-finish-load", () =>
      logD6Startup("RENDERER_LOAD_FINISHED", { url: mainWindow?.webContents.getURL() ?? "" }),
    );
    mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedUrl) =>
      logD6Startup("RENDERER_LOAD_FAILED", {
        code,
        description: description.slice(0, 120),
        url: validatedUrl.slice(0, 240),
      }),
    );
    mainWindow.webContents.on("render-process-gone", (_event, details) =>
      logD6Startup("RENDERER_PROCESS_GONE", {
        reason: details.reason,
        exitCode: details.exitCode,
      }),
    );
    desktopPanels = new DesktopWorkspacePanelController({
      window: mainWindow,
      supervisor,
      resourceLayout: {
        packaged: app.isPackaged,
        appPath,
        resourcesPath: process.resourcesPath,
      },
      onTerminalOutput: (ownerId, output) => {
        if (
          mainWindow === null ||
          mainWindow.isDestroyed() ||
          mainWindow.webContents.isDestroyed() ||
          mainWindow.webContents.id !== ownerId ||
          !isTrustedAgentWindow()
        )
          return;
        mainWindow.webContents.send("caelush:workspace:terminal:output", output);
      },
      onBrowserState: (ownerId, state) => {
        if (
          mainWindow === null ||
          mainWindow.isDestroyed() ||
          mainWindow.webContents.isDestroyed() ||
          mainWindow.webContents.id !== ownerId ||
          !isTrustedAgentWindow()
        )
          return;
        mainWindow.webContents.send("caelush:browser:state", state);
      },
    });
    disposeIpc = registerDesktopIpc({
      window: mainWindow,
      controller: account,
      rendererTrust,
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      projectAccountState,
      beginAccountBoundary: async () => {
        await desktopPanels?.closeAll();
        await supervisor.beginAccountBoundary();
      },
      synchronizeAccountState: (state) => supervisor.synchronizeAccountState(state),
      legacyImporter,
      desktopPanels,
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
      const closedPanels = desktopPanels;
      desktopPanels = null;
      if (closedPanels !== null) {
        void closedPanels
          .closeAll()
          .finally(() => closedPanels.dispose())
          .catch(() => undefined);
      }
      disposeIpc?.();
      disposeIpc = null;
      mainWindow = null;
    });
  }

  function isTrustedAgentWindow(): boolean {
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed())
      return false;
    try {
      const url = new URL(mainWindow.webContents.mainFrame.url);
      return (
        url.protocol === "caelush-app:" &&
        url.hostname === "app" &&
        (url.pathname === "/agent" || url.pathname.startsWith("/agent/"))
      );
    } catch {
      return false;
    }
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

function logD6Startup(stage: string, details: Readonly<Record<string, unknown>> = {}): void {
  if (process.env.CAELUSH_D6_DIAGNOSTICS !== "1") return;
  const safeDetails = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === "string" ? value.replace(/[\r\n]+/gu, " ").slice(0, 256) : value,
    ]),
  );
  process.stderr.write(`D6_MAIN_STAGE=${JSON.stringify({ stage, ...safeDetails })}\n`);
}

function safeResourceVerificationFailure(error: unknown): string {
  if (error instanceof Error && /^DESKTOP_[A-Z0-9_]+(?::[A-Za-z0-9._/-]+)?$/u.test(error.message)) {
    return error.message.slice(0, 160);
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(code)) {
      const errorPath =
        "path" in error && typeof error.path === "string" ? basename(error.path) : "";
      const safeName = /^[A-Za-z0-9._-]{1,80}$/u.test(errorPath) ? `:${errorPath}` : "";
      return `OS_${code}${safeName}`;
    }
  }
  return "UNCLASSIFIED";
}
