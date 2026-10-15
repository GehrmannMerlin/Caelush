import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import { BUILD_CONFIGURATION } from "../build-config.js";
import type { DesktopRendererTrust } from "../ipc/handlers.js";
import {
  allowedExternalUrl,
  createSecureWebPreferences,
  isLocalRendererUrl,
} from "./security-policy.js";

const externalHttpsHosts = new Set(BUILD_CONFIGURATION.externalHttpsHosts);

export interface CreateWindowOptions {
  readonly appPath: string;
  readonly preloadPath: string;
  readonly rendererTrust: DesktopRendererTrust;
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    title: "Caelush 桌面端",
    width: 1120,
    height: 760,
    minWidth: 780,
    minHeight: 640,
    center: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    icon: join(options.appPath, "resources", "caelush-app-icon.png"),
    webPreferences: createSecureWebPreferences(options.preloadPath, BUILD_CONFIGURATION.production),
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isLocalRendererUrl(destination, options.rendererTrust)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, destination) => {
    if (!isLocalRendererUrl(destination, options.rendererTrust)) event.preventDefault();
  });

  if (options.rendererTrust.developmentOrigin !== null) {
    void window.loadURL(options.rendererTrust.developmentOrigin);
  } else {
    void window.loadURL("caelush-login://app/");
  }
  return window;
}

async function openExternalUrl(value: string): Promise<void> {
  try {
    const allowedUrl = allowedExternalUrl(value, externalHttpsHosts);
    if (allowedUrl !== null) await shell.openExternal(allowedUrl);
  } catch {
    // External URL parsing/open failures are intentionally not reflected to the renderer.
  }
}
