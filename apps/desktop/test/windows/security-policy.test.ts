import { describe, expect, it } from "vitest";
import {
  allowedExternalHttpsUrl,
  createRendererTrust,
  createSecureWebPreferences,
  isLocalRendererUrl,
} from "../../src/main/windows/security-policy.js";

describe("Electron window security policy", () => {
  it("keeps Node disabled and Chromium isolation, sandboxing, and web security enabled", () => {
    const preferences = createSecureWebPreferences("C:/app/preload.cjs", true);
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      preload: "C:/app/preload.cjs",
    });
  });

  it("allows only the login and Agent app origins or the exact loopback development origin", () => {
    const packaged = createRendererTrust(true, "http://127.0.0.1:5173/");
    expect(isLocalRendererUrl("caelush-login://app/", packaged)).toBe(true);
    expect(isLocalRendererUrl("caelush-app://app/agent/", packaged)).toBe(true);
    expect(isLocalRendererUrl("caelush-app://app:9443/", packaged)).toBe(false);
    expect(isLocalRendererUrl("caelush-app://app@attacker.example/", packaged)).toBe(false);
    expect(isLocalRendererUrl("https://attacker.example/", packaged)).toBe(false);

    const development = createRendererTrust(false, "http://127.0.0.1:5173/");
    expect(isLocalRendererUrl("http://127.0.0.1:5173/login", development)).toBe(true);
    expect(isLocalRendererUrl("http://localhost:5173/", development)).toBe(false);
    expect(isLocalRendererUrl("http://127.0.0.1:5174/", development)).toBe(false);
    expect(createRendererTrust(false, "http://0.0.0.0:5173/").developmentOrigin).toBeNull();
  });

  it("opens external navigation only for allowlisted HTTPS hosts", () => {
    const allowed = new Set(["github.com", "www.caelush.com"]);
    expect(allowedExternalHttpsUrl("https://github.com/GehrmannMerlin/Caelush", allowed)).toBe(
      "https://github.com/GehrmannMerlin/Caelush",
    );
    for (const url of [
      "http://github.com/",
      "https://github.com.attacker.example/",
      "https://user@github.com/",
      "https://github.com:8443/",
      "javascript:alert(1)",
    ]) {
      expect(allowedExternalHttpsUrl(url, allowed)).toBeNull();
    }
  });
});
