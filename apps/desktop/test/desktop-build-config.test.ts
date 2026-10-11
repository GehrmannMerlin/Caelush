import { describe, expect, it } from "vitest";
import { resolveDesktopBuildConfiguration } from "../scripts/desktop-build-config.mjs";

const VALID_KEYRING = JSON.stringify({ release_key_1: "A".repeat(43) });
const INTERNAL_KEYRING = JSON.stringify({ d6_test_fixture_1: "A".repeat(43) });

describe("Desktop build purpose and release channel", () => {
  it("keeps the ordinary development build on the explicit loopback default", () => {
    expect(resolveDesktopBuildConfiguration({})).toMatchObject({
      purpose: "development",
      production: false,
      channel: "dev",
      cloudOrigin: "http://127.0.0.1:8000",
      offlinePublicKeys: {},
    });
  });

  it("requires the production trust configuration when NODE_ENV is production", () => {
    expect(() =>
      resolveDesktopBuildConfiguration({ NODE_ENV: "production", CAELUSH_DESKTOP_CHANNEL: "dev" }),
    ).toThrow("PRODUCTION_CLOUD_ORIGIN_REQUIRED");
    expect(
      resolveDesktopBuildConfiguration({
        NODE_ENV: "production",
        CAELUSH_DESKTOP_CHANNEL: "beta",
        CAELUSH_CLOUD_ORIGIN: "https://cloud.caelush.example",
        CAELUSH_CLOUD_ALLOWED_HOSTS: "cloud.caelush.example",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: VALID_KEYRING,
        CAELUSH_UPDATE_TRUSTED_KEYS_JSON: JSON.stringify({ update_release: "B".repeat(42) + "A" }),
        CAELUSH_UPDATE_RELEASE_HOSTS: "releases.caelush.example",
      }),
    ).toMatchObject({ purpose: "production", production: true, channel: "beta" });
  });

  it("makes Stable production-only even when NODE_ENV is absent", () => {
    expect(() => resolveDesktopBuildConfiguration({ CAELUSH_DESKTOP_CHANNEL: "stable" })).toThrow(
      "PRODUCTION_CLOUD_ORIGIN_REQUIRED",
    );
    expect(
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_CHANNEL: "stable",
        CAELUSH_CLOUD_ORIGIN: "https://cloud.caelush.example",
        CAELUSH_CLOUD_ALLOWED_HOSTS: "cloud.caelush.example",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: VALID_KEYRING,
        CAELUSH_UPDATE_TRUSTED_KEYS_JSON: JSON.stringify({ update_release: "B".repeat(42) + "A" }),
        CAELUSH_UPDATE_RELEASE_HOSTS: "releases.caelush.example",
      }),
    ).toMatchObject({ purpose: "production", production: true, channel: "stable" });
    expect(() =>
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_CHANNEL: "stable",
        CAELUSH_DESKTOP_BUILD_PURPOSE: "internal-test",
        CAELUSH_CLOUD_ORIGIN: "http://127.0.0.1:8000",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: INTERNAL_KEYRING,
      }),
    ).toThrow("STABLE_INTERNAL_TEST_BUILD_FORBIDDEN");
  });

  it("does not allow an explicit development purpose to downgrade production", () => {
    expect(() =>
      resolveDesktopBuildConfiguration({
        NODE_ENV: "production",
        CAELUSH_DESKTOP_BUILD_PURPOSE: "development",
        CAELUSH_CLOUD_ORIGIN: "http://127.0.0.1:8000",
      }),
    ).toThrow("BUILD_PURPOSE_DOWNGRADE_FORBIDDEN");
  });

  it("allows an explicit internal test build only with a loopback origin and test-only key ID", () => {
    expect(
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "internal-test",
        CAELUSH_CLOUD_ORIGIN: "http://127.0.0.1:8000",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: INTERNAL_KEYRING,
      }),
    ).toMatchObject({ purpose: "internal-test", production: true, channel: "dev" });

    expect(() =>
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "internal-test",
        CAELUSH_CLOUD_ORIGIN: "http://cloud.caelush.example",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: INTERNAL_KEYRING,
      }),
    ).toThrow("INTERNAL_TEST_LOOPBACK_REQUIRED");
    expect(() =>
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "internal-test",
        CAELUSH_CLOUD_ORIGIN: "http://127.0.0.1:8000",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: VALID_KEYRING,
      }),
    ).toThrow("INTERNAL_TEST_KEY_ID_REQUIRED");
  });

  it("rejects incomplete and insecure production configuration", () => {
    expect(() =>
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "production",
        CAELUSH_CLOUD_ORIGIN: "http://127.0.0.1:8000",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: VALID_KEYRING,
      }),
    ).toThrow("PRODUCTION_HTTPS_REQUIRED");
    expect(() =>
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "production",
        CAELUSH_CLOUD_ORIGIN: "https://cloud.caelush.example",
        CAELUSH_CLOUD_ALLOWED_HOSTS: "cloud.caelush.example",
      }),
    ).toThrow("PRODUCTION_TRUSTED_KEY_REQUIRED");
    expect(() =>
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "production",
        CAELUSH_CLOUD_ORIGIN: "https://cloud.caelush.example",
        CAELUSH_CLOUD_ALLOWED_HOSTS: "other.caelush.example",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: VALID_KEYRING,
      }),
    ).toThrow("PRODUCTION_HOST_ALLOWLIST_REQUIRED");
    expect(() =>
      resolveDesktopBuildConfiguration({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "production",
        CAELUSH_CLOUD_ORIGIN: "https://cloud.caelush.example",
        CAELUSH_CLOUD_ALLOWED_HOSTS: "cloud.caelush.example",
        CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: INTERNAL_KEYRING,
      }),
    ).toThrow("PRODUCTION_INTERNAL_TEST_KEY_FORBIDDEN");
  });
});
