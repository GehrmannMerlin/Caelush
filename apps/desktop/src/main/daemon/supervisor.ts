import { randomBytes, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { appendFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { evaluateDesktopDaemonCompatibility, type DesktopDaemonCapability } from "@caelush/client";
import { DaemonInfoSchema, HealthResponseSchema, type DaemonInfo } from "@caelush/protocol";
import type { AccountState } from "../account/state.js";
import {
  profileIdForUser,
  type AccountProfile,
  type ProfileManager,
} from "../profiles/profile-manager.js";
import type { DesktopDaemonProxyLease } from "../protocol/local-proxy.js";
import {
  MainCredentialRpcServer,
  type MainCredentialVaultPort,
} from "../credentials/credential-rpc.js";

export const DESKTOP_DAEMON_STARTUP_TIMEOUT_MS = 10_000;
export const DESKTOP_DAEMON_SHUTDOWN_TIMEOUT_MS = 30_000;
export const DESKTOP_DAEMON_REQUIRED_CAPABILITIES: readonly DesktopDaemonCapability[] =
  Object.freeze([
    "runExecution",
    "runRecovery",
    "cancellation",
    "approvals",
    "sseReplay",
    "sessionTranscript",
    "desktopHostAuthV1",
    "desktopProfileBindingV1",
    "desktopLocalProxyV1",
  ]);

const HOST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_LOG_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LOG_CHUNK_BYTES = 32 * 1024;

const ReadyMessageSchema = z
  .object({
    type: z.literal("DAEMON_READY"),
    ipcProtocolVersion: z.literal(1),
    generationId: z.string().uuid(),
    profileId: z.string().regex(/^u_[0-9a-f]{64}$/u),
    childPid: z.number().int().positive().safe(),
    parentPid: z.number().int().positive().safe(),
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
    daemonVersion: z.string().min(1).max(256),
    apiVersion: z.literal("v1"),
    protocolVersion: z.literal(1),
    capabilities: z.array(z.string().min(1).max(64)).max(64),
    bootstrapAccepted: z.literal(true),
  })
  .strict()
  .refine((value) => new Set(value.capabilities).size === value.capabilities.length);

const StartupFailedMessageSchema = z
  .object({
    type: z.literal("DAEMON_STARTUP_FAILED"),
    ipcProtocolVersion: z.literal(1),
    generationId: z.string(),
    code: z.string().min(1).max(64),
  })
  .strict();

const StoppedMessageSchema = z
  .object({
    type: z.literal("DAEMON_CLOSED"),
    ipcProtocolVersion: z.literal(1),
    generationId: z.string().uuid(),
  })
  .strict();

const StopBlockedMessageSchema = z
  .object({
    type: z.literal("DAEMON_STOP_BLOCKED"),
    ipcProtocolVersion: z.literal(1),
    generationId: z.string().uuid(),
    code: z.literal("SAFE_CHECKPOINT_PENDING"),
  })
  .strict();

type ReadyMessage = z.infer<typeof ReadyMessageSchema>;

export type DesktopDaemonFailureKind =
  "DAEMON_UNAVAILABLE" | "PROTOCOL_INCOMPATIBLE" | "SAFE_SHUTDOWN_PENDING";

export class DesktopDaemonSupervisorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly failureKind: DesktopDaemonFailureKind = "DAEMON_UNAVAILABLE",
  ) {
    super(message);
    this.name = "DesktopDaemonSupervisorError";
  }
}

export type DesktopDaemonLifecycleState = "STARTING" | "READY" | "STOPPING" | "STOP_BLOCKED";

export interface DesktopDaemonResources {
  readonly nodeExecutablePath: string;
  readonly daemonEntryPath: string;
}

export interface DesktopChildProcess extends EventEmitter {
  readonly pid?: number;
  readonly connected: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  disconnect(): void;
}

export interface DesktopDaemonSupervisorOptions {
  readonly profileManager: Pick<ProfileManager, "selectForUser">;
  /** Electron Main's DPAPI credential authority. No Daemon-side fallback is used in Desktop mode. */
  readonly credentialVault: MainCredentialVaultPort;
  readonly resolveResources: () => Promise<DesktopDaemonResources>;
  readonly productVersion: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly parentPid?: number;
  readonly fetcher?: typeof fetch;
  readonly spawnDaemon?: (
    resources: DesktopDaemonResources,
    profileRootDirectory: string,
    environment: NodeJS.ProcessEnv,
  ) => DesktopChildProcess;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly proxyDrainTimeoutMs?: number;
  readonly now?: () => number;
  readonly onlineExpiry?: () => Date | undefined;
  readonly onAuthorizationExpired?: (state: "ONLINE" | "OFFLINE") => void;
  readonly onStateChange?: () => void;
}

interface DesiredAccount {
  readonly userId: string;
  readonly profileId: string;
  readonly expiresAt?: number;
  readonly state: "ONLINE" | "OFFLINE";
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface ManagedGeneration {
  readonly userId: string;
  readonly profileId: string;
  readonly generationId: string;
  readonly child: DesktopChildProcess;
  readonly childPid: number;
  readonly productVersion: string;
  readonly protocolVersion: 1;
  readonly requiredCapabilities: readonly DesktopDaemonCapability[];
  readonly profile: AccountProfile;
  bootstrapSecret: string;
  hostToken: string;
  readonly abortController: AbortController;
  readonly logSink: ChildLogSink;
  readonly exitPromise: Promise<ChildExit>;
  credentialRpcServer?: MainCredentialRpcServer;
  credentialRpcListener?: (message: unknown) => void;
  boundPort?: number;
  lifecycleState: DesktopDaemonLifecycleState;
  exit?: ChildExit;
  exitObserved: boolean;
}

export class DesktopDaemonSupervisor {
  private readonly fetcher: typeof fetch;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly proxyDrainTimeoutMs: number;
  private readonly now: () => number;
  private readonly parentPid: number;
  private readonly processEnvironment: NodeJS.ProcessEnv;
  private desired: DesiredAccount | undefined;
  private current: ManagedGeneration | undefined;
  private acceptingRequests = false;
  private lastFailure: DesktopDaemonFailureKind | undefined;
  private transitionTail: Promise<void> = Promise.resolve();
  private expiryTimer: NodeJS.Timeout | undefined;
  private readonly activeLeases = new Set<{
    readonly controller: AbortController;
    readonly release: () => void;
  }>();
  private readonly proxyDrainWaiters = new Set<() => void>();
  private crashRestartCount = 0;

  constructor(private readonly options: DesktopDaemonSupervisorOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.startupTimeoutMs = options.startupTimeoutMs ?? DESKTOP_DAEMON_STARTUP_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DESKTOP_DAEMON_SHUTDOWN_TIMEOUT_MS;
    this.proxyDrainTimeoutMs = options.proxyDrainTimeoutMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.parentPid = options.parentPid ?? process.pid;
    this.processEnvironment = options.processEnvironment ?? process.env;
  }

  synchronizeAccountState(state: AccountState): Promise<void> {
    const desired = this.authorizedAccount(state);
    this.desired = desired;
    if (desired === undefined || this.current?.profileId !== desired.profileId) {
      this.freezeProxyAccess();
    }
    this.scheduleExpiry(desired);
    this.options.onStateChange?.();
    return this.enqueue(() => this.reconcileDesiredAccount());
  }

  /** Freeze proxy access synchronously, then finish the old Profile shutdown before auth changes. */
  beginAccountBoundary(): Promise<void> {
    this.desired = undefined;
    this.clearExpiryTimer();
    this.freezeProxyAccess();
    this.options.onStateChange?.();
    return this.enqueue(() => this.stopCurrentGeneration());
  }

  closeForApplicationQuit(): Promise<void> {
    return this.beginAccountBoundary();
  }

  getAgentEntry(state: AccountState): AccountState["agentEntry"] {
    const desired = this.authorizedAccount(state);
    if (desired === undefined) return { available: false, reason: "ACCOUNT_NOT_AUTHORIZED" };
    const generation = this.current;
    if (
      this.acceptingRequests &&
      generation?.lifecycleState === "READY" &&
      generation.profileId === desired.profileId
    ) {
      return { available: true };
    }
    if (generation?.lifecycleState === "STOP_BLOCKED") {
      return { available: false, reason: "SAFE_SHUTDOWN_PENDING" };
    }
    return {
      available: false,
      reason: this.lastFailure ?? "DAEMON_STARTING",
    };
  }

  acquireProxyLease(requestSignal: AbortSignal): DesktopDaemonProxyLease | null {
    const desired = this.desired;
    const generation = this.current;
    if (
      requestSignal.aborted ||
      !this.acceptingRequests ||
      desired === undefined ||
      (desired.expiresAt !== undefined && desired.expiresAt <= this.now()) ||
      generation === undefined ||
      generation.lifecycleState !== "READY" ||
      generation.profileId !== desired.profileId ||
      generation.boundPort === undefined ||
      generation.hostToken.length === 0
    ) {
      return null;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    requestSignal.addEventListener("abort", abort, { once: true });
    if (requestSignal.aborted) controller.abort();
    const leaseState = {
      controller,
      release: () => {
        requestSignal.removeEventListener("abort", abort);
        generation.abortController.signal.removeEventListener("abort", abort);
        this.activeLeases.delete(leaseState);
        if (this.activeLeases.size === 0) {
          for (const notify of this.proxyDrainWaiters) notify();
          this.proxyDrainWaiters.clear();
        }
      },
    };
    generation.abortController.signal.addEventListener("abort", abort, { once: true });
    if (generation.abortController.signal.aborted) controller.abort();
    this.activeLeases.add(leaseState);
    return {
      baseUrl: `http://127.0.0.1:${generation.boundPort}`,
      hostToken: generation.hostToken,
      signal: controller.signal,
      release: leaseState.release,
    };
  }

  private async reconcileDesiredAccount(): Promise<void> {
    const desired = this.desired;
    if (desired === undefined) {
      await this.stopCurrentGeneration();
      return;
    }
    const current = this.current;
    if (
      current !== undefined &&
      current.profileId === desired.profileId &&
      current.lifecycleState === "READY" &&
      desired.expiresAt !== undefined &&
      desired.expiresAt <= this.now()
    ) {
      this.desired = undefined;
      this.freezeProxyAccess();
      await this.stopCurrentGeneration();
      this.options.onAuthorizationExpired?.(desired.state);
      return;
    }
    if (
      current !== undefined &&
      current.profileId === desired.profileId &&
      current.lifecycleState === "READY"
    ) {
      this.acceptingRequests = true;
      this.lastFailure = undefined;
      this.options.onStateChange?.();
      return;
    }

    this.acceptingRequests = false;
    await this.stopCurrentGeneration();
    if (!this.isDesiredAccountCurrent(desired)) return;

    let profile: AccountProfile;
    try {
      profile = await this.options.profileManager.selectForUser(desired.userId);
    } catch {
      this.lastFailure = "DAEMON_UNAVAILABLE";
      this.options.onStateChange?.();
      throw new DesktopDaemonSupervisorError(
        "PROFILE_UNAVAILABLE",
        "The account profile could not be opened safely.",
      );
    }
    if (profile.profileId !== desired.profileId) {
      this.lastFailure = "DAEMON_UNAVAILABLE";
      throw new DesktopDaemonSupervisorError(
        "PROFILE_BINDING_MISMATCH",
        "The account profile binding could not be verified.",
      );
    }
    if (!this.isDesiredAccountCurrent(desired)) return;

    try {
      await this.startGeneration(profile, desired.userId);
    } catch (error) {
      this.lastFailure = failureKindFor(error);
      this.options.onStateChange?.();
      throw error;
    }
    if (!this.isDesiredAccountCurrent(desired)) {
      await this.stopCurrentGeneration();
      return;
    }
    this.acceptingRequests = true;
    this.lastFailure = undefined;
    this.crashRestartCount = 0;
    this.options.onStateChange?.();
  }

  private async startGeneration(profile: AccountProfile, userId: string): Promise<void> {
    const resources = await this.options.resolveResources();
    const generationId = randomUUID();
    let bootstrapSecret = randomBytes(32).toString("base64url");
    const environment = childEnvironment(this.processEnvironment, profile.rootDirectory);
    const child = (this.options.spawnDaemon ?? spawnDaemonChild)(
      resources,
      profile.rootDirectory,
      environment,
    );
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
      child.kill("SIGTERM");
      throw new DesktopDaemonSupervisorError(
        "CHILD_IDENTITY_INVALID",
        "The local Daemon process identity could not be verified.",
      );
    }
    const childPid = child.pid as number;
    const hostToken = randomBytes(32).toString("base64url");
    const abortController = new AbortController();
    const logSink = new ChildLogSink(profile.logsDirectory, [bootstrapSecret, hostToken]);
    const exitPromise = waitForExit(child);
    const generation: ManagedGeneration = {
      userId,
      profileId: profile.profileId,
      generationId,
      child,
      childPid,
      productVersion: this.options.productVersion,
      protocolVersion: 1 as const,
      requiredCapabilities: DESKTOP_DAEMON_REQUIRED_CAPABILITIES,
      profile,
      bootstrapSecret,
      hostToken,
      abortController,
      logSink,
      exitPromise,
      lifecycleState: "STARTING",
      exitObserved: false,
    };
    this.current = generation;
    generation.credentialRpcServer = new MainCredentialRpcServer({
      identity: {
        generationId,
        profileId: profile.profileId,
        childPid,
        cloudUserId: userId,
      },
      isCurrentGeneration: () =>
        this.current === generation && !generation.abortController.signal.aborted,
      credentials: this.options.credentialVault,
      send: (response) => sendChildMessage(child, response),
    });
    generation.credentialRpcListener = (message) => {
      void generation.credentialRpcServer?.handle(message);
    };
    child.on("message", generation.credentialRpcListener);
    this.attachChildLogging(generation);
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      generation.exit = { code, signal };
      generation.exitObserved = true;
      this.disposeCredentialRpc(generation);
      void generation.logSink.close();
      this.onChildExit(generation, code, signal);
    });
    child.on("error", () => {
      this.onUnexpectedChildError(generation);
    });

    const deadline = this.now() + this.startupTimeoutMs;
    const startMessage = {
      type: "START_DESKTOP_DAEMON",
      ipcProtocolVersion: 1,
      generationId,
      profileId: profile.profileId,
      desktopVersion: this.options.productVersion,
      expectedDaemonVersion: this.options.productVersion,
      apiVersion: "v1",
      protocolVersion: 1,
      requiredCapabilities: [...DESKTOP_DAEMON_REQUIRED_CAPABILITIES],
      bootstrapSecret,
      bootstrapExpiresAt: deadline,
      hostToken,
    };

    let startupWaiter: MessageWaiter | undefined;
    try {
      startupWaiter = waitForChildMessage(child, Math.max(1, deadline - this.now()));
      await sendChildMessage(child, startMessage);
      bootstrapSecret = "";
      generation.bootstrapSecret = "";
      startMessage.bootstrapSecret = "";
      const rawReady = await startupWaiter.promise;
      const failedMessage = StartupFailedMessageSchema.safeParse(rawReady);
      if (failedMessage.success && failedMessage.data.generationId === generation.generationId) {
        throw new DesktopDaemonSupervisorError(
          "DAEMON_STARTUP_FAILED",
          "The local Daemon could not start securely.",
          "DAEMON_UNAVAILABLE",
        );
      }
      const ready = this.validateReadyMessage(rawReady, generation);
      generation.boundPort = ready.port;
      await this.verifyHealthAndInfo(generation, ready, deadline);
      generation.lifecycleState = "READY";
    } catch (error) {
      startupWaiter?.cancel();
      await this.cleanupFailedStartup(generation);
      if (error instanceof DesktopDaemonSupervisorError) throw error;
      if (this.now() >= deadline) {
        throw new DesktopDaemonSupervisorError(
          "DAEMON_START_TIMEOUT",
          "The local Daemon did not become ready in time.",
        );
      }
      throw new DesktopDaemonSupervisorError(
        "DAEMON_START_FAILED",
        "The local Daemon could not start securely.",
      );
    }
  }

  private validateReadyMessage(raw: unknown, generation: ManagedGeneration): ReadyMessage {
    const parsed = ReadyMessageSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.generationId !== generation.generationId ||
      parsed.data.profileId !== generation.profileId ||
      parsed.data.childPid !== generation.childPid ||
      parsed.data.parentPid !== this.parentPid ||
      parsed.data.bootstrapAccepted !== true ||
      parsed.data.daemonVersion !== generation.productVersion ||
      parsed.data.apiVersion !== "v1" ||
      parsed.data.protocolVersion !== 1 ||
      !generation.requiredCapabilities.every((capability) =>
        parsed.data.capabilities.includes(capability),
      )
    ) {
      throw new DesktopDaemonSupervisorError(
        "DAEMON_READY_INVALID",
        "The local Daemon process identity or startup contract is invalid.",
        "PROTOCOL_INCOMPATIBLE",
      );
    }
    return parsed.data;
  }

  private async verifyHealthAndInfo(
    generation: ManagedGeneration,
    ready: ReadyMessage,
    deadline: number,
  ): Promise<void> {
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const headers = new Headers({
      origin: baseUrl,
      "x-caelush-host-token": generation.hostToken,
    });
    const healthResponse = await this.fetchHandshake(`${baseUrl}/api/v1/health`, headers, deadline);
    if (!healthResponse.ok) throw protocolError();
    const health = HealthResponseSchema.safeParse(await readBoundedJson(healthResponse));
    if (
      !health.success ||
      health.data.status !== "ready" ||
      health.data.apiVersion !== "v1" ||
      health.data.protocolVersion !== 1
    ) {
      throw protocolError();
    }

    const infoResponse = await this.fetchHandshake(`${baseUrl}/api/v1/info`, headers, deadline);
    if (!infoResponse.ok) throw protocolError();
    const rawInfo = await readBoundedJson(infoResponse);
    const infoResult = DaemonInfoSchema.safeParse(rawInfo);
    if (!infoResult.success) throw protocolError();
    const info: DaemonInfo = infoResult.data;
    const declaredCapabilities = Object.entries(info.capabilities)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name)
      .sort();
    if (
      info.daemonVersion !== ready.daemonVersion ||
      declaredCapabilities.length !== ready.capabilities.length ||
      declaredCapabilities.some((capability, index) => capability !== ready.capabilities[index])
    ) {
      throw protocolError();
    }

    const compatibility = evaluateDesktopDaemonCompatibility(info, {
      productVersion: generation.productVersion,
      apiVersion: "v1",
      protocolVersion: 1,
      requiredCapabilities: generation.requiredCapabilities,
      hostIdentityVerified: true,
    });
    if (compatibility.status !== "COMPATIBLE" || !compatibility.canEnterWorkspace) {
      throw new DesktopDaemonSupervisorError(
        compatibility.status === "INCOMPATIBLE" ? compatibility.code : "PROTOCOL_INCOMPATIBLE",
        "The local Daemon is not compatible with this Desktop version.",
        "PROTOCOL_INCOMPATIBLE",
      );
    }
  }

  private fetchHandshake(url: string, headers: Headers, deadline: number): Promise<Response> {
    const remainingMs = deadline - this.now();
    if (remainingMs <= 0) return Promise.reject(new Error("startup timeout"));
    return this.fetcher(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(remainingMs),
    });
  }

  private async stopCurrentGeneration(): Promise<void> {
    const generation = this.current;
    if (generation === undefined) return;
    this.acceptingRequests = false;
    this.freezeProxyAccess();
    generation.lifecycleState = "STOPPING";
    this.options.onStateChange?.();

    if (!(await this.waitForProxyDrain())) {
      generation.lifecycleState = "STOP_BLOCKED";
      this.lastFailure = "SAFE_SHUTDOWN_PENDING";
      this.options.onStateChange?.();
      throw new DesktopDaemonSupervisorError(
        "PROXY_DRAIN_TIMEOUT",
        "The protected local requests have not closed safely yet.",
        "SAFE_SHUTDOWN_PENDING",
      );
    }

    this.disposeCredentialRpc(generation);

    const stopMessage = {
      type: "STOP_DESKTOP_DAEMON",
      ipcProtocolVersion: 1,
      generationId: generation.generationId,
    };
    const waiter = waitForChildMessage(this.processFor(generation), this.shutdownTimeoutMs);
    try {
      await sendChildMessage(generation.child, stopMessage);
      const raw = await waiter.promise;
      const blocked = StopBlockedMessageSchema.safeParse(raw);
      if (blocked.success && blocked.data.generationId === generation.generationId) {
        generation.lifecycleState = "STOP_BLOCKED";
        this.lastFailure = "SAFE_SHUTDOWN_PENDING";
        this.options.onStateChange?.();
        throw new DesktopDaemonSupervisorError(
          "SAFE_CHECKPOINT_PENDING",
          "The local Daemon is waiting for a safe execution checkpoint.",
          "SAFE_SHUTDOWN_PENDING",
        );
      }
      const closed = StoppedMessageSchema.safeParse(raw);
      if (!closed.success || closed.data.generationId !== generation.generationId) {
        throw new DesktopDaemonSupervisorError(
          "DAEMON_STOP_RESPONSE_INVALID",
          "The local Daemon did not confirm a safe shutdown.",
          "SAFE_SHUTDOWN_PENDING",
        );
      }
      const exit = await waitForExitWithin(generation, this.shutdownTimeoutMs);
      if (exit === undefined || exit.code !== 0 || exit.signal !== null) {
        generation.lifecycleState = "STOP_BLOCKED";
        this.lastFailure = "SAFE_SHUTDOWN_PENDING";
        this.options.onStateChange?.();
        throw new DesktopDaemonSupervisorError(
          "DAEMON_EXIT_UNCONFIRMED",
          "The local Daemon did not complete its graceful shutdown.",
          "SAFE_SHUTDOWN_PENDING",
        );
      }
      this.current = undefined;
      generation.lifecycleState = "STOPPING";
      this.lastFailure = undefined;
      generation.abortController.abort();
      await generation.logSink.close();
      if (generation.child.connected) generation.child.disconnect();
      this.options.onStateChange?.();
    } catch (error) {
      waiter.cancel();
      if (this.current === generation && generation.lifecycleState !== "STOP_BLOCKED") {
        generation.lifecycleState = "STOP_BLOCKED";
        this.options.onStateChange?.();
      }
      if (!(error instanceof DesktopDaemonSupervisorError)) {
        this.lastFailure = "SAFE_SHUTDOWN_PENDING";
        throw new DesktopDaemonSupervisorError(
          "DAEMON_STOP_FAILED",
          "The local Daemon could not confirm a safe shutdown.",
          "SAFE_SHUTDOWN_PENDING",
        );
      }
      throw error;
    }
  }

  private processFor(generation: ManagedGeneration): DesktopChildProcess {
    if (this.current !== generation) {
      throw new DesktopDaemonSupervisorError(
        "DAEMON_GENERATION_INVALID",
        "The local Daemon generation is no longer active.",
        "SAFE_SHUTDOWN_PENDING",
      );
    }
    return generation.child;
  }

  private async cleanupFailedStartup(generation: ManagedGeneration): Promise<void> {
    this.acceptingRequests = false;
    generation.abortController.abort();
    this.disposeCredentialRpc(generation);
    if (this.current === generation) this.current = undefined;
    if (!generation.exitObserved) {
      try {
        if (generation.child.connected) {
          const waiter = waitForChildMessage(generation.child, 1500);
          await sendChildMessage(generation.child, {
            type: "STOP_DESKTOP_DAEMON",
            ipcProtocolVersion: 1,
            generationId: generation.generationId,
          });
          await waiter.promise.catch(() => undefined);
        }
      } catch {
        // Startup cleanup below is limited to the Child this Main created.
      }
      if (!generation.exitObserved) {
        try {
          generation.child.kill("SIGTERM");
        } catch {
          // The following wait records whether this owned Child actually exited.
        }
        await waitForExitWithin(generation, 2500);
      }
      if (!generation.exitObserved) {
        try {
          generation.child.kill("SIGKILL");
        } catch {
          // The child remains untrusted and has no proxy or token authority in Main.
        }
        await waitForExitWithin(generation, 2500);
      }
    }
    generation.hostToken = "";
    generation.bootstrapSecret = "";
    await generation.logSink.close();
  }

  private attachChildLogging(generation: ManagedGeneration): void {
    for (const stream of [generation.child.stdout, generation.child.stderr]) {
      if (stream === null) continue;
      stream.on("data", (chunk: Buffer | string) => {
        void generation.logSink.write(chunk);
      });
    }
  }

  private onChildExit(
    generation: ManagedGeneration,
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): void {
    this.disposeCredentialRpc(generation);
    if (this.current !== generation || generation.lifecycleState === "STOPPING") return;
    const wasReady = generation.lifecycleState === "READY";
    this.current = undefined;
    this.freezeProxyAccess();
    generation.hostToken = "";
    generation.bootstrapSecret = "";
    if (!wasReady) return;
    this.lastFailure = "DAEMON_UNAVAILABLE";
    this.options.onStateChange?.();
    const desired = this.desired;
    if (desired === undefined || this.crashRestartCount >= 2) return;
    this.crashRestartCount += 1;
    const delayMs = 250 * this.crashRestartCount;
    setTimeout(() => {
      if (this.desired === desired) {
        void this.enqueue(() => this.reconcileDesiredAccount()).catch(() => undefined);
      }
    }, delayMs).unref();
  }

  private onUnexpectedChildError(generation: ManagedGeneration): void {
    if (this.current !== generation || generation.lifecycleState === "STOPPING") return;
    generation.abortController.abort();
    this.disposeCredentialRpc(generation);
    this.acceptingRequests = false;
    this.lastFailure = "DAEMON_UNAVAILABLE";
    this.options.onStateChange?.();
  }

  private disposeCredentialRpc(generation: ManagedGeneration): void {
    if (generation.credentialRpcListener !== undefined) {
      generation.child.removeListener("message", generation.credentialRpcListener);
      delete generation.credentialRpcListener;
    }
    generation.credentialRpcServer?.dispose();
    delete generation.credentialRpcServer;
  }

  private freezeProxyAccess(): void {
    this.acceptingRequests = false;
    if (this.current !== undefined) this.current.hostToken = "";
    this.current?.abortController.abort();
    for (const lease of this.activeLeases) lease.controller.abort();
  }

  private async waitForProxyDrain(): Promise<boolean> {
    if (this.activeLeases.size === 0) return true;
    let timeout: NodeJS.Timeout | undefined;
    const drained = new Promise<true>((resolve) => this.proxyDrainWaiters.add(() => resolve(true)));
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), this.proxyDrainTimeoutMs);
      timeout.unref();
    });
    const result = await Promise.race([drained, expired]);
    if (timeout !== undefined) clearTimeout(timeout);
    return result;
  }

  private authorizedAccount(state: AccountState): DesiredAccount | undefined {
    const userId = state.account?.userId;
    if (userId === undefined) return undefined;
    let expiresAt: number | undefined;
    let authorityState: DesiredAccount["state"];
    if (state.status === "AUTHENTICATED_ONLINE") {
      authorityState = "ONLINE";
      const onlineExpiry = this.options.onlineExpiry?.();
      if (onlineExpiry !== undefined) expiresAt = onlineExpiry.getTime();
    } else if (
      state.status === "AUTHORIZED_OFFLINE" &&
      state.offlineGrant !== undefined &&
      state.offlineGrant !== null
    ) {
      authorityState = "OFFLINE";
      const parsedExpiry = Date.parse(state.offlineGrant.expiresAt);
      if (!Number.isFinite(parsedExpiry)) return undefined;
      expiresAt = parsedExpiry;
    } else {
      return undefined;
    }
    if (expiresAt !== undefined && expiresAt <= this.now()) return undefined;
    try {
      return {
        userId,
        profileId: profileIdForUser(userId),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        state: authorityState,
      };
    } catch {
      return undefined;
    }
  }

  private isDesiredAccountCurrent(desired: DesiredAccount): boolean {
    const current = this.desired;
    return (
      current?.userId === desired.userId &&
      current.profileId === desired.profileId &&
      (desired.expiresAt === undefined || desired.expiresAt > this.now())
    );
  }

  private scheduleExpiry(desired: DesiredAccount | undefined): void {
    this.clearExpiryTimer();
    if (desired?.expiresAt === undefined) return;
    const delay = Math.max(0, desired.expiresAt - this.now());
    this.expiryTimer = setTimeout(() => {
      if (!this.isDesiredAccountCurrent(desired)) return;
      this.desired = undefined;
      this.freezeProxyAccess();
      this.options.onAuthorizationExpired?.(desired.state);
      void this.enqueue(() => this.stopCurrentGeneration()).catch(() => undefined);
    }, delay);
    this.expiryTimer.unref();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.transitionTail.then(action);
    this.transitionTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

function childEnvironment(
  source: NodeJS.ProcessEnv,
  profileRootDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, CAELUSH_HOME: profileRootDirectory };
  for (const key of [
    "CAELUSH_DESKTOP_MODE",
    "CAELUSH_DESKTOP_HOST_TOKEN",
    "CAELUSH_DESKTOP_BOOTSTRAP_SECRET",
    "CAELUSH_HOST_TOKEN",
    "CAELUSH_BOOTSTRAP_SECRET",
    "CAELUSH_CLOUD_ACCESS_TOKEN",
    "CAELUSH_CLOUD_REFRESH_TOKEN",
    "CAELUSH_ACCESS_TOKEN",
    "CAELUSH_REFRESH_TOKEN",
    "CAELUSH_PROVIDER_API_KEY",
    "CAELUSH_DEVICE_PRIVATE_KEY",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
  ]) {
    delete environment[key];
  }
  for (const key of Object.keys(environment)) {
    if (/(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)/iu.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

function spawnDaemonChild(
  resources: DesktopDaemonResources,
  profileRootDirectory: string,
  environment: NodeJS.ProcessEnv,
): DesktopChildProcess {
  return fork(resources.daemonEntryPath, [], {
    cwd: profileRootDirectory,
    env: environment,
    execPath: resources.nodeExecutablePath,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  }) as DesktopChildProcess;
}

interface MessageWaiter {
  readonly promise: Promise<unknown>;
  cancel(): void;
}

function waitForChildMessage(child: DesktopChildProcess, timeoutMs: number): MessageWaiter {
  let settled = false;
  let timer: NodeJS.Timeout;
  let resolvePromise!: (value: unknown) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<unknown>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const cleanup = () => {
    clearTimeout(timer);
    child.removeListener("message", onMessage);
    child.removeListener("exit", onExit);
    child.removeListener("error", onError);
  };
  const resolve = (value: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  };
  const reject = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(error);
  };
  const onMessage = (message: unknown) => {
    if (
      isRecord(message) &&
      typeof message.type === "string" &&
      message.type.startsWith("CREDENTIAL_")
    ) {
      return;
    }
    resolve(message);
  };
  const onExit = () => reject(new Error("child exited before response"));
  const onError = () => reject(new Error("child process failed"));
  timer = setTimeout(() => reject(new Error("private IPC response timed out")), timeoutMs);
  child.on("message", onMessage);
  child.once("exit", onExit);
  child.once("error", onError);
  return { promise, cancel: () => reject(new Error("private IPC wait cancelled")) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sendChildMessage(child: DesktopChildProcess, message: unknown): Promise<void> {
  if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
    throw new Error("child channel closed");
  }
  await new Promise<void>((resolve, reject) => {
    try {
      child.send(message, (error) => (error === null ? resolve() : reject(error)));
    } catch {
      reject(new Error("private IPC send failed"));
    }
  });
}

function waitForExit(child: DesktopChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: null });
  return new Promise((resolve) => {
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ code, signal }),
    );
  });
}

async function waitForExitWithin(
  generation: ManagedGeneration & { readonly exitPromise: Promise<ChildExit> },
  timeoutMs: number,
): Promise<ChildExit | undefined> {
  if (generation.exit !== undefined) return generation.exit;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([generation.exitPromise, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 65_536)) {
    throw protocolError();
  }
  if (response.body === null) throw protocolError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65_536) throw protocolError();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw protocolError();
  }
}

function protocolError(): DesktopDaemonSupervisorError {
  return new DesktopDaemonSupervisorError(
    "PROTOCOL_INCOMPATIBLE",
    "The local Daemon is not compatible with this Desktop version.",
    "PROTOCOL_INCOMPATIBLE",
  );
}

function failureKindFor(error: unknown): DesktopDaemonFailureKind {
  return error instanceof DesktopDaemonSupervisorError ? error.failureKind : "DAEMON_UNAVAILABLE";
}

class ChildLogSink {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly logPath: string;

  constructor(
    private readonly logsDirectory: string,
    private readonly secrets: readonly string[],
  ) {
    this.logPath = path.join(logsDirectory, "daemon.log");
  }

  write(value: Buffer | string): Promise<void> {
    if (this.closed) return this.queue;
    let line = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    if (Buffer.byteLength(line, "utf8") > MAX_LOG_CHUNK_BYTES) {
      line = Buffer.from(line, "utf8").subarray(0, MAX_LOG_CHUNK_BYTES).toString("utf8");
    }
    for (const secret of this.secrets) {
      if (secret.length > 0) line = line.replaceAll(secret, "[redacted]");
    }
    const entry = `${new Date().toISOString()} ${line}`;
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        const metadata = await stat(this.logPath);
        if (metadata.size + Buffer.byteLength(entry, "utf8") > MAX_LOG_FILE_BYTES) {
          await rename(this.logPath, `${this.logPath}.1`).catch(() => undefined);
        }
      } catch {
        // A missing initial log is expected.
      }
      await appendFile(this.logPath, entry, { encoding: "utf8", mode: 0o600 });
    });
    return this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => undefined);
  }
}
