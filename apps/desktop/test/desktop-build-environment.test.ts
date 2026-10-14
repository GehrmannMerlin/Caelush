import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadDesktopBuildEnvironment,
  resolveDesktopBuildConfiguration,
} from "../scripts/desktop-build-config.mjs";

describe("Desktop development Cloud configuration", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(path.join(tmpdir(), "caelush-build-environment-"));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it("keeps the saved hosted Cloud origin when rebuilding without shell overrides", async () => {
    await writeFile(
      path.join(appRoot, ".env.development.local"),
      "CAELUSH_CLOUD_ORIGIN=https://cloud.caelush.example\n",
    );

    const environment = await loadDesktopBuildEnvironment(appRoot, {});

    expect(resolveDesktopBuildConfiguration(environment).cloudOrigin).toBe(
      "https://cloud.caelush.example",
    );
  });

  it("lets an explicit shell origin override the saved development origin", async () => {
    await writeFile(
      path.join(appRoot, ".env.development.local"),
      "CAELUSH_CLOUD_ORIGIN=https://cloud.caelush.example\n",
    );

    const environment = await loadDesktopBuildEnvironment(appRoot, {
      CAELUSH_CLOUD_ORIGIN: "http://127.0.0.1:9000",
    });

    expect(resolveDesktopBuildConfiguration(environment).cloudOrigin).toBe("http://127.0.0.1:9000");
  });

  it("preserves the loopback default when no development configuration exists", async () => {
    const environment = await loadDesktopBuildEnvironment(appRoot, {});

    expect(resolveDesktopBuildConfiguration(environment).cloudOrigin).toBe("http://127.0.0.1:8000");
  });

  it.each([
    { CAELUSH_DESKTOP_BUILD_PURPOSE: "production" },
    { CAELUSH_DESKTOP_BUILD_PURPOSE: "internal-test" },
    { NODE_ENV: "production" },
    { CAELUSH_DESKTOP_CHANNEL: "stable" },
  ])("does not apply saved development configuration to %j", async (environment) => {
    await writeFile(
      path.join(appRoot, ".env.development.local"),
      "CAELUSH_CLOUD_ORIGIN=https://cloud.caelush.example\n",
    );

    expect(await loadDesktopBuildEnvironment(appRoot, environment)).toEqual(environment);
  });

  it("reports an unreadable saved configuration instead of silently selecting loopback", async () => {
    await mkdir(path.join(appRoot, ".env.development.local"));

    await expect(loadDesktopBuildEnvironment(appRoot, {})).rejects.toThrow();
  });
});
