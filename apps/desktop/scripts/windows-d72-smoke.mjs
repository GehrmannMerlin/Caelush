import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const input = path.resolve(process.argv[2] ?? process.env.CAELUSH_D72_SMOKE_INPUT ?? "");
const identity = JSON.parse(await readFile(input, "utf8"));
assert.equal(path.parse(input).root.toLowerCase(), "d:\\");
const child = spawn(process.execPath, [path.join(import.meta.dirname, "windows-d6-smoke.mjs")], {
  windowsHide: true,
  stdio: "inherit",
  env: {
    ...process.env,
    CAELUSH_D72_SMOKE_INPUT: input,
    CAELUSH_DESKTOP_OUTPUT_ROOT: identity.versionA,
    CAELUSH_D6_INSTALLER_PATH: path.join(identity.versionA, "Caelush-0.1.0-dev-win-x64-Setup.exe"),
  },
});
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
assert.equal(code, 0, "D7-2 real upgrade smoke failed.");
