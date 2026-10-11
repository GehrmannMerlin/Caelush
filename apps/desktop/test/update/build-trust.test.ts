import { describe, it, expect } from "vitest";
import { resolveDesktopBuildConfiguration } from "../../scripts/desktop-build-config.mjs";
const env = {
  CAELUSH_DESKTOP_BUILD_PURPOSE: "production",
  CAELUSH_CLOUD_ORIGIN: "https://cloud.example.com",
  CAELUSH_CLOUD_ALLOWED_HOSTS: "cloud.example.com",
  CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: JSON.stringify({ offline: "A".repeat(43) }),
};
describe("build-pinned update trust", () => {
  it("refuses a production updater without its independent trust roots", () => {
    expect(() => resolveDesktopBuildConfiguration(env)).toThrow("PRODUCTION_UPDATE_TRUST_REQUIRED");
  });
  it("rejects test roots, private TLS trust and reused offline keys", () => {
    const update = {
      CAELUSH_UPDATE_TRUSTED_KEYS_JSON: JSON.stringify({ release: "B".repeat(42) + "A" }),
      CAELUSH_UPDATE_RELEASE_HOSTS: "releases.example.com",
    };
    expect(() =>
      resolveDesktopBuildConfiguration({
        ...env,
        ...update,
        CAELUSH_UPDATE_TEST_CA_PEM: "certificate",
      }),
    ).toThrow();
    expect(() =>
      resolveDesktopBuildConfiguration({
        ...env,
        ...update,
        CAELUSH_UPDATE_RELEASE_HOSTS: "localhost",
      }),
    ).toThrow();
    expect(() =>
      resolveDesktopBuildConfiguration({
        ...env,
        ...update,
        CAELUSH_UPDATE_TRUSTED_KEYS_JSON: JSON.stringify({ release: "A".repeat(43) }),
      }),
    ).toThrow();
    expect(() =>
      resolveDesktopBuildConfiguration({
        ...env,
        ...update,
        CAELUSH_UPDATE_TRUSTED_KEYS_JSON: JSON.stringify({
          d72_test_fixture: "B".repeat(42) + "A",
        }),
      }),
    ).toThrow();
  });
});
