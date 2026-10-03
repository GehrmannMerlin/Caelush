import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ManagedProcessAdapter,
  ProcessExit,
  ProcessOutputEvent,
} from "../src/exec/contracts.js";
import {
  createNativeWorkspaceSandboxController,
  createWindowsAclRestrictedTokenProvider,
  RuntimeSandboxOperationError,
  type NativeWorkspaceSandboxController,
  type NativeWorkspaceRunnerResult,
} from "../src/index.js";
import type { PrivateRunTemp } from "../src/sandbox/private-temp.js";
import type { SandboxedSpawnSpec } from "../src/sandbox/contracts.js";

const WORKSPACE_ROOT = process.platform === "win32" ? "C:\\workspace" : "/workspace";
const RUN_ID = "run_native_workspace_controller" as never;

describe("native workspace sandbox controller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps read-only, missing, prepared, and unavailable workspace states", async () => {
    const calls: string[] = [];
    const controller = createNativeWorkspaceSandboxController({
      runnerInvoker: async (input) => {
        calls.push(input.operation);
        if (input.operation === "workspace-status") return { status: "MISSING" };
        return { status: "ADDED" };
      },
    });

    await expect(controller.getStatus(WORKSPACE_ROOT, "VIEW_ONLY")).resolves.toBe("READY");
    await expect(controller.getStatus(WORKSPACE_ROOT, "WORKSPACE_WRITE")).resolves.toBe("REQUIRED");
    await expect(controller.prepare(WORKSPACE_ROOT, "WORKSPACE_WRITE")).resolves.toBe("READY");
    await expect(controller.getStatus(WORKSPACE_ROOT, "FULL_ACCESS")).resolves.toBe("UNAVAILABLE");
    expect(calls).toEqual(["workspace-status", "workspace-prepare"]);
  });

  it("does not mutate while reading status and maps runner failures to unavailable", async () => {
    const runnerInvoker = vi.fn(async (): Promise<NativeWorkspaceRunnerResult> => {
      throw new Error("runner unavailable");
    });
    const controller = createNativeWorkspaceSandboxController({ runnerInvoker });

    await expect(controller.getStatus(WORKSPACE_ROOT, "WORKSPACE_WRITE")).resolves.toBe(
      "UNAVAILABLE",
    );
    expect(runnerInvoker).toHaveBeenCalledTimes(1);
    expect(runnerInvoker).toHaveBeenCalledWith({
      operation: "workspace-status",
      workspaceRoot: WORKSPACE_ROOT,
    });
  });

  it("preserves a bounded Runner reason when workspace preparation fails", async () => {
    const controller = createNativeWorkspaceSandboxController({
      runnerInvoker: async () => {
        throw new RuntimeSandboxOperationError("WINDOWS_ACL_APPLY_FAILED");
      },
    });

    const result: unknown = await controller.prepare(WORKSPACE_ROOT, "WORKSPACE_WRITE");
    expect(result).toEqual({
      status: "FAILED",
      reasonCode: "WINDOWS_ACL_APPLY_FAILED",
    });
  });
});

describe("native provider private Run temp lifecycle", () => {
  it("creates no temp for read-only and exactly one temp for workspace-write", async () => {
    const temp = fakeTemp();
    const controller = fakeController(temp);
    const adapterFactory = vi.fn(async () => {
      return new FakeAdapter();
    });
    const provider = createWindowsAclRestrictedTokenProvider({
      platform: "win32",
      adapterFactory,
      workspaceController: controller,
    });

    const readOnly = await provider.create(spec("READ_ONLY", "WORKSPACE_READ_ONLY"));
    expect(controller.createRunTemp).not.toHaveBeenCalled();
    expect(adapterFactory).toHaveBeenLastCalledWith(expect.anything(), undefined);
    await readOnly.close();

    const workspaceWrite = await provider.create(spec("WORKSPACE_WRITE", "WORKSPACE_READ_WRITE"));
    expect(controller.createRunTemp).toHaveBeenCalledTimes(1);
    expect(adapterFactory).toHaveBeenCalledWith(expect.anything(), temp);
    await workspaceWrite.close();
    await workspaceWrite.close();
    expect(controller.cleanupRunTemp).toHaveBeenCalledTimes(1);
  });

  it("cleans the temp after an adapter creation failure", async () => {
    const temp = fakeTemp();
    const controller = fakeController(temp);
    const provider = createWindowsAclRestrictedTokenProvider({
      platform: "win32",
      adapterFactory: async () => {
        throw new Error("adapter failed");
      },
      workspaceController: controller,
    });

    await expect(provider.create(spec("WORKSPACE_WRITE", "WORKSPACE_READ_WRITE"))).rejects.toThrow(
      "adapter failed",
    );
    expect(controller.cleanupRunTemp).toHaveBeenCalledTimes(1);
  });
});

function fakeTemp(): PrivateRunTemp {
  return Object.freeze({
    root: `${WORKSPACE_ROOT}\\.caelush-run-temp`,
    markerPath: `${WORKSPACE_ROOT}\\.caelush-run-temp\\.caelush-private-temp.json`,
    runId: RUN_ID,
    markerId: "native-workspace-marker",
  });
}

function fakeController(temp: PrivateRunTemp): NativeWorkspaceSandboxController & {
  readonly createRunTemp: ReturnType<typeof vi.fn>;
  readonly cleanupRunTemp: ReturnType<typeof vi.fn>;
} {
  return {
    getStatus: vi.fn(async () => "READY" as const),
    prepare: vi.fn(async () => "READY" as const),
    createRunTemp: vi.fn(async () => temp),
    cleanupRunTemp: vi.fn(async () => undefined),
  };
}

function spec(
  processBoundary: "READ_ONLY" | "WORKSPACE_WRITE",
  filesystemBoundary: "WORKSPACE_READ_ONLY" | "WORKSPACE_READ_WRITE",
): SandboxedSpawnSpec {
  return {
    launch: { executable: "payload.exe", args: [] },
    cwd: WORKSPACE_ROOT,
    env: {},
    tty: false,
    authorizationNonce: "native-workspace-controller-nonce",
    policy: {
      runId: RUN_ID,
      filesystem: {
        workspaceId: "workspace_native_workspace_controller" as never,
        workspaceRoot: WORKSPACE_ROOT,
        hostUserRoot: WORKSPACE_ROOT,
        boundary: filesystemBoundary,
        protectedRoots: [WORKSPACE_ROOT],
      },
      processBoundary,
      requiredEnforcement: "OS_RESTRICTED",
    },
  };
}

class FakeAdapter implements ManagedProcessAdapter {
  readonly tty = false;
  private readonly events = new EventEmitter();
  private exit: ProcessExit | undefined;

  onStart(listener: () => void): () => void {
    this.events.on("start", listener);
    queueMicrotask(listener);
    return () => this.events.off("start", listener);
  }

  onOutput(listener: (event: ProcessOutputEvent) => void): () => void {
    this.events.on("output", listener);
    return () => this.events.off("output", listener);
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.events.on("exit", listener);
    if (this.exit !== undefined) queueMicrotask(() => listener(this.exit!));
    return () => this.events.off("exit", listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.events.on("error", listener);
    return () => this.events.off("error", listener);
  }

  async write(): Promise<void> {}

  async close(): Promise<void> {
    if (this.exit !== undefined) return;
    this.exit = { exitCode: 0 };
    this.events.emit("exit", this.exit);
  }
}
