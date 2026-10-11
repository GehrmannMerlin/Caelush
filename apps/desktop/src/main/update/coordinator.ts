import { randomUUID } from "node:crypto";
import type { DesktopUpdateState } from "../../shared/update-contract.js";
import { compareSemVer } from "../../shared/semver.mjs";
import type { PolicyResponse, UpdateTrust } from "../cloud/update-policy.js";
import { verifyPolicyResponse } from "../cloud/update-policy.js";
import { verifyInstaller } from "./downloader.js";
import {
  UpdateStateStore,
  type PendingUpdateRecord,
  type BrowserUpdateSnapshot,
} from "./state-store.js";
import { DesktopUpdateError, updateError } from "./error.js";

interface CoordinatorOptions {
  readonly version: string;
  readonly trust: UpdateTrust;
  readonly store: UpdateStateStore;
  readonly client: { check(signal?: AbortSignal): Promise<PolicyResponse | null> };
  readonly download: (
    policy: PolicyResponse,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ) => Promise<string>;
  readonly confirmInstall: () => Promise<boolean>;
  readonly safeShutdown: () => Promise<void>;
  readonly handoff: (pending: PendingUpdateRecord) => Promise<void>;
  readonly verifyRuntime: () => Promise<void>;
  readonly captureProfile: () => Promise<string | null>;
  readonly verifyProfile: (
    snapshot: string | null,
    browserSnapshot?: BrowserUpdateSnapshot | null,
  ) => Promise<void>;
  readonly resume: () => Promise<void>;
}
/** Sole Main-owned update lifecycle. Renderer only receives this bounded projection. */
export class DesktopUpdateCoordinator {
  private state: DesktopUpdateState;
  private policy: PolicyResponse | null = null;
  private operation: Promise<void> | null = null;
  private operationKind: string | null = null;
  private abort: AbortController | null = null;
  private readonly listeners = new Set<(state: DesktopUpdateState) => void>();
  constructor(private readonly options: CoordinatorOptions) {
    this.state = {
      status: "IDLE",
      currentVersion: options.version,
      latestVersion: null,
      releaseNotes: "",
      artifactSize: 0,
      downloadedBytes: 0,
      mandatory: false,
      graceDeadline: null,
      errorCode: null,
      message: "Check for a signed Desktop update.",
    };
  }
  getState(): DesktopUpdateState {
    return Object.freeze({ ...this.state });
  }
  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async initialize(): Promise<void> {
    try {
      await this.options.store.initialize();
      const pending = this.options.store.pending();
      if (!pending) return;
      // Completed history grants no installation authority and outlives the policy validity window.
      // Every new install still verifies a live signed policy and its accepted revision.
      if (pending.step === "COMPLETED") {
        if (this.options.version === pending.targetVersion)
          this.set("COMPLETED", "This version completed verified update recovery.");
        return;
      }
      this.policy = this.verify(pending.responseJson, pending.sourceVersion);
      this.projectPolicy(this.policy);
      if (pending.targetVersion !== this.policy.payload.latestVersion)
        throw new DesktopUpdateError(
          "UPDATE_PENDING_INVALID",
          "The pending update identity is inconsistent.",
        );
      if (pending.step === "READY") {
        if (this.options.version !== pending.sourceVersion)
          throw new DesktopUpdateError(
            "UPDATE_PENDING_INVALID",
            "The pending installer targets another source version.",
          );
        await verifyInstaller(this.policy, this.options.store, pending.installerName);
        this.set(
          "READY_TO_INSTALL",
          "Verified installer recovered. Installation requires confirmation.",
        );
        return;
      }
      const receipt = await this.options.store.readReceipt(pending.transactionId);
      if (
        receipt?.transactionId !== pending.transactionId ||
        receipt.status !== "INSTALLER_EXITED" ||
        receipt.exitCode !== 0
      ) {
        throw new DesktopUpdateError(
          receipt?.status === "CANCELLED"
            ? "UPDATE_INSTALL_CANCELLED"
            : "UPDATE_INSTALL_UNCONFIRMED",
          "Installation was interrupted, cancelled, failed or has not confirmed its exit. The existing Profile is preserved.",
        );
      }
      if (pending.step !== "POST_INSTALL_PROFILE_VERIFIED")
        await this.options.store.setPending({ ...pending, step: "POST_INSTALL_VERIFY_PENDING" });
      if (
        this.options.version !== pending.targetVersion ||
        compareSemVer(this.options.version, pending.sourceVersion) <= 0
      ) {
        throw new DesktopUpdateError(
          "UPDATE_VERSION_UNCONFIRMED",
          "The installer exited, but the expected new Desktop version has not started.",
        );
      }
      if (pending.step !== "POST_INSTALL_PROFILE_VERIFIED") {
        await this.options.verifyProfile(pending.profileSnapshot, receipt.browserSnapshot);
        await this.options.store.setPending({ ...pending, step: "POST_INSTALL_PROFILE_VERIFIED" });
      }
      await this.options.verifyRuntime();
      await this.options.store.setPending({ ...pending, step: "COMPLETED" });
      this.set("COMPLETED", "The new Desktop runtime and preserved Profile passed verification.");
    } catch (error) {
      this.fail(error);
    }
  }
  check(): Promise<void> {
    return this.exclusive("check", async () => {
      if (
        ["READY_TO_INSTALL", "WAITING_FOR_SAFE_SHUTDOWN", "INSTALLING"].includes(this.state.status)
      )
        return;
      this.set("CHECKING", "Requesting a signed update policy…");
      const policy = await this.options.client.check();
      if (!policy) {
        this.policy = null;
        this.set(
          "NO_POLICY",
          "There is currently no available update policy for this version and channel.",
        );
        return;
      }
      const verified = this.verify(policy.responseJson, this.options.version);
      await this.options.store.accept(verified);
      this.policy = verified;
      this.projectPolicy(verified);
      this.set(
        compareSemVer(verified.payload.latestVersion, this.options.version) > 0
          ? "UPDATE_AVAILABLE"
          : "UP_TO_DATE",
        compareSemVer(verified.payload.latestVersion, this.options.version) > 0
          ? "A signed update is available."
          : "The signed policy selects the currently installed version.",
      );
    });
  }
  download(): Promise<void> {
    return this.exclusive("download", async () => {
      if (
        ["READY_TO_INSTALL", "INSTALLING", "WAITING_FOR_SAFE_SHUTDOWN"].includes(this.state.status)
      )
        return;
      if (
        !this.policy ||
        compareSemVer(this.policy.payload.latestVersion, this.options.version) <= 0
      )
        throw invalidState();
      this.policy = this.verify(this.policy.responseJson, this.options.version);
      this.abort = new AbortController();
      this.state = { ...this.state, downloadedBytes: 0 };
      this.set("DOWNLOADING", "Downloading the signed release…");
      const name = await this.options.download(this.policy, this.abort.signal, (bytes) => {
        this.state = { ...this.state, downloadedBytes: bytes };
        this.publish();
      });
      this.set("VERIFYING", "Checking the installer size and SHA-512…");
      await verifyInstaller(this.policy, this.options.store, name);
      // Expiry can pass during a long download. Never publish a stale installer transaction.
      this.policy = this.verify(this.policy.responseJson, this.options.version);
      await this.options.store.setPending({
        transactionId: randomUUID(),
        sourceVersion: this.options.version,
        targetVersion: this.policy.payload.latestVersion,
        step: "READY",
        responseJson: this.policy.responseJson,
        installerName: name,
        profileSnapshot: null,
      });
      this.set("READY_TO_INSTALL", "Download verified. Confirm installation when you are ready.");
    });
  }
  install(): Promise<void> {
    return this.exclusive("install", async () => {
      const pending = this.options.store.pending();
      if (!pending || pending.step !== "READY") throw invalidState();
      const policy = this.verify(pending.responseJson, this.options.version);
      await verifyInstaller(policy, this.options.store, pending.installerName);
      if (!(await this.options.confirmInstall())) {
        this.set("INSTALL_DEFERRED", "Installation deferred. The verified download is retained.");
        return;
      }
      this.set(
        "WAITING_FOR_SAFE_SHUTDOWN",
        "Waiting for the Agent, protected requests, browser and terminal to close safely…",
      );
      try {
        await this.options.safeShutdown();
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "failureKind" in error
            ? error.failureKind
            : undefined;
        if (
          typeof code === "string" &&
          [
            "SAFE_CHECKPOINT_PENDING",
            "SAFE_SHUTDOWN_PENDING",
            "PROXY_DRAIN_TIMEOUT",
            "DAEMON_EXIT_UNCONFIRMED",
            "DAEMON_STOP_FAILED",
          ].includes(code)
        ) {
          this.set(
            "WAITING_FOR_SAFE_SHUTDOWN",
            "The Agent has not confirmed a safe shutdown. Retry after its operation reaches a safe checkpoint, or defer installation.",
          );
          return;
        }
        throw error;
      }
      try {
        this.verify(pending.responseJson, this.options.version);
        await verifyInstaller(policy, this.options.store, pending.installerName);
        const next = {
          ...pending,
          transactionId: randomUUID(),
          profileSnapshot: await this.options.captureProfile(),
          step: "HANDOFF_STARTED" as const,
        };
        await this.options.store.setPending(next);
        this.set("INSTALLING", "Handing the locked, verified installer to Windows…");
        await this.options.handoff(next);
      } catch (error) {
        await this.options.store.setPending({ ...pending, step: "READY" });
        await this.options.resume();
        throw error;
      }
    });
  }
  cancelDownload(): DesktopUpdateState {
    this.abort?.abort();
    return this.getState();
  }
  deferInstall(): Promise<void> {
    return this.exclusive("defer", async () => {
      if (this.state.status === "INSTALLING") return;
      if (this.options.store.pending()?.step !== "READY") throw invalidState();
      await this.options.resume();
      this.set("INSTALL_DEFERRED", "Installation deferred. Your verified download is retained.");
    });
  }
  private verify(raw: string, version: string) {
    return verifyPolicyResponse(
      raw,
      this.options.trust,
      version,
      this.options.store.accepted(this.options.trust.channel),
    );
  }
  private projectPolicy(policy: PolicyResponse) {
    const p = policy.payload;
    this.state = {
      ...this.state,
      latestVersion: p.latestVersion,
      releaseNotes: p.release.releaseNotes,
      artifactSize: p.release.artifactSize,
      mandatory: p.mandatory,
      graceDeadline: p.graceDeadline,
    };
  }
  private exclusive(kind: string, action: () => Promise<void>): Promise<void> {
    if (this.operation) return this.operationKind === kind ? this.operation : Promise.resolve();
    this.operationKind = kind;
    this.operation = Promise.resolve()
      .then(action)
      .catch((error) => this.fail(error))
      .finally(() => {
        this.operation = null;
        this.operationKind = null;
        this.abort = null;
      });
    return this.operation;
  }
  private fail(error: unknown) {
    const safe = updateError(error);
    this.state = { ...this.state, errorCode: safe.code };
    this.set("ERROR", safe.message, true);
  }
  private set(status: DesktopUpdateState["status"], message: string, keepError = false) {
    this.state = {
      ...this.state,
      status,
      message,
      errorCode: keepError ? this.state.errorCode : null,
    };
    this.publish();
  }
  private publish() {
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch {
        /* observers cannot interrupt Main */
      }
    }
  }
}
function invalidState() {
  return new DesktopUpdateError(
    "UPDATE_STATE_UNAVAILABLE",
    "This update operation is not available in the current state.",
  );
}
