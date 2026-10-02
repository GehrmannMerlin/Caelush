import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { RunId, SelectablePermissionPresetId } from "@caelush/protocol";
import type { ProcessExit } from "../exec/contracts.js";
import { terminateProcessTree } from "../exec/process-tree.js";
import { RuntimeSandboxError, RuntimeSandboxProtocolError } from "../runtime-errors.js";
import {
  acceptSandboxWorkspacePrepared,
  acceptSandboxWorkspaceStatus,
  createSandboxHello,
} from "./control-protocol.js";
import {
  DEFAULT_SANDBOX_READY_TIMEOUT_MS,
  createSandboxControlTransport,
} from "./control-transport.js";
import {
  cleanupPrivateRunTemp,
  createPrivateRunTemp,
  type PrivateRunTemp,
  type PrivateRunTempOptions,
} from "./private-temp.js";

export type NativeWorkspaceSandboxStatus = "READY" | "REQUIRED" | "UNAVAILABLE";
export type NativeWorkspaceRunnerOperation = "workspace-status" | "workspace-prepare";

export type NativeWorkspaceRunnerResult =
  { readonly status: "READY" | "MISSING" } | { readonly status: "ADDED" | "UNCHANGED" };

export interface NativeWorkspaceRunnerInvoker {
  (input: {
    readonly operation: NativeWorkspaceRunnerOperation;
    readonly workspaceRoot: string;
  }): Promise<NativeWorkspaceRunnerResult>;
}

export interface NativeWorkspaceSandboxController {
  getStatus(
    workspaceRoot: string,
    presetId: SelectablePermissionPresetId,
  ): Promise<NativeWorkspaceSandboxStatus>;
  prepare(
    workspaceRoot: string,
    presetId: SelectablePermissionPresetId,
  ): Promise<NativeWorkspaceSandboxStatus>;
  createRunTemp(runId: RunId): Promise<PrivateRunTemp>;
  cleanupRunTemp(temp: PrivateRunTemp): Promise<void>;
}

export interface NativeWorkspaceSandboxControllerOptions {
  readonly runnerPath?: string;
  readonly providerId?: string;
  readonly readyTimeoutMs?: number;
  readonly privateTempBaseDirectory?: string;
  readonly runnerInvoker?: NativeWorkspaceRunnerInvoker;
}

export function createNativeWorkspaceSandboxController(
  options: NativeWorkspaceSandboxControllerOptions = {},
): NativeWorkspaceSandboxController {
  const privateTempOptions: PrivateRunTempOptions =
    options.privateTempBaseDirectory === undefined
      ? {}
      : { baseDirectory: options.privateTempBaseDirectory };
  const runnerInvoker =
    options.runnerInvoker ??
    createNativeWorkspaceRunnerInvoker({
      providerId: options.providerId ?? "windows-acl-restricted-token",
      ...(options.runnerPath === undefined ? {} : { runnerPath: options.runnerPath }),
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    });

  return Object.freeze({
    getStatus: async (
      workspaceRoot: string,
      presetId: SelectablePermissionPresetId,
    ): Promise<NativeWorkspaceSandboxStatus> => {
      if (presetId === "VIEW_ONLY") return "READY";
      if (presetId === "FULL_ACCESS") return "UNAVAILABLE";
      try {
        const result = await runnerInvoker({
          operation: "workspace-status",
          workspaceRoot,
        });
        return result.status === "READY"
          ? "READY"
          : result.status === "MISSING"
            ? "REQUIRED"
            : "UNAVAILABLE";
      } catch {
        return "UNAVAILABLE";
      }
    },
    prepare: async (
      workspaceRoot: string,
      presetId: SelectablePermissionPresetId,
    ): Promise<NativeWorkspaceSandboxStatus> => {
      if (presetId === "VIEW_ONLY") return "READY";
      if (presetId === "FULL_ACCESS") return "UNAVAILABLE";
      try {
        const result = await runnerInvoker({
          operation: "workspace-prepare",
          workspaceRoot,
        });
        return result.status === "ADDED" || result.status === "UNCHANGED" ? "READY" : "UNAVAILABLE";
      } catch {
        return "UNAVAILABLE";
      }
    },
    createRunTemp: (runId: RunId): Promise<PrivateRunTemp> =>
      createPrivateRunTemp(runId, privateTempOptions),
    cleanupRunTemp: (temp: PrivateRunTemp): Promise<void> => cleanupPrivateRunTemp(temp),
  });
}

function createNativeWorkspaceRunnerInvoker(input: {
  readonly runnerPath?: string;
  readonly providerId: string;
  readonly readyTimeoutMs?: number;
}): NativeWorkspaceRunnerInvoker {
  return async ({ operation, workspaceRoot }): Promise<NativeWorkspaceRunnerResult> => {
    if (input.runnerPath === undefined) {
      throw new RuntimeSandboxError("The native sandbox runner is unavailable.");
    }
    const nonce = randomUUID();
    const boundaryFingerprint = createHash("sha256")
      .update(JSON.stringify({ operation, workspaceRoot }), "utf8")
      .digest("hex");
    const hello = createSandboxHello({
      nonce,
      providerId: input.providerId,
      boundaryFingerprint,
    });
    const transport = await createSandboxControlTransport({
      hello,
      ...(input.readyTimeoutMs === undefined ? {} : { timeoutMs: input.readyTimeoutMs }),
    });
    let child: ChildProcess | undefined;
    try {
      child = spawn(
        input.runnerPath,
        [
          "--operation",
          operation,
          ...transport.runnerArgs,
          "--provider",
          input.providerId,
          "--nonce",
          nonce,
          "--boundary-fingerprint",
          boundaryFingerprint,
          "--workspace-root",
          workspaceRoot,
        ],
        {
          windowsHide: true,
          stdio:
            process.platform === "win32"
              ? ["ignore", "pipe", "pipe"]
              : ["ignore", "pipe", "pipe", "pipe"],
        },
      );
      const message =
        operation === "workspace-status"
          ? await transport.waitForWorkspaceStatus(child, hello)
          : await transport.waitForWorkspacePrepared(child, hello);
      const exit = await waitForChildExit(
        child,
        input.readyTimeoutMs ?? DEFAULT_SANDBOX_READY_TIMEOUT_MS,
      );
      if (exit.exitCode !== 0 || exit.signal !== undefined) {
        throw new RuntimeSandboxError("The native sandbox workspace operation failed.");
      }
      if (operation === "workspace-status") {
        const accepted = acceptSandboxWorkspaceStatus(message, hello);
        return { status: accepted.status };
      }
      const accepted = acceptSandboxWorkspacePrepared(message, hello);
      if (accepted.change !== "ADDED" && accepted.change !== "UNCHANGED") {
        throw new RuntimeSandboxProtocolError(
          "The native sandbox workspace preparation result is invalid.",
        );
      }
      return { status: accepted.change };
    } catch (error) {
      if (child !== undefined && child.exitCode === null && !child.killed) {
        await terminateProcessTree({
          pid: child.pid,
          kill: () => child!.kill(),
        }).catch(() => undefined);
      }
      if (error instanceof RuntimeSandboxError || error instanceof RuntimeSandboxProtocolError) {
        throw error;
      }
      throw new RuntimeSandboxError(
        "The native sandbox workspace operation could not be completed.",
      );
    } finally {
      await transport.close().catch(() => undefined);
    }
  };
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<ProcessExit> {
  if (child.exitCode !== null) {
    return Promise.resolve({
      exitCode: child.exitCode,
      ...(child.signalCode === null ? {} : { signal: child.signalCode }),
    });
  }
  return new Promise<ProcessExit>((resolve, reject) => {
    let settled = false;
    const finish = (result: { readonly exit?: ProcessExit; readonly error?: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      if (result.exit !== undefined) resolve(result.exit);
      else reject(result.error);
    };
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      finish({
        exit: {
          ...(exitCode === null ? {} : { exitCode }),
          ...(signal === null ? {} : { signal }),
        },
      });
    };
    const onError = (): void =>
      finish({ error: new RuntimeSandboxError("The native sandbox workspace Runner failed.") });
    const timer = setTimeout(
      () =>
        finish({
          error: new RuntimeSandboxError(
            `The native sandbox workspace Runner did not exit within ${timeoutMs.toLocaleString("en-US")} ms.`,
          ),
        }),
      timeoutMs,
    );
    child.once("close", onClose);
    child.once("error", onError);
  });
}
