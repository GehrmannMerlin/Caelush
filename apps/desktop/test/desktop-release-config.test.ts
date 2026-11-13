import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDesktopReleaseConfiguration } from "../scripts/desktop-release-config.mjs";

const OFFLINE_KEY = randomBytes(32).toString("base64url");
const UPDATE_KEY = randomBytes(32).toString("base64url");
const RELEASE_CONFIG = {
  cloudOrigin: "https://api.caelush.com.cn",
  cloudAllowedHosts: ["api.caelush.com.cn"],
  offlineTrustedKeys: { caelush_offline_2026: OFFLINE_KEY },
  updateTrustedKeys: { caelush_update_2026: UPDATE_KEY },
  updateReleaseHosts: ["releases.caelush.com.cn"],
  outputRoot: "D:\\Caelush-Releases",
};

describe("Desktop production release configuration", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function writeConfig(value: unknown) {
    const directory = await mkdtemp(path.join(tmpdir(), "caelush-release-config-"));
    directories.push(directory);
    const configPath = path.join(directory, "production.json");
    await writeFile(configPath, `${JSON.stringify(value)}\n`, "utf8");
    return configPath;
  }

  it("maps the Cloud-matched public trust config to an explicit stable production environment", async () => {
    const configPath = await writeConfig(RELEASE_CONFIG);

    const result = await loadDesktopReleaseConfiguration(configPath, {});

    expect(result.environment).toMatchObject({
      NODE_ENV: "production",
      CAELUSH_DESKTOP_BUILD_PURPOSE: "production",
      CAELUSH_DESKTOP_CHANNEL: "stable",
      CAELUSH_CLOUD_ORIGIN: "https://api.caelush.com.cn",
      CAELUSH_CLOUD_ALLOWED_HOSTS: "api.caelush.com.cn",
      CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: JSON.stringify(RELEASE_CONFIG.offlineTrustedKeys),
      CAELUSH_UPDATE_TRUSTED_KEYS_JSON: JSON.stringify(RELEASE_CONFIG.updateTrustedKeys),
      CAELUSH_UPDATE_RELEASE_HOSTS: "releases.caelush.com.cn",
      CAELUSH_DESKTOP_INCLUDE_SOURCEMAPS: "false",
    });
    expect(result.outputRoot).toBe(path.win32.resolve("D:\\Caelush-Releases"));
    expect(result.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.configurationFingerprint).not.toContain(OFFLINE_KEY);
    expect(result.configurationFingerprint).not.toContain(UPDATE_KEY);
  });

  it("rejects a missing production update trust keyring", async () => {
    const configPath = await writeConfig({ ...RELEASE_CONFIG, updateTrustedKeys: {} });

    await expect(loadDesktopReleaseConfiguration(configPath, {})).rejects.toThrow(
      "PRODUCTION_UPDATE_TRUST_REQUIRED",
    );
  });

  it("rejects malformed public keys and non-production hosts", async () => {
    const malformedKeyConfig = await writeConfig({
      ...RELEASE_CONFIG,
      offlineTrustedKeys: { caelush_offline_2026: "not-a-valid-ed25519-key" },
    });
    await expect(loadDesktopReleaseConfiguration(malformedKeyConfig, {})).rejects.toThrow(
      "invalid key entry",
    );

    const wrongCloudOriginConfig = await writeConfig({
      ...RELEASE_CONFIG,
      cloudOrigin: "https://example.com",
    });
    await expect(loadDesktopReleaseConfiguration(wrongCloudOriginConfig, {})).rejects.toThrow(
      "RELEASE_CLOUD_ORIGIN_INVALID",
    );

    const wrongCloudHostConfig = await writeConfig({
      ...RELEASE_CONFIG,
      cloudAllowedHosts: ["example.com"],
    });
    await expect(loadDesktopReleaseConfiguration(wrongCloudHostConfig, {})).rejects.toThrow(
      "RELEASE_CLOUD_HOSTS_INVALID",
    );

    const wrongReleaseHostConfig = await writeConfig({
      ...RELEASE_CONFIG,
      updateReleaseHosts: ["example.com"],
    });
    await expect(loadDesktopReleaseConfiguration(wrongReleaseHostConfig, {})).rejects.toThrow(
      "RELEASE_UPDATE_HOSTS_INVALID",
    );
  });

  it("rejects reusing an Offline Grant key as the Desktop Update key", async () => {
    const configPath = await writeConfig({
      ...RELEASE_CONFIG,
      updateTrustedKeys: { caelush_update_2026: OFFLINE_KEY },
    });

    await expect(loadDesktopReleaseConfiguration(configPath, {})).rejects.toThrow(
      "UPDATE_OFFLINE_KEY_REUSE_FORBIDDEN",
    );
  });

  it("rejects inherited build settings that conflict with the release config", async () => {
    const configPath = await writeConfig(RELEASE_CONFIG);

    await expect(
      loadDesktopReleaseConfiguration(configPath, {
        CAELUSH_DESKTOP_CHANNEL: "dev",
      }),
    ).rejects.toThrow("RELEASE_ENV_CONFLICT:CAELUSH_DESKTOP_CHANNEL");

    await expect(
      loadDesktopReleaseConfiguration(configPath, {
        CAELUSH_DESKTOP_OUTPUT_ROOT: "D:\\Untrusted-Release-Output",
      }),
    ).rejects.toThrow("RELEASE_ENV_CONFLICT:CAELUSH_DESKTOP_OUTPUT_ROOT");

    await expect(
      loadDesktopReleaseConfiguration(configPath, {
        CAELUSH_UPDATE_TRUSTED_KEYS_JSON: JSON.stringify({ unrelated_update_key: UPDATE_KEY }),
      }),
    ).rejects.toThrow("RELEASE_ENV_CONFLICT:CAELUSH_UPDATE_TRUSTED_KEYS_JSON");
  });

  it("rejects inherited source maps and output paths inside the checkout", async () => {
    const configPath = await writeConfig(RELEASE_CONFIG);

    await expect(
      loadDesktopReleaseConfiguration(configPath, {
        CAELUSH_DESKTOP_INCLUDE_SOURCEMAPS: "true",
      }),
    ).rejects.toThrow("RELEASE_SOURCEMAPS_FORBIDDEN");

    const unsafeConfigPath = await writeConfig({
      ...RELEASE_CONFIG,
      outputRoot: process.cwd(),
    });
    await expect(loadDesktopReleaseConfiguration(unsafeConfigPath, {})).rejects.toThrow(
      "RELEASE_OUTPUT_ROOT_INVALID",
    );

    if (process.platform === "win32") {
      const checkoutConfigPath = await writeConfig({
        ...RELEASE_CONFIG,
        outputRoot: path.join(process.cwd(), "release-artifacts"),
      });
      await expect(loadDesktopReleaseConfiguration(checkoutConfigPath, {})).rejects.toThrow(
        "RELEASE_OUTPUT_ROOT_INVALID",
      );
    }
  });

  it("rejects unknown fields so private key material cannot enter the build config", async () => {
    const configPath = await writeConfig({
      ...RELEASE_CONFIG,
      updatePrivateKey: "must-not-be-here",
    });

    await expect(loadDesktopReleaseConfiguration(configPath, {})).rejects.toThrow(
      "RELEASE_CONFIG_SCHEMA_INVALID",
    );
  });
});
