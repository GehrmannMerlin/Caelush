import type { BrowserWindowConstructorOptions } from "electron";

export interface DesktopRendererTrust {
  readonly developmentOrigin: string | null;
  readonly allowLoginIpc: boolean;
}

export function createRendererTrust(
  appIsPackaged: boolean,
  configuredDevUrl: string | undefined,
  isolatedDevelopment = false,
): DesktopRendererTrust {
  if (appIsPackaged || configuredDevUrl === undefined) {
    return { developmentOrigin: null, allowLoginIpc: false };
  }
  try {
    const url = new URL(configuredDevUrl);
    const expectedPort = isolatedDevelopment ? "5174" : "5173";
    if (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === expectedPort &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    ) {
      return { developmentOrigin: url.origin, allowLoginIpc: isolatedDevelopment };
    }
  } catch {
    // Invalid development configuration fails closed to the packaged app protocol.
  }
  return { developmentOrigin: null, allowLoginIpc: false };
}

export function isLocalRendererUrl(destination: string, trust: DesktopRendererTrust): boolean {
  try {
    const url = new URL(destination);
    if (
      (url.protocol === "caelush-app:" || url.protocol === "caelush-login:") &&
      url.hostname === "app" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    ) {
      return true;
    }
    return trust.developmentOrigin !== null && url.origin === trust.developmentOrigin;
  } catch {
    return false;
  }
}

export function allowedExternalUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
): string | null {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return null;
    if (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()) &&
      url.port !== "0"
    )
      return url.toString();
    return url.protocol === "https:" &&
      url.port === "" &&
      allowedHosts.has(url.hostname.toLowerCase())
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function createSecureWebPreferences(
  preloadPath: string,
  production: boolean,
): NonNullable<BrowserWindowConstructorOptions["webPreferences"]> {
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    devTools: !production,
  };
}
