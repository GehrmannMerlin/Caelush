import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  createSandboxControlTransport,
  createSandboxHello,
  encodeSandboxControlMessage,
  type SandboxedSpawnSpec,
} from "../src/index.js";
import { createNativeRunnerProcessAdapter } from "../src/sandbox/native-runner-adapter.js";
import {
  buildSandboxRunner,
  // @ts-expect-error The release helper is a checked-in JavaScript build script without a declaration file.
} from "../../../scripts/build-sandbox-runner.mjs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

const hello = () =>
  createSandboxHello({
    nonce: "native-runner-control-nonce",
    providerId: "windows-acl-restricted-token",
    boundaryFingerprint: "native-runner-control-boundary",
  });

describeWindows("native Windows Runner control handshake", () => {
  let temporaryDirectory = "";
  let runnerPath = "";

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "caelush-native-runner-control-"));
    const cargo =
      process.env.CARGO ??
      join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
    const built = await buildSandboxRunner({
      repositoryRoot: process.cwd(),
      outputDirectory: temporaryDirectory,
      cargo,
    });
    runnerPath = built.binaryPath;
  }, 120_000);

  afterAll(async () => {
    if (temporaryDirectory !== "") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("receives the exact nonce/provider/boundary tuple from the real transport probe", async () => {
    const expected = hello();
    const transport = await createSandboxControlTransport({ platform: "win32", hello: expected });
    const child = spawn(
      runnerPath,
      [
        "--operation",
        "transport-probe",
        ...transport.runnerArgs,
        "--provider",
        expected.providerId,
        "--nonce",
        expected.nonce,
        "--boundary-fingerprint",
        expected.boundaryFingerprint,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );

    await expect(transport.waitForReady(child, expected)).resolves.toEqual({
      type: "READY",
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      nonce: expected.nonce,
      providerId: expected.providerId,
      boundaryFingerprint: expected.boundaryFingerprint,
      enforcement: "NONE",
    });
    await expect(exitCode(child)).resolves.toBe(0);
  });

  it("rejects a real control message with the wrong nonce", async () => {
    const expected = hello();
    const line = `${encodeSandboxControlMessage({
      type: "READY",
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      nonce: "wrong-native-runner-nonce",
      providerId: expected.providerId,
      boundaryFingerprint: expected.boundaryFingerprint,
      enforcement: "NONE",
    })}\n`;
    const { child, transport } = await spawnFakeRunner(expected, connectAndWriteScript, [line]);

    await expect(transport.waitForReady(child, expected)).rejects.toThrow(/nonce/i);
  });

  it("rejects a Runner process that exits before opening the pipe", async () => {
    const expected = hello();
    const transport = await createSandboxControlTransport({ platform: "win32", hello: expected });
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    await expect(transport.waitForReady(child, expected)).rejects.toThrow(/exited before READY/i);
  });

  it("times out and terminates a Runner that never opens the pipe", async () => {
    const expected = hello();
    const transport = await createSandboxControlTransport({
      platform: "win32",
      hello: expected,
      timeoutMs: 100,
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    await expect(transport.waitForReady(child, expected)).rejects.toThrow(/100 ms/i);
    await expect(exitCode(child)).resolves.not.toBe(0);
  });

  it("does not accept a valid-looking READY emitted on Runner stdout", async () => {
    const expected = hello();
    const forged = encodeSandboxControlMessage({
      type: "READY",
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      nonce: expected.nonce,
      providerId: expected.providerId,
      boundaryFingerprint: expected.boundaryFingerprint,
      enforcement: "NONE",
    });
    const transport = await createSandboxControlTransport({
      platform: "win32",
      hello: expected,
      timeoutMs: 100,
    });
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1]); setInterval(() => undefined, 1_000)", forged],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );

    await expect(transport.waitForReady(child, expected)).rejects.toThrow(/100 ms/i);
  });

  it("passes the private pipe to run and receives the real fail-closed Runner ERROR", async () => {
    await expect(
      createNativeRunnerProcessAdapter({
        runnerPath,
        providerId: "windows-acl-restricted-token",
        spec: sandboxedSpec(),
      }),
    ).rejects.toThrow(/expected READY/i);
  });

  it("does not start the payload when the requested mode is not implemented", async () => {
    const sentinel = join(temporaryDirectory, "workspace-write-payload-started.txt");
    const input = sandboxedSpec();
    await expect(
      createNativeRunnerProcessAdapter({
        runnerPath,
        providerId: "windows-acl-restricted-token",
        spec: {
          ...input,
          launch: {
            executable: process.env.ComSpec ?? "cmd.exe",
            args: ["/d", "/s", "/c", `type nul > "${sentinel}"`],
          },
        },
      }),
    ).rejects.toThrow(/expected READY/i);
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts a real read-only restricted child only after the Runner proves READY", async () => {
    const adapter = await createNativeRunnerProcessAdapter({
      runnerPath,
      providerId: "windows-acl-restricted-token",
      spec: readOnlySpec(),
    });
    const output: string[] = [];
    adapter.onOutput((event) => output.push(event.text));
    const exit = await new Promise<{ readonly exitCode?: number; readonly signal?: string }>(
      (resolve, reject) => {
        adapter.onError(reject);
        adapter.onExit(resolve);
      },
    );
    expect(output.join("")).toContain("restricted-child-ready");
    expect(exit).toMatchObject({ exitCode: 37 });
  });
});

const connectAndWriteScript = String.raw`
const net = require("node:net");
const pipeName = process.argv[1];
const line = process.argv[2];
const socket = net.createConnection(pipeName, () => socket.end(line));
socket.on("error", () => process.exit(2));
`;

async function spawnFakeRunner(
  expected: ReturnType<typeof hello>,
  script: string,
  extraArgs: readonly string[],
): Promise<{
  child: ChildProcess;
  transport: Awaited<ReturnType<typeof createSandboxControlTransport>>;
}> {
  const transport = await createSandboxControlTransport({ platform: "win32", hello: expected });
  const pipeName = transport.runnerArgs[1];
  if (pipeName === undefined)
    throw new Error("Windows control pipe argument missing in test setup.");
  const child = spawn(process.execPath, ["-e", script, pipeName, ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, transport };
}

function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

function sandboxedSpec(): SandboxedSpawnSpec {
  return {
    launch: { executable: process.execPath, args: ["-e", "process.exit(99)"] },
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    tty: false,
    authorizationNonce: "native-runner-adapter-nonce",
    policy: {
      runId: "run_native_runner_control" as never,
      filesystem: {
        workspaceId: "workspace_native_runner_control" as never,
        workspaceRoot: process.cwd(),
        hostUserRoot: process.cwd(),
        boundary: "WORKSPACE_READ_WRITE",
        protectedRoots: [process.cwd()],
      },
      processBoundary: "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
    },
  };
}

function readOnlySpec(): SandboxedSpawnSpec {
  const base = sandboxedSpec();
  return {
    ...base,
    launch: {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "echo restricted-child-ready & ping -n 2 127.0.0.1 >nul & exit /b 37",
      ],
    },
    policy: {
      ...base.policy,
      filesystem: { ...base.policy.filesystem, boundary: "WORKSPACE_READ_ONLY" },
      processBoundary: "READ_ONLY",
    },
  };
}
