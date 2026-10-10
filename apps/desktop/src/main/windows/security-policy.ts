import type { BrowserWindowConstructorOptions } from "electron";

export interface DesktopRendererTrust {
  readonly developmentOrigin: string | null;
}

export function createRendererTrust(
  appIsPackaged: boolean,
  configuredDevUrl: string | undefined,
): DesktopRendererTrust {
  if (appIsPackaged || configuredDevUrl === undefined) return { developmentOrigin: null };
  try {
    const url = new URL(configuredDevUrl);
    if (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "5173" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    ) {
      return { developmentOrigin: url.origin };
    }
  } catch {
    // Invalid development configuration fails closed to the packaged app protocol.
  }
  return { developmentOrigin: null };
}

export function isLocalRendererUrl(destination: string, trust: DesktopRendererTrust): boolean {
  try {
    const url = new URL(destination);
    if (
      url.protocol === "caelush-app:" &&
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

export function allowedExternalHttpsUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !allowedHosts.has(url.hostname.toLowerCase())
    ) {
      return null;
    }
    return url.toString();
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
