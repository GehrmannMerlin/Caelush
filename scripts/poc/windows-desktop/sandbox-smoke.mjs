import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const productRoot = process.argv[2];
const disposableRoot = process.argv[3];
if (typeof productRoot !== "string" || typeof disposableRoot !== "string") {
  process.exitCode = 2;
} else {
  try {
    const runtimeEntry = pathToFileURL(
      join(productRoot, "node_modules", "@caelush", "runtime", "dist", "index.js"),
    ).href;
    const runtime = await import(runtimeEntry);
    const runnerPath = join(productRoot, "sandbox-runner", "caelush-sandbox-runner.exe");
    const manifestPath = join(productRoot, "sandbox-runner", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const runnerHash = createHash("sha256")
      .update(await readFile(runnerPath))
      .digest("hex");
    const verified = await runtime.loadAndVerifySandboxRunnerArtifact({
      runnerPath,
      manifestPath,
      platform: "win32",
      arch: "x64",
    });
    const workspace = join(disposableRoot, "runner-protocol-workspace");
    const sibling = join(disposableRoot, "runner-sibling");
    const privateTempBaseDirectory = join(disposableRoot, "runner-private-temp");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(sibling, { recursive: true }),
      mkdir(privateTempBaseDirectory, { recursive: true }),
      mkdir(process.env.USERPROFILE ?? join(disposableRoot, "userprofile"), { recursive: true }),
    ]);
    const controller = runtime.createNativeWorkspaceSandboxController({
      runnerPath,
      readyTimeoutMs: 5000,
      privateTempBaseDirectory,
    });
    const initialWorkspaceStatus = await controller.getStatus(workspace, "WORKSPACE_WRITE");
    const preparationResult = await controller.prepare(workspace, "WORKSPACE_WRITE");
    const workspaceStatus = await controller.getStatus(workspace, "WORKSPACE_WRITE");
    const provider = runtime.createWindowsAclRestrictedTokenProvider({
      runnerPath,
      manifestPath,
      manifest: verified.manifest,
      readyTimeoutMs: 5000,
      privateTempBaseDirectory,
    });
    const restrictedProbe = await provider.probe();
    const writtenFile = join(workspace, "runner-restricted-write.txt");
    const escapedFile = join(sibling, "runner-restricted-escape.txt");
    const commandFile = join(workspace, "runner-restricted-execution.cmd");
    await writeFile(
      commandFile,
      [
        "@echo off",
        '> "runner-restricted-write.txt" echo RESTRICTED_OK',
        '> "..\\runner-sibling\\runner-restricted-escape.txt" echo ESCAPE',
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const adapter = await provider.create({
      launch: {
        executable:
          process.env.ComSpec ??
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
        args: ["/d", "/s", "/c", basename(commandFile)],
      },
      cwd: workspace,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
      ),
      tty: false,
      authorizationNonce: `d0c-runner-${process.pid}`,
      policy: runtime.createRuntimeProcessPolicy({
        runId: `d0c-runner-${process.pid}`,
        workspaceId: randomUUID(),
        workspaceRoot: workspace,
        hostUserRoot: process.env.USERPROFILE ?? join(disposableRoot, "userprofile"),
        filesystemBoundary: "WORKSPACE_READ_WRITE",
        processBoundary: "WORKSPACE_WRITE",
        requiredEnforcement: "OS_RESTRICTED",
        protectedRoots: [workspace],
      }),
    });
    const execution = await waitForAdapter(adapter, 10000);
    const workspaceWriteObserved = await exists(writtenFile);
    const escapedWriteDenied = !(await exists(escapedFile));
    if (execution.exitCode !== 0 || !workspaceWriteObserved || !escapedWriteDenied) {
      throw new Error("RESTRICTED_EXECUTION_ASSERTION_FAILED");
    }
    const pe = await readPeMachine(runnerPath);
    const report = {
      BINARY_FOUND: true,
      HASH_VERIFIED: runnerHash === manifest.sha256,
      PROTOCOL_COMPATIBLE:
        manifest.controlProtocolVersion === runtime.SANDBOX_CONTROL_PROTOCOL_VERSION &&
        workspaceStatus === "READY",
      STARTUP_VALIDATED:
        (initialWorkspaceStatus === "REQUIRED" || initialWorkspaceStatus === "READY") &&
        preparationResult === "READY" &&
        workspaceStatus === "READY",
      RESTRICTED_EXECUTION_VALIDATED:
        restrictedProbe.available &&
        restrictedProbe.enforcement !== "NONE" &&
        execution.exitCode === 0 &&
        workspaceWriteObserved &&
        escapedWriteDenied,
      enforcement: restrictedProbe.enforcement,
      ...(restrictedProbe.reasonCode === undefined
        ? {}
        : { reasonCode: restrictedProbe.reasonCode }),
      workspaceStatus,
      initialWorkspaceStatus,
      preparationResult,
      workspaceWriteObserved,
      escapedWriteDenied,
      restrictedChildExitCode: execution.exitCode,
      controlProtocolVersion: manifest.controlProtocolVersion,
      manifestArch: manifest.arch,
      peMachine: pe.machineName,
      sha256: runnerHash,
      runnerPathRelative: "product/sandbox-runner/caelush-sandbox-runner.exe",
      manifestPathRelative: "product/sandbox-runner/manifest.json",
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.HASH_VERIFIED || pe.machine !== 0x8664) process.exitCode = 1;
  } catch {
    process.stderr.write("SANDBOX_SMOKE_FAILED\n");
    process.exitCode = 1;
  }
}

async function waitForAdapter(adapter, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void adapter.close();
      reject(new Error("RESTRICTED_CHILD_TIMEOUT"));
    }, timeoutMs);
    adapter.onError((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    adapter.onExit((exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPeMachine(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("PE_DOS_SIGNATURE_INVALID");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("PE_SIGNATURE_INVALID");
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  return { machine, machineName: machine === 0x8664 ? "x64" : `0x${machine.toString(16)}` };
}
