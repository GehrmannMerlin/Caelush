import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const stageRoot = path.join(appRoot, ".stage");
const stageDirectory = path.join(appRoot, ".stage", "daemon");
const nodeDestination = path.join(stageDirectory, "node.exe");
const expectedNodeHash = "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de";
const excludedAccessSids = ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"];

runPnpm(["--filter", "@caelush/protocol", "build"]);
runPnpm(["--filter", "@caelush/client", "build"]);
runPnpm(["--filter", "@caelush/daemon...", "build"]);
runPnpm(["--filter", "@caelush/web", "build:desktop"]);

if (process.platform !== "win32") {
  throw new Error("D4-1 Daemon runtime staging requires Windows x64 Node 24.18.0.");
}

const nodeSource = process.env.CAELUSH_NODE_24_PATH || process.execPath;
const sourceBytes = await readFile(nodeSource);
const actualHash = createHash("sha256").update(sourceBytes).digest("hex");
if (actualHash !== expectedNodeHash) {
  throw new Error(
    "Node runtime staging requires the D0-C verified Node 24.18.0 Windows x64 executable. Set CAELUSH_NODE_24_PATH to that node.exe.",
  );
}

const version = spawnSync(nodeSource, ["--version"], { encoding: "utf8", windowsHide: true });
if (version.status !== 0 || version.stdout.trim() !== "v24.18.0") {
  throw new Error("The staged Node executable did not report the D0-C verified version.");
}

const currentUserSid = readCurrentUserSid();
await mkdir(stageRoot, { recursive: true });
secureRuntimePath(stageRoot, currentUserSid, true);
await mkdir(stageDirectory, { recursive: true });
secureRuntimePath(stageDirectory, currentUserSid, true);
await rm(nodeDestination, { force: true });
await copyFile(nodeSource, nodeDestination);
secureRuntimePath(nodeDestination, currentUserSid, false);
process.stdout.write(
  `Staged D0-C Node 24.18.0 with current-user ACL and Medium integrity at ${path.relative(repoRoot, nodeDestination)} (${actualHash}).\n`,
);

function readCurrentUserSid() {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
  const result = spawnSync(executable, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const sid = result.stdout?.match(/S-1-(?:[0-9]+-)+[0-9]+/u)?.[0];
  if (result.status !== 0 || sid === undefined) {
    throw new Error("The current Windows user identity could not be verified for Daemon staging.");
  }
  return sid;
}

function secureRuntimePath(target, userSid, directory) {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  const inheritance = directory ? "(OI)(CI)" : "";
  const args = [
    target,
    "/inheritance:r",
    "/remove:g",
    ...excludedAccessSids.map((sid) => `*${sid}`),
    "/grant:r",
    `*${userSid}:${inheritance}F`,
    "/setintegritylevel",
    `${inheritance}M`,
    "/C",
  ];
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      "The staged Daemon runtime could not be restricted to the current Windows user.",
    );
  }
}

function runPnpm(args) {
  const pnpmCli = process.env.npm_execpath;
  const command = pnpmCli ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const commandArgs = pnpmCli ? [pnpmCli, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
    ...(pnpmCli || process.platform !== "win32" ? {} : { shell: true }),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed.`);
}
