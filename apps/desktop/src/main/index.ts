import { join } from "node:path";
import { app, BrowserWindow, protocol, safeStorage, session } from "electron";
import { AccountController } from "./account/controller.js";
import { CloudAccountClient } from "./cloud/client.js";
import { DpapiVault } from "./credentials/vault.js";
import { BUILD_CONFIGURATION, trustedOfflineKeys } from "./build-config.js";
import { registerDesktopIpc } from "./ipc/handlers.js";
import { registerAppProtocol } from "./protocol/app-protocol.js";
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
]);

app.setName("Caelush Desktop");
if (process.platform === "win32") app.setAppUserModelId("com.caelush.desktop");

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let disposeIpc: (() => void) | null = null;
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

  app.on("second-instance", () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const appPath = app.getAppPath();
    registerAppProtocol(join(appPath, "dist", "renderer"));
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    openMainWindow();
    void account.initialize();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
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
    });
    mainWindow.on("closed", () => {
      disposeIpc?.();
      disposeIpc = null;
      mainWindow = null;
    });
  }
}
