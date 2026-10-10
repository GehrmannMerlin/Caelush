import { EventEmitter } from "node:events";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { AccountState } from "../../src/main/account/state.js";
import { DaemonInfoSchema } from "@caelush/protocol";
import {
  DesktopDaemonSupervisor,
  type DesktopChildProcess,
  type DesktopDaemonResources,
} from "../../src/main/daemon/supervisor.js";
import { profileIdForUser } from "../../src/main/profiles/profile-manager.js";
import type { MainCredentialVaultPort } from "../../src/main/credentials/credential-rpc.js";

const CAPABILITIES = {
  runExecution: true,
  runRecovery: true,
  cancellation: true,
  approvals: true,
  sseReplay: true,
  sessionTranscript: true,
  desktopHostAuthV1: true,
  desktopProfileBindingV1: true,
  desktopLocalProxyV1: true,
} as const;
const READY_CAPABILITIES = Object.keys(CAPABILITIES).sort();
const INFO = {
  apiVersion: "v1",
  protocolVersion: 1,
  daemonVersion: "0.1.0",
  capabilities: CAPABILITIES,
  runtimeKinds: ["local"],
  configuredProviders: [],
  defaultRunConfiguration: {
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  },
} as const;
const RESOURCES: DesktopDaemonResources = {
  nodeExecutablePath: "C:\\stage\\node.exe",
  daemonEntryPath: "C:\\stage\\desktop-entry.js",
  userTerminalHelperPath: "C:\\stage\\user-terminal-helper.mjs",
};

class FakeChild extends EventEmitter implements DesktopChildProcess {
  readonly pid = 42_000;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = null;
  stderr = null;
  readonly sent: unknown[] = [];
  startBehavior: "ready" | "bad-pid" | "silent" = "ready";
  stopBehavior: "closed" | "blocked" = "closed";

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(structuredClone(message));
    callback?.(null);
    if (isRecord(message) && message.type === "START_DESKTOP_DAEMON") {
      if (this.startBehavior === "silent") return true;
      const start = message;
      setImmediate(() => {
        this.emit("message", {
          type: "DAEMON_READY",
          ipcProtocolVersion: 1,
          generationId: start.generationId,
          profileId: start.profileId,
          childPid: this.startBehavior === "bad-pid" ? this.pid + 1 : this.pid,
          parentPid: 700,
          host: "127.0.0.1",
          port: 43_219,
          daemonVersion: "0.1.0",
          apiVersion: "v1",
          protocolVersion: 1,
          capabilities: READY_CAPABILITIES,
          bootstrapAccepted: true,
        });
      });
    } else if (isRecord(message) && message.type === "STOP_DESKTOP_DAEMON") {
      setImmediate(() => {
        if (this.stopBehavior === "blocked") {
          this.emit("message", {
            type: "DAEMON_STOP_BLOCKED",
            ipcProtocolVersion: 1,
            generationId: message.generationId,
            code: "SAFE_CHECKPOINT_PENDING",
          });
          return;
        }
        this.emit("message", {
          type: "DAEMON_CLOSED",
          ipcProtocolVersion: 1,
          generationId: message.generationId,
        });
        this.finish(0, null);
      });
    }
    return true;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.finish(null, typeof signal === "number" ? "SIGTERM" : signal);
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function createAuthorizedState(userId = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857"): AccountState {
  return {
    status: "AUTHORIZED_OFFLINE",
    account: {
      userId,
      email: "test@example.invalid",
      emailVerified: true,
      entitlements: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    offlineGrant: {
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-10-20T00:00:00.000Z",
      entitlements: [],
      remainingHours: 360,
    },
    lastError: null,
    notice: null,
    agentEntry: { available: false, reason: "DAEMON_STARTING" },
  };
}

function createSupervisor(
  options: {
    readonly child?: FakeChild;
    readonly startupTimeoutMs?: number;
    readonly proxyDrainTimeoutMs?: number;
    readonly profileSelections?: string[];
    readonly credentialVault?: MainCredentialVaultPort;
    readonly onSpawn?: (environment: NodeJS.ProcessEnv) => void;
  } = {},
) {
  const child = options.child ?? new FakeChild();
  const profileSelections = options.profileSelections ?? [];
  const credentialVault: MainCredentialVaultPort = options.credentialVault ?? {
    describe: async (_userId, _profileId, providerId) => ({
      providerId,
      configured: false,
      source: "NONE",
      writable: true,
    }),
    resolve: async () => undefined,
    set: async (_userId, _profileId, providerId) => ({
      providerId,
      configured: true,
      source: "LOCAL",
      writable: true,
    }),
    unset: async () => undefined,
  };
  const supervisor = new DesktopDaemonSupervisor({
    profileManager: {
      async selectForUser(userId) {
        profileSelections.push(userId);
        const profileId = profileIdForUser(userId);
        const rootDirectory = path.join(tmpdir(), profileId);
        return {
          profileId,
          rootDirectory,
          databasePath: path.join(rootDirectory, "caelush.db"),
          runsDirectory: path.join(rootDirectory, "runs"),
          logsDirectory: path.join(rootDirectory, "logs"),
          backupsDirectory: path.join(rootDirectory, "backups"),
          browserDirectory: path.join(rootDirectory, "browser"),
          downloadsDirectory: path.join(rootDirectory, "downloads"),
          metadataPath: path.join(rootDirectory, "profile.json"),
        };
      },
    },
    credentialVault,
    credentialMigrator: {
      run: async () => ({ state: "NO_CREDENTIALS", credentialCount: 0 }),
    },
    resolveResources: async () => RESOURCES,
    productVersion: "0.1.0",
    processEnvironment: {
      PATH: "C:\\Windows\\System32",
      CAELUSH_HOME: "C:\\untrusted\\home",
      CAELUSH_HOST_TOKEN: "parent-secret",
      CAELUSH_CLOUD_ACCESS_TOKEN: "cloud-secret",
      CAELUSH_PROVIDER_API_KEY: "provider-secret",
    },
    parentPid: 700,
    startupTimeoutMs: options.startupTimeoutMs ?? 1000,
    shutdownTimeoutMs: 1000,
    proxyDrainTimeoutMs: options.proxyDrainTimeoutMs ?? 100,
    spawnDaemon: (_resources, _profileRoot, environment) => {
      options.onSpawn?.(environment);
      return child;
    },
    fetcher: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-caelush-host-token")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(headers.get("origin")).toBe(new URL(url).origin);
      return url.endsWith("/health")
        ? Response.json({
            service: "caelush-daemon",
            status: "ready",
            apiVersion: "v1",
            protocolVersion: 1,
          })
        : Response.json(INFO);
    },
  });
  return { supervisor, child, profileSelections };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("DesktopDaemonSupervisor", () => {
  it("uses a strict DaemonInfo fixture for the compatibility handshake", () => {
    const parsed = DaemonInfoSchema.safeParse(INFO);
    expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);
  });

  it("binds one authorized Profile to its own Child generation and private token", async () => {
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const setup = createSupervisor({ onSpawn: (environment) => (childEnvironment = environment) });
    const state = createAuthorizedState();
    await setup.supervisor.synchronizeAccountState(state);

    expect(setup.supervisor.getAgentEntry(state)).toEqual({ available: true });
    expect(setup.profileSelections).toEqual([state.account?.userId]);
    expect(childEnvironment).toMatchObject({
      CAELUSH_HOME: path.join(tmpdir(), profileIdForUser(state.account?.userId ?? "")),
    });
    expect(childEnvironment).not.toHaveProperty("CAELUSH_PROVIDER_API_KEY");
    expect(childEnvironment).not.toHaveProperty("CAELUSH_HOST_TOKEN");
    expect(childEnvironment).not.toHaveProperty("CAELUSH_CLOUD_ACCESS_TOKEN");
    const start = setup.child.sent[0];
    expect(start).toMatchObject({
      type: "START_DESKTOP_DAEMON",
      apiVersion: "v1",
      protocolVersion: 1,
      profileId: profileIdForUser(state.account?.userId ?? ""),
    });
    expect(isRecord(start) ? String(start.bootstrapSecret) : "").toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(isRecord(start) ? String(start.hostToken) : "").toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const lease = setup.supervisor.acquireProxyLease(new AbortController().signal);
    expect(lease?.baseUrl).toBe("http://127.0.0.1:43219");
    expect(lease?.hostToken).toBe(isRecord(start) ? start.hostToken : undefined);
    lease?.release();
    await setup.supervisor.beginAccountBoundary();
    expect(setup.supervisor.acquireProxyLease(new AbortController().signal)).toBeNull();
  });

  it("routes credential RPC through Main with the generation's User and Profile binding", async () => {
    const state = createAuthorizedState();
    const resolveCalls: Array<readonly [string, string, string]> = [];
    const credentialVault: MainCredentialVaultPort = {
      describe: async (_userId, _profileId, providerId) => ({
        providerId,
        configured: true,
        source: "LOCAL",
        writable: true,
      }),
      resolve: async (userId, profileId, providerId) => {
        resolveCalls.push([userId, profileId, providerId]);
        return "fixture-provider-secret";
      },
      set: async (_userId, _profileId, providerId) => ({
        providerId,
        configured: true,
        source: "LOCAL",
        writable: true,
      }),
      unset: async () => undefined,
    };
    const setup = createSupervisor({ credentialVault });
    await setup.supervisor.synchronizeAccountState(state);
    const start = setup.child.sent[0];
    if (!isRecord(start)) throw new Error("missing startup message");
    const boundProfileId = profileIdForUser(state.account?.userId ?? "");

    setup.child.emit("message", {
      type: "CREDENTIAL_RESOLVE",
      requestId: "b224fcb7-f36a-457b-a71e-e72416b24a59",
      generationId: start.generationId,
      profileId: boundProfileId,
      childPid: setup.child.pid,
      providerId: "deepseek",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(setup.child.sent).toContainEqual({
      type: "CREDENTIAL_RESPONSE",
      requestId: "b224fcb7-f36a-457b-a71e-e72416b24a59",
      generationId: start.generationId,
      profileId: boundProfileId,
      result: { kind: "RESOLVE", secretValue: "fixture-provider-secret" },
    });
    expect(resolveCalls).toEqual([[state.account?.userId, boundProfileId, "deepseek"]]);
    await setup.supervisor.beginAccountBoundary();
  });

  it("rejects a READY message that does not match the OS Child PID", async () => {
    const child = new FakeChild();
    child.startBehavior = "bad-pid";
    const setup = createSupervisor({ child });
    await expect(
      setup.supervisor.synchronizeAccountState(createAuthorizedState()),
    ).rejects.toMatchObject({
      code: "DAEMON_READY_INVALID",
      failureKind: "PROTOCOL_INCOMPATIBLE",
    });
    expect(setup.supervisor.acquireProxyLease(new AbortController().signal)).toBeNull();
    expect(child.exitCode).toBe(0);
  });

  it("times out bounded startup and invalidates the failed generation", async () => {
    const child = new FakeChild();
    child.startBehavior = "silent";
    const setup = createSupervisor({ child, startupTimeoutMs: 20 });
    await expect(
      setup.supervisor.synchronizeAccountState(createAuthorizedState()),
    ).rejects.toMatchObject({
      code: "DAEMON_START_TIMEOUT",
    });
    expect(setup.supervisor.acquireProxyLease(new AbortController().signal)).toBeNull();
    expect(child.sent.some((item) => isRecord(item) && item.type === "STOP_DESKTOP_DAEMON")).toBe(
      true,
    );
    expect(child.exitCode).toBe(0);
  });

  it("aborts proxy leases before waiting for the graceful private shutdown", async () => {
    const setup = createSupervisor({ proxyDrainTimeoutMs: 500 });
    const state = createAuthorizedState();
    await setup.supervisor.synchronizeAccountState(state);
    const lease = setup.supervisor.acquireProxyLease(new AbortController().signal);
    expect(lease).not.toBeNull();
    const stopping = setup.supervisor.beginAccountBoundary();
    expect(lease?.signal.aborted).toBe(true);
    lease?.release();
    await stopping;
    expect(
      setup.child.sent.some((item) => isRecord(item) && item.type === "STOP_DESKTOP_DAEMON"),
    ).toBe(true);
    expect(setup.child.exitCode).toBe(0);
  });

  it("keeps Profile switching blocked when graceful shutdown is not confirmed", async () => {
    const profileSelections: string[] = [];
    const child = new FakeChild();
    child.stopBehavior = "blocked";
    const setup = createSupervisor({ child, profileSelections });
    await setup.supervisor.synchronizeAccountState(createAuthorizedState());
    await expect(setup.supervisor.beginAccountBoundary()).rejects.toMatchObject({
      failureKind: "SAFE_SHUTDOWN_PENDING",
    });
    await expect(
      setup.supervisor.synchronizeAccountState(
        createAuthorizedState("3657e5a0-275c-4ae6-950f-511646d3f647"),
      ),
    ).rejects.toMatchObject({ failureKind: "SAFE_SHUTDOWN_PENDING" });
    expect(profileSelections).toHaveLength(1);
    expect(setup.supervisor.acquireProxyLease(new AbortController().signal)).toBeNull();
  });
});
