import { describe, expect, it } from "vitest";
import {
  allowedExternalUrl,
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

  it("enables Login IPC only for an explicitly isolated development origin", () => {
    expect(createRendererTrust(false, "http://127.0.0.1:5173/")).toMatchObject({
      developmentOrigin: "http://127.0.0.1:5173",
      allowLoginIpc: false,
    });
    expect(createRendererTrust(false, "http://127.0.0.1:5174/", true)).toMatchObject({
      developmentOrigin: "http://127.0.0.1:5174",
      allowLoginIpc: true,
    });
    expect(createRendererTrust(false, "http://127.0.0.1:5174/")).toMatchObject({
      allowLoginIpc: false,
    });
    expect(createRendererTrust(true, "http://127.0.0.1:5174/", true)).toMatchObject({
      developmentOrigin: null,
      allowLoginIpc: false,
    });
  });

  it("opens external navigation only for allowlisted HTTPS hosts", () => {
    const allowed = new Set(["github.com", "www.caelush.com"]);
    expect(allowedExternalUrl("https://github.com/GehrmannMerlin/Caelush", allowed)).toBe(
      "https://github.com/GehrmannMerlin/Caelush",
    );
    for (const url of [
      "http://github.com/",
      "https://github.com.attacker.example/",
      "https://user@github.com/",
      "https://github.com:8443/",
      "javascript:alert(1)",
    ]) {
      expect(allowedExternalUrl(url, allowed)).toBeNull();
    }
  });

  it.each([
    ["http://localhost:5173", "http://localhost:5173/"],
    ["http://127.0.0.1:3000/login?next=%2F#form", "http://127.0.0.1:3000/login?next=%2F#form"],
    ["http://[::1]:8080/", "http://[::1]:8080/"],
  ])("opens a valid loopback preview in the system browser: %s", (input, expected) => {
    expect(allowedExternalUrl(input, new Set())).toBe(expected);
  });

  it.each([
    "http://localhost:5173%EF%BC%89%EF%BC%8C%E8%AF%B4%E6%98%8E",
    "http://localhost:70000/",
    "http://localhost:0/",
    "http://localhost.attacker.example:5173/",
    "http://127.0.0.1.attacker.example:5173/",
    "http://user:password@localhost:5173/",
    "http://localhost@attacker.example:5173/",
    "http://192.168.1.1:5173/",
    "http://0.0.0.0:5173/",
    "file:///C:/Windows/",
  ])("rejects malformed or non-loopback local-preview destinations: %s", (url) => {
    expect(allowedExternalUrl(url, new Set())).toBeNull();
  });
});
