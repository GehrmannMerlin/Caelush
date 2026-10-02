import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ManagedProcessAdapter, ProcessExit } from "../exec/contracts.js";
import type { SandboxProbeResult, SandboxEnforcement } from "./contracts.js";
import { createNativeRunnerProcessAdapter } from "./native-runner-adapter.js";

export const DEFAULT_NATIVE_RUNNER_FUNCTIONAL_PROBE_TIMEOUT_MS = 5_000;

export interface NativeSandboxRunnerManifest {
  readonly schemaVersion: 1;
  readonly product: "caelush";
  readonly controlProtocolVersion: 1;
  readonly platform: "windows" | "linux" | "macos";
  readonly arch: string;
  readonly executableName: string;
  readonly sha256: string;
  readonly providers: readonly string[];
}

export interface NativeRunnerArtifactOptions {
  readonly hostPlatform?: NodeJS.Platform;
  readonly arch?: string;
  readonly runnerPath?: string;
  readonly manifest?: NativeSandboxRunnerManifest;
}

export interface NativeRunnerProbeOptions extends NativeRunnerArtifactOptions {
  readonly providerId: string;
  readonly targetPlatform: "windows" | "linux" | "macos";
  readonly enforcement: SandboxEnforcement;
  readonly timeoutMs?: number;
}

export async function probeNativeSandboxRunner(
  input: NativeRunnerProbeOptions,
): Promise<SandboxProbeResult> {
  const artifact = await verifyNativeSandboxRunnerArtifact(input);
  if (!artifact.available || input.runnerPath === undefined) return artifact;
  if (input.targetPlatform !== "windows") return artifact;

  try {
    await proveWindowsReadOnlyConfinement({
      runnerPath: input.runnerPath,
      providerId: input.providerId,
      timeoutMs: input.timeoutMs ?? DEFAULT_NATIVE_RUNNER_FUNCTIONAL_PROBE_TIMEOUT_MS,
    });
    return artifact;
  } catch {
    return {
      available: false,
      enforcement: "NONE",
      reasonCode: "RUNNER_FUNCTIONAL_PROBE_FAILED",
    };
  }
}

export async function verifyNativeSandboxRunnerArtifact(
  input: NativeRunnerProbeOptions,
): Promise<SandboxProbeResult> {
  if (platformName(input.hostPlatform ?? process.platform) !== input.targetPlatform) {
    return { available: false, enforcement: "NONE", reasonCode: "UNSUPPORTED_PLATFORM" };
  }
  if (input.runnerPath === undefined || input.manifest === undefined) {
    return { available: false, enforcement: "NONE", reasonCode: "RUNNER_ARTIFACT_MISSING" };
  }
  if (
    input.manifest.product !== "caelush" ||
    input.manifest.schemaVersion !== 1 ||
    input.manifest.controlProtocolVersion !== 1 ||
    input.manifest.platform !== input.targetPlatform ||
    input.manifest.arch !== (input.arch ?? process.arch) ||
    input.manifest.executableName !== basename(input.runnerPath) ||
    !input.manifest.providers.includes(input.providerId) ||
    !/^[0-9a-f]{64}$/.test(input.manifest.sha256)
  ) {
    return { available: false, enforcement: "NONE", reasonCode: "RUNNER_MANIFEST_INVALID" };
  }
  try {
    await access(input.runnerPath, constants.X_OK);
    const digest = createHash("sha256")
      .update(await readFile(input.runnerPath))
      .digest("hex");
    if (digest !== input.manifest.sha256) {
      return { available: false, enforcement: "NONE", reasonCode: "RUNNER_HASH_MISMATCH" };
    }
  } catch {
    return { available: false, enforcement: "NONE", reasonCode: "RUNNER_ARTIFACT_MISSING" };
  }
  return { available: true, enforcement: input.enforcement };
}

async function proveWindowsReadOnlyConfinement(input: {
  readonly runnerPath: string;
  readonly providerId: string;
  readonly timeoutMs: number;
}): Promise<void> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Invalid functional probe timeout.");
  }
  const root = await mkdtemp(join(tmpdir(), "caelush-runner-functional-probe-"));
  const readable = join(root, "readable.txt");
  const deleteTarget = join(root, "delete-target.txt");
  const renameSource = join(root, "rename-source.txt");
  const created = join(root, "created.txt");
  const renamed = join(root, "renamed.txt");
  const script = join(root, "probe.cmd");
  const originalReadable = "caelush-read-only-probe\r\n";
  const deadline = Date.now() + input.timeoutMs;
  let adapter: ManagedProcessAdapter | undefined;

  try {
    await Promise.all([
      writeFile(readable, originalReadable, "utf8"),
      writeFile(deleteTarget, "must-remain\r\n", "utf8"),
      writeFile(renameSource, "must-not-move\r\n", "utf8"),
      writeFile(
        script,
        [
          "@echo off",
          'type "readable.txt" >nul 2>nul || exit /b 20',
          '2>nul >"created.txt" echo unexpected',
          '2>nul >>"readable.txt" echo unexpected',
          'del /q "delete-target.txt" >nul 2>nul',
          'ren "rename-source.txt" "renamed.txt" >nul 2>nul',
          "exit /b 0",
          "",
        ].join("\r\n"),
        "utf8",
      ),
    ]);

    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    adapter = await createNativeRunnerProcessAdapter({
      runnerPath: input.runnerPath,
      providerId: input.providerId,
      readyTimeoutMs: remainingTime(deadline),
      spec: {
        launch: {
          executable: process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"),
          args: ["/d", "/s", "/c", "probe.cmd"],
        },
        cwd: root,
        env: { ...process.env },
        tty: false,
        authorizationNonce: `native-runner-functional-probe-${randomUUID()}`,
        policy: {
          runId: "run_native_runner_functional_probe" as never,
          filesystem: {
            workspaceId: "workspace_native_runner_functional_probe" as never,
            workspaceRoot: root,
            hostUserRoot: root,
            boundary: "WORKSPACE_READ_ONLY",
            protectedRoots: [root],
          },
          processBoundary: "READ_ONLY",
          requiredEnforcement: "OS_RESTRICTED",
        },
      },
    });
    const exit = await waitForExit(adapter, remainingTime(deadline));
    if (exit.exitCode !== 0 || exit.signal !== undefined) {
      throw new Error("Restricted probe child did not complete.");
    }

    const [readableAfter, deleteAfter, renameAfter, createdAfter, renamedAfter] = await Promise.all(
      [
        readFile(readable, "utf8"),
        readFile(deleteTarget, "utf8"),
        readFile(renameSource, "utf8"),
        exists(created),
        exists(renamed),
      ],
    );
    if (
      readableAfter !== originalReadable ||
      deleteAfter !== "must-remain\r\n" ||
      renameAfter !== "must-not-move\r\n" ||
      createdAfter ||
      renamedAfter
    ) {
      throw new Error("Restricted probe observed a forbidden mutation.");
    }
  } finally {
    await adapter?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Native Runner functional probe timed out.");
  return remaining;
}

function waitForExit(adapter: ManagedProcessAdapter, timeoutMs: number): Promise<ProcessExit> {
  return new Promise<ProcessExit>((resolve, reject) => {
    let settled = false;
    let removeExit = (): void => undefined;
    let removeError = (): void => undefined;
    const finish = (result: { readonly exit?: ProcessExit; readonly error?: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeExit();
      removeError();
      if (result.exit !== undefined) resolve(result.exit);
      else reject(result.error);
    };
    const timer = setTimeout(
      () => finish({ error: new Error("Native Runner functional probe timed out.") }),
      timeoutMs,
    );
    removeExit = adapter.onExit((exit) => finish({ exit }));
    removeError = adapter.onError((error) => finish({ error }));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function platformName(platform: NodeJS.Platform): "windows" | "linux" | "macos" | "other" {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  return "other";
}
