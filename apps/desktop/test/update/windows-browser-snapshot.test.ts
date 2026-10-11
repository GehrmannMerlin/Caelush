import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { WindowsProfilePermissions } from "../../src/main/profiles/profile-manager.js";
import { digestBrowserProfile } from "../../src/main/update/profile-verification.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^caelush-d72-browser-/);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-d72-browser-"));
  roots.push(root);
  const profile = path.join(root, "profile");
  const browser = path.join(profile, "browser");
  await mkdir(profile);
  await new WindowsProfilePermissions().secureDirectory(profile);
  await mkdir(path.join(browser, "Cache"), { recursive: true });
  await writeFile(path.join(browser, "Cache", "entry"), "browser-cache");
  await run(
    path.join(process.env.SystemRoot!, "System32", "icacls.exe"),
    [
      path.join(browser, "Cache"),
      "/grant",
      "*S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417:(OI)(CI)M",
    ],
    { windowsHide: true },
  );
  return { root, browser };
}
async function capture(browser: string) {
  const source = await readFile(
    new URL("../../src/main/update/nsis-handoff.ts", import.meta.url),
    "utf8",
  );
  const script = source.split("const HANDOFF_SCRIPT = String.raw`")[1]!.split("`;")[0]!;
  const pathChecks = script.slice(script.indexOf("$sid="), script.indexOf("$configPath="));
  const fingerprint = script.slice(
    script.indexOf("function FingerprintBrowserTree"),
    script.indexOf("function WriteReceipt"),
  );
  const command =
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'\n" +
    pathChecks +
    fingerprint +
    "\n[Console]::Out.WriteLine((CaptureBrowserSnapshot $env:CAELUSH_TEST_BROWSER_ROOT | ConvertTo-Json -Compress))";
  const result = await run(
    path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, CAELUSH_TEST_BROWSER_ROOT: browser },
    },
  );
  return JSON.parse(result.stdout);
}

it.skipIf(process.platform !== "win32")(
  "fingerprints Chromium AppContainer cache ACLs under the private Profile boundary",
  async () => {
    const f = await fixture();
    expect(await capture(f.browser)).toEqual(await digestBrowserProfile(f.browser));
  },
);
it.skipIf(process.platform !== "win32")(
  "rejects a Browser junction even under a private Profile",
  async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(f.browser, "linked"), "junction");
    await expect(capture(f.browser)).rejects.toThrow();
  },
);
it.skipIf(process.platform !== "win32")(
  "rejects a Profile boundary accessible to other Windows users",
  async () => {
    const f = await fixture();
    await run(
      path.join(process.env.SystemRoot!, "System32", "icacls.exe"),
      [path.dirname(f.browser), "/grant", "*S-1-5-11:(OI)(CI)R"],
      { windowsHide: true },
    );
    await expect(capture(f.browser)).rejects.toThrow();
  },
);
