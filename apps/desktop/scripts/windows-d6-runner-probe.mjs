import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("D6 Runner probe requires Windows x64.");
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runnerPath = path.resolve(
  process.argv[2] ??
    path.join(repositoryRoot, "release-artifacts", "sandbox", "caelush-sandbox-runner.exe"),
);
const probeRoot = path.resolve("D:\\Caelush-D6-Probes");
assert.equal(path.parse(runnerPath).root.toLowerCase(), "d:\\");
assert.equal(path.parse(probeRoot).root.toLowerCase(), "d:\\");
assert.equal(isPathInside(probeRoot, repositoryRoot), false);
await mkdir(probeRoot, { recursive: true });
assert.equal((await lstat(probeRoot)).isSymbolicLink(), false);

const transportNonce = `d6-${randomUUID()}`;
const transport = await runControlOperation(runnerPath, transportNonce, [
  "--operation",
  "transport-probe",
]);
writeProbeOutput(transport);
assert.equal(transport.code, 0, "The Runner did not complete its transport probe.");
assert.deepEqual(parseControlMessage(transport.control), {
  type: "READY",
  protocolVersion: 1,
  nonce: transportNonce,
  providerId: "windows-acl-restricted-token",
  boundaryFingerprint: "d6-control-transport-probe",
  enforcement: "NONE",
});
process.stdout.write("RUNNER_NAMED_PIPE_READY=PASS\n");

const executionRoot = path.join(probeRoot, `.d6-runner-execution-${randomUUID()}`);
assert.equal(isPathInside(executionRoot, repositoryRoot), false);
await mkdir(executionRoot, { recursive: false });
try {
  const workspaceRoot = path.join(executionRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: false });

  const errorNonce = `d6-${randomUUID()}`;
  const missingProgram = path.join(executionRoot, "missing-target.exe");
  const protocolError = await runControlOperation(runnerPath, errorNonce, [
    "--operation",
    "run",
    "--mode",
    "read-only",
    "--workspace-root",
    workspaceRoot,
    "--cwd",
    workspaceRoot,
    "--program",
    missingProgram,
    "--",
  ]);
  writeProbeOutput(protocolError);
  assert.equal(protocolError.code, 1, "The missing-program fixture did not fail closed.");
  const errorMessage = parseControlMessage(protocolError.control);
  assert.equal(errorMessage.type, "ERROR");
  assert.equal(errorMessage.protocolVersion, 1);
  assert.equal(errorMessage.nonce, errorNonce);
  assert.match(errorMessage.code, /^WINDOWS_[A-Z0-9_]{1,64}$/u);
  assert.equal(JSON.stringify(errorMessage).includes(executionRoot), false);
  process.stdout.write(`RUNNER_PROTOCOL_ERROR=PASS CODE=${errorMessage.code}\n`);

  const executionNonce = `d6-${randomUUID()}`;
  const executionMarker = "D6_RUNNER_RESTRICTED_EXECUTION_PASS";
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const execution = await runControlOperation(runnerPath, executionNonce, [
    "--operation",
    "run",
    "--mode",
    "read-only",
    "--workspace-root",
    workspaceRoot,
    "--cwd",
    workspaceRoot,
    "--program",
    powershell,
    "--",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Write-Output ${executionMarker}; exit 0`,
  ]);
  writeProbeOutput(execution);
  assert.equal(execution.code, 0, "The restricted Runner fixture did not exit successfully.");
  assert.deepEqual(parseControlMessage(execution.control), {
    type: "READY",
    protocolVersion: 1,
    nonce: executionNonce,
    providerId: "windows-acl-restricted-token",
    boundaryFingerprint: "d6-control-transport-probe",
    enforcement: "PARTIAL",
  });
  assert.ok(
    execution.output.includes(executionMarker),
    "The restricted child output was not observed.",
  );
  process.stdout.write("RUNNER_RESTRICTED_EXECUTION=PASS ENFORCEMENT=PARTIAL\n");
} finally {
  assertOwnedExecutionRoot();
  await rm(executionRoot, { recursive: true, force: true });
}

function assertOwnedExecutionRoot() {
  if (
    path.dirname(path.resolve(executionRoot)).toLowerCase() !== probeRoot.toLowerCase() ||
    !path.basename(executionRoot).startsWith(".d6-runner-execution-")
  ) {
    throw new Error("Refusing to remove an unowned D6 Runner fixture directory.");
  }
}

async function runControlOperation(executablePath, nonce, operationArguments) {
  const pipeName = `\\\\.\\pipe\\caelush-sandbox-${randomUUID()}`;
  const providerId = "windows-acl-restricted-token";
  const boundaryFingerprint = "d6-control-transport-probe";
  const server = createServer();
  let socket;
  let control = "";
  let output = "";
  let child;

  server.on("connection", (connection) => {
    socket = connection;
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      control = `${control}${chunk}`.slice(-4096);
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipeName, resolve);
    });
    process.stdout.write(`PIPE_LISTENING=${pipeName}\n`);
    child = spawn(
      executablePath,
      [
        "--control-pipe",
        pipeName,
        "--provider",
        providerId,
        "--nonce",
        nonce,
        "--boundary-fingerprint",
        boundaryFingerprint,
        ...operationArguments,
      ],
      {
        cwd: path.dirname(executablePath),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const childClosed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === null) reject(new Error(`Runner terminated by ${String(signal)}.`));
        else resolve(code);
      });
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output = `${output}${String(chunk)}`.slice(-8192);
      });
    }
    const code = await waitForChild(childClosed, 15_000);
    return { code, control, output };
  } catch (error) {
    if (output.length > 0) process.stderr.write(`RUNNER_STDIO=${JSON.stringify(output)}\n`);
    throw error;
  } finally {
    if (child?.exitCode === null && child?.pid !== undefined) {
      child.kill();
      await once(child, "close").catch(() => undefined);
    }
    socket?.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
}

async function waitForChild(closePromise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      closePromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runner probe timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseControlMessage(value) {
  assert.match(value, /\n/u, "The Runner did not send a framed control message.");
  return JSON.parse(value.slice(0, value.indexOf("\n")));
}

function writeProbeOutput(result) {
  process.stdout.write(`RUNNER_EXIT_CODE=${result.code}\n`);
  if (result.output.length > 0)
    process.stdout.write(`RUNNER_STDIO=${JSON.stringify(result.output)}\n`);
  if (result.control.length > 0) {
    process.stdout.write(`RUNNER_CONTROL=${JSON.stringify(result.control)}\n`);
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
