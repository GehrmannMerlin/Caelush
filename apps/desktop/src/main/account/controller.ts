import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CloudClientError } from "../cloud/client.js";
import type {
  AcceptedResponse,
  AccountView,
  AuthResult,
  ChangePasswordRequest,
  DeviceListResponse,
  DeviceRevocationResponse,
  EmailAddressRequest,
  LoginRequest,
  OperationSucceededResponse,
  RegisterRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
} from "../cloud/schemas.js";
import {
  ACTIVE_ACCOUNT_INDEX_KEY,
  getOrCreateDeviceIdentity,
  identityFromRecord,
  parseStoredAccountRecord,
  readActiveAccount,
  writeActiveAccount,
  type StoredAccountRecord,
} from "../credentials/device-identity.js";
import { DpapiVault, VaultUnavailableError } from "../credentials/vault.js";
import {
  createDeviceProof,
  OfflineGrantError,
  privateKeyFromPkcs8Base64,
  verifyOfflineGrant,
} from "../offline/grant.js";
import {
  createInitialAccountState,
  type AccountState,
  type AccountStatus,
  type SafeAccount,
  type SafeDevice,
} from "./state.js";

export interface CloudAccountPort {
  register(input: RegisterRequest, signal: AbortSignal): Promise<AcceptedResponse>;
  verifyEmail(input: VerifyEmailRequest, signal: AbortSignal): Promise<OperationSucceededResponse>;
  resendVerification(input: EmailAddressRequest, signal: AbortSignal): Promise<AcceptedResponse>;
  login(input: LoginRequest, signal: AbortSignal): Promise<AuthResult>;
  refresh(refreshToken: string, signal: AbortSignal): Promise<AuthResult>;
  logout(accessToken: string, signal: AbortSignal): Promise<OperationSucceededResponse>;
  forgotPassword(input: EmailAddressRequest, signal: AbortSignal): Promise<AcceptedResponse>;
  resetPassword(
    input: ResetPasswordRequest,
    signal: AbortSignal,
  ): Promise<OperationSucceededResponse>;
  changePassword(
    input: ChangePasswordRequest,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<OperationSucceededResponse>;
  listDevices(accessToken: string, signal: AbortSignal): Promise<DeviceListResponse>;
  revokeDevice(
    deviceId: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<DeviceRevocationResponse>;
}

export interface AccountControllerOptions {
  readonly vault: DpapiVault;
  readonly cloud: CloudAccountPort;
  readonly trustedOfflinePublicKeys: Readonly<Record<string, Uint8Array>>;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

interface OnlineSession {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
}

export interface DesktopLoginInput {
  readonly email: string;
  readonly password: string;
}

export class AccountOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccountOperationError";
  }
}

export class AccountController {
  private state = createInitialAccountState();
  private readonly listeners = new Set<(state: AccountState) => void>();
  private onlineSession: OnlineSession | undefined;
  private activeAccountKey: string | null = null;
  private monotonicAnchor: { readonly trustedTime: Date; readonly monotonicMs: number } | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly options: AccountControllerOptions) {}

  getState(): AccountState {
    return structuredClone(this.state);
  }

  subscribe(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  initialize(signal = new AbortController().signal): Promise<void> {
    return this.exclusive(async () => {
      if (this.initialized) return;
      this.setState(createInitialAccountState("INITIALIZING"));
      try {
        await this.options.vault.initialize();
        const accountKey = await readActiveAccount(this.options.vault);
        if (accountKey === null) {
          this.initialized = true;
          this.activeAccountKey = null;
          this.setState(createInitialAccountState("LOGIN_REQUIRED"));
          return;
        }
        this.activeAccountKey = accountKey;
        const rawRecord = await this.options.vault.get(accountKey);
        if (rawRecord === null) {
          await this.options.vault.delete(ACTIVE_ACCOUNT_INDEX_KEY);
          this.activeAccountKey = null;
          this.initialized = true;
          this.setState(createInitialAccountState("LOGIN_REQUIRED"));
          return;
        }
        const record = parseStoredAccountRecord(rawRecord);
        const identity = identityFromRecord(record);
        this.assertBoundIdentity(record);
        this.setState(this.accountState("REFRESHING", record, null));
        if (record.refreshToken !== null) {
          await this.consumeRefreshToken(
            accountKey,
            record,
            identity.privateKeyPkcs8Base64,
            record.refreshToken,
            signal,
          );
          this.initialized = true;
          return;
        }
        await this.enterOfflineOrExpired(accountKey, record, identity.privateKeyPkcs8Base64);
        this.initialized = true;
      } catch (error) {
        this.initialized = true;
        if (error instanceof VaultUnavailableError || error instanceof OfflineGrantError) {
          this.clearOnlineSession();
          this.setState({
            ...createInitialAccountState("LOCKED"),
            lastError: {
              code: error instanceof OfflineGrantError ? error.code : "VAULT_UNAVAILABLE",
              message: safeMessage(error),
            },
          });
          return;
        }
        this.failState("ERROR", error);
      }
    });
  }

  register(input: RegisterRequest, signal: AbortSignal): Promise<AcceptedResponse> {
    return this.exclusive(async () => {
      this.setStatus("REGISTERING", null);
      try {
        const result = await this.options.cloud.register(input, signal);
        this.setState({
          ...createInitialAccountState("LOGIN_REQUIRED"),
          notice: "If this email can be registered, a verification message has been sent.",
        });
        return result;
      } catch (error) {
        this.failState("LOGIN_REQUIRED", error);
        throw toOperationError(error);
      }
    });
  }

  verifyEmail(input: VerifyEmailRequest, signal: AbortSignal): Promise<OperationSucceededResponse> {
    return this.exclusive(async () => {
      this.setStatus("VERIFYING_EMAIL", null);
      try {
        const result = await this.options.cloud.verifyEmail(input, signal);
        this.setState({
          ...createInitialAccountState("LOGIN_REQUIRED"),
          notice: "Email verified. You can now sign in.",
        });
        return result;
      } catch (error) {
        this.failState("LOGIN_REQUIRED", error);
        throw toOperationError(error);
      }
    });
  }

  resendVerification(input: EmailAddressRequest, signal: AbortSignal): Promise<AcceptedResponse> {
    return this.exclusive(async () => {
      try {
        const result = await this.options.cloud.resendVerification(input, signal);
        this.patch({ notice: "If the account needs verification, a message has been sent." });
        return result;
      } catch (error) {
        this.failState(this.state.status, error);
        throw toOperationError(error);
      }
    });
  }

  forgotPassword(input: EmailAddressRequest, signal: AbortSignal): Promise<AcceptedResponse> {
    return this.exclusive(async () => {
      try {
        const result = await this.options.cloud.forgotPassword(input, signal);
        this.patch({
          notice: "If the account exists, password recovery instructions have been sent.",
        });
        return result;
      } catch (error) {
        this.failState(this.state.status, error);
        throw toOperationError(error);
      }
    });
  }

  resetPassword(
    input: ResetPasswordRequest,
    signal: AbortSignal,
  ): Promise<OperationSucceededResponse> {
    return this.exclusive(async () => {
      try {
        const result = await this.options.cloud.resetPassword(input, signal);
        this.setState({
          ...createInitialAccountState("LOGIN_REQUIRED"),
          notice: "Password reset. Sign in with your new password.",
        });
        return result;
      } catch (error) {
        this.failState("LOGIN_REQUIRED", error);
        throw toOperationError(error);
      }
    });
  }

  login(input: DesktopLoginInput, signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const preserveOfflineAuthorization = this.state.status === "AUTHORIZED_OFFLINE";
      this.clearOnlineSession();
      this.setStatus("AUTHENTICATING", null);
      try {
        const { accountKey, record, identity } = await getOrCreateDeviceIdentity(
          this.options.vault,
          input.email,
        );
        const auth = await this.options.cloud.login(
          {
            email: input.email,
            password: input.password,
            device: { label: record.deviceLabel, publicKey: identity.publicKeyBase64Url },
          },
          signal,
        );
        await this.acceptOnlineAuth(accountKey, record, identity.privateKeyPkcs8Base64, auth);
      } catch (error) {
        if (error instanceof VaultUnavailableError) {
          this.setState({
            ...createInitialAccountState("LOCKED"),
            lastError: { code: "VAULT_UNAVAILABLE", message: safeMessage(error) },
          });
        } else {
          this.failState(
            preserveOfflineAuthorization ? "AUTHORIZED_OFFLINE" : "LOGIN_REQUIRED",
            error,
          );
        }
        throw toOperationError(error);
      }
    });
  }

  refreshNow(signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const accountKey = this.activeAccountKey;
      if (accountKey === null)
        throw new AccountOperationError("SESSION_EXPIRED", "Sign in to refresh this account.");
      const current = await this.options.vault.get(accountKey);
      if (current === null)
        throw new AccountOperationError("SESSION_EXPIRED", "Sign in to refresh this account.");
      const record = parseStoredAccountRecord(current);
      const identity = identityFromRecord(record);
      if (record.refreshToken === null) {
        await this.enterOfflineOrExpired(accountKey, record, identity.privateKeyPkcs8Base64);
        return;
      }
      this.setState(this.accountState("REFRESHING", record, null));
      await this.consumeRefreshToken(
        accountKey,
        record,
        identity.privateKeyPkcs8Base64,
        record.refreshToken,
        signal,
      );
    });
  }

  async logout(signal: AbortSignal): Promise<{ readonly serverRevoked: boolean }> {
    return this.exclusive(async () => {
      const accountKey = this.activeAccountKey;
      let serverRevoked = false;
      const session = this.onlineSession;
      if (session !== undefined && session.accessExpiresAt.getTime() > this.now().getTime()) {
        try {
          await this.options.cloud.logout(session.accessToken, signal);
          serverRevoked = true;
        } catch {
          serverRevoked = false;
        }
      }
      if (accountKey !== null) {
        const current = await this.options.vault.get(accountKey);
        if (current !== null) {
          const record = parseStoredAccountRecord(current);
          await this.options.vault.set(accountKey, {
            ...record,
            sessionId: null,
            refreshToken: null,
            rotationUncertain: false,
            offlineGrant: null,
            lastTrustedServerTime: null,
            lastAcceptedTime: null,
          } satisfies StoredAccountRecord);
        }
        await this.options.vault.delete(ACTIVE_ACCOUNT_INDEX_KEY);
      }
      this.activeAccountKey = null;
      this.clearOnlineSession();
      this.setState({
        ...createInitialAccountState("LOGIN_REQUIRED"),
        notice: serverRevoked
          ? "Signed out. The Cloud session was revoked."
          : "Local credentials were cleared. Cloud session revocation could not be confirmed.",
      });
      return { serverRevoked };
    });
  }

  listDevices(signal: AbortSignal): Promise<readonly SafeDevice[]> {
    return this.exclusive(async () => {
      const token = this.requireOnlineToken();
      try {
        const result = await this.options.cloud.listDevices(token, signal);
        this.patch({ devices: result.devices });
        return result.devices;
      } catch (error) {
        this.failState(this.state.status, error);
        throw toOperationError(error);
      }
    });
  }

  revokeDevice(deviceId: string, signal: AbortSignal): Promise<DeviceRevocationResponse> {
    return this.exclusive(async () => {
      const token = this.requireOnlineToken();
      try {
        const result = await this.options.cloud.revokeDevice(deviceId, token, signal);
        const current = this.state.device?.deviceId === deviceId;
        if (current) {
          if (this.activeAccountKey !== null) {
            await this.options.vault.delete(this.activeAccountKey);
            await this.options.vault.delete(ACTIVE_ACCOUNT_INDEX_KEY);
          }
          this.activeAccountKey = null;
          this.clearOnlineSession();
          this.setState({
            ...createInitialAccountState("DEVICE_REVOKED"),
            notice: "This device was revoked. Sign in on another device to continue.",
          });
        } else {
          const refreshed = await this.options.cloud.listDevices(token, signal);
          this.patch({ devices: refreshed.devices, notice: "Device access revoked." });
        }
        return result;
      } catch (error) {
        this.failState(this.state.status, error);
        throw toOperationError(error);
      }
    });
  }

  changePassword(
    input: ChangePasswordRequest,
    signal: AbortSignal,
  ): Promise<OperationSucceededResponse> {
    return this.exclusive(async () => {
      const token = this.requireOnlineToken();
      try {
        const result = await this.options.cloud.changePassword(input, token, signal);
        await this.clearLocalSessionPreservingIdentity();
        this.clearOnlineSession();
        this.setState({
          ...createInitialAccountState("LOGIN_REQUIRED"),
          notice: "Password changed. Sign in again.",
        });
        return result;
      } catch (error) {
        this.failState(this.state.status, error);
        throw toOperationError(error);
      }
    });
  }

  private async consumeRefreshToken(
    accountKey: string,
    record: StoredAccountRecord,
    privateKeyBase64: string,
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Persist uncertainty before network I/O. After this point the old token is never retried.
    const consumed = {
      ...record,
      refreshToken: null,
      rotationUncertain: true,
    } satisfies StoredAccountRecord;
    await this.options.vault.set(accountKey, consumed);
    try {
      const auth = await this.options.cloud.refresh(refreshToken, signal);
      await this.acceptOnlineAuth(accountKey, consumed, privateKeyBase64, auth);
    } catch (error) {
      if (isOfflineTransportFailure(error)) {
        await this.enterOfflineOrExpired(accountKey, consumed, privateKeyBase64);
        return;
      }
      this.clearOnlineSession();
      if (isReplayDetected(error)) {
        await this.clearStoredGrantAndRefresh(accountKey, consumed);
      }
      this.setState({
        ...this.accountState("SESSION_EXPIRED", consumed, null),
        lastError: safeErrorProjection(error),
        notice: "The online session could not be restored. Sign in again to continue.",
      });
    }
  }

  private async acceptOnlineAuth(
    accountKey: string,
    previous: StoredAccountRecord,
    privateKeyBase64: string,
    auth: AuthResult,
  ): Promise<void> {
    if (!auth.account.emailVerified) {
      throw new AccountOperationError(
        "EMAIL_NOT_VERIFIED",
        "Verify this email address before signing in.",
      );
    }
    if (auth.device.revokedAt !== null || !auth.device.current) {
      throw new AccountOperationError("DEVICE_REVOKED", "This device is no longer authorized.");
    }
    if (previous.userId !== null && previous.userId !== auth.account.userId) {
      throw new AccountOperationError(
        "ACCOUNT_BINDING_MISMATCH",
        "The saved device identity belongs to another account.",
      );
    }
    if (previous.deviceId !== null && previous.deviceId !== auth.device.deviceId) {
      throw new AccountOperationError(
        "DEVICE_BINDING_MISMATCH",
        "The Cloud device identity does not match this device.",
      );
    }
    let lastTrustedServerTime = previous.lastTrustedServerTime;
    let lastAcceptedTime = previous.lastAcceptedTime;
    let acceptedGrant: unknown | null = null;
    let grantProjection: AccountState["offlineGrant"] = null;
    if (auth.offlineGrant !== null) {
      try {
        const challenge = randomBytes(32);
        const privateKey = privateKeyFromPkcs8Base64(privateKeyBase64);
        const proofSignature = createDeviceProof(
          privateKey,
          auth.offlineGrant.payload.grantId,
          challenge,
        );
        const verified = verifyOfflineGrant(auth.offlineGrant, {
          trustedPublicKeys: this.options.trustedOfflinePublicKeys,
          userId: auth.account.userId,
          deviceId: auth.device.deviceId,
          devicePrivateKey: privateKey,
          challenge,
          proofSignature,
          allowedEntitlements: new Set(["CAELUSH_DESKTOP_BASIC"]),
          clock: {
            wallTime: this.now(),
            lastTrustedServerTime: new Date(
              lastTrustedServerTime ?? auth.offlineGrant.payload.issuedAt,
            ),
            lastAcceptedTime: new Date(lastAcceptedTime ?? auth.offlineGrant.payload.issuedAt),
          },
        });
        acceptedGrant = auth.offlineGrant;
        const acceptedTime = verified.nextLastAcceptedTime.toISOString();
        lastTrustedServerTime = verified.trustedNow.toISOString();
        lastAcceptedTime = acceptedTime;
        this.monotonicAnchor = {
          trustedTime: verified.trustedNow,
          monotonicMs: this.monotonicNow(),
        };
        grantProjection = projectGrant(
          auth.offlineGrant.payload.issuedAt,
          verified.expiresAt,
          verified.entitlements,
          verified.trustedNow,
        );
        await this.options.vault.set(accountKey, {
          ...previous,
          userId: auth.account.userId,
          emailVerified: auth.account.emailVerified,
          createdAt: auth.account.createdAt,
          deviceId: auth.device.deviceId,
          deviceCreatedAt: auth.device.createdAt,
          deviceLastSeenAt: auth.device.lastSeenAt,
          sessionId: auth.sessionId,
          refreshToken: auth.tokens.refreshToken,
          rotationUncertain: false,
          offlineGrant: acceptedGrant,
          lastTrustedServerTime,
          lastAcceptedTime: acceptedTime,
          entitlements: auth.account.entitlements,
          accountEmail: auth.account.email,
        } satisfies StoredAccountRecord);
      } catch {
        acceptedGrant = null;
        grantProjection = null;
        await this.persistOnlineRecord(
          accountKey,
          previous,
          auth,
          null,
          lastTrustedServerTime,
          lastAcceptedTime,
        );
      }
    } else {
      this.monotonicAnchor = undefined;
      await this.persistOnlineRecord(
        accountKey,
        previous,
        auth,
        null,
        lastTrustedServerTime,
        lastAcceptedTime,
      );
    }
    await writeActiveAccount(this.options.vault, accountKey);
    this.activeAccountKey = accountKey;
    this.onlineSession = {
      accessToken: auth.tokens.accessToken,
      accessExpiresAt: new Date(auth.tokens.accessExpiresAt),
    };
    const safeAccount = safeAccountProjection(auth.account);
    this.setState({
      status: "AUTHENTICATED_ONLINE",
      account: safeAccount,
      device: auth.device,
      devices: [auth.device],
      offlineGrant: grantProjection,
      lastError: null,
      notice:
        acceptedGrant === null && auth.offlineGrant !== null
          ? "Connected online. The returned offline authorization could not be verified and was discarded."
          : null,
      agentEntry: { available: false, reason: "LOCAL_AGENT_INTEGRATION_PENDING" },
    });
  }

  private async persistOnlineRecord(
    accountKey: string,
    previous: StoredAccountRecord,
    auth: AuthResult,
    offlineGrant: unknown | null,
    lastTrustedServerTime: string | null,
    lastAcceptedTime: string | null,
  ): Promise<void> {
    await this.options.vault.set(accountKey, {
      ...previous,
      userId: auth.account.userId,
      emailVerified: auth.account.emailVerified,
      createdAt: auth.account.createdAt,
      deviceId: auth.device.deviceId,
      deviceCreatedAt: auth.device.createdAt,
      deviceLastSeenAt: auth.device.lastSeenAt,
      sessionId: auth.sessionId,
      refreshToken: auth.tokens.refreshToken,
      rotationUncertain: false,
      offlineGrant,
      lastTrustedServerTime,
      lastAcceptedTime,
      entitlements: auth.account.entitlements.map(({ code, enabled }) => ({ code, enabled })),
      accountEmail: auth.account.email,
    } satisfies StoredAccountRecord);
  }

  private async enterOfflineOrExpired(
    accountKey: string,
    record: StoredAccountRecord,
    privateKeyBase64: string,
  ): Promise<void> {
    this.clearOnlineSession();
    if (record.offlineGrant === null || record.userId === null || record.deviceId === null) {
      this.setState({
        ...this.accountState("SESSION_EXPIRED", record, null),
        notice:
          "No valid online session or offline authorization is available. Sign in when Cloud is reachable.",
      });
      return;
    }
    const privateKey = privateKeyFromPkcs8Base64(privateKeyBase64);
    const envelope = record.offlineGrant as { payload?: { grantId?: unknown; issuedAt?: unknown } };
    const grantId = envelope.payload?.grantId;
    if (typeof grantId !== "string")
      throw new OfflineGrantError(
        "ENVELOPE_INVALID",
        "The saved offline authorization is damaged.",
      );
    const challenge = randomBytes(32);
    const proofSignature = createDeviceProof(privateKey, grantId, challenge);
    try {
      const verified = verifyOfflineGrant(record.offlineGrant, {
        trustedPublicKeys: this.options.trustedOfflinePublicKeys,
        userId: record.userId,
        deviceId: record.deviceId,
        devicePrivateKey: privateKey,
        challenge,
        proofSignature,
        allowedEntitlements: new Set(["CAELUSH_DESKTOP_BASIC"]),
        clock: {
          wallTime: this.now(),
          lastTrustedServerTime: requiredDate(record.lastTrustedServerTime),
          lastAcceptedTime: requiredDate(record.lastAcceptedTime),
          ...(this.monotonicAnchor === undefined
            ? {}
            : { monotonicAnchor: this.monotonicAnchor, monotonicNowMs: this.monotonicNow() }),
        },
      });
      const updated = {
        ...record,
        lastAcceptedTime: verified.nextLastAcceptedTime.toISOString(),
      } satisfies StoredAccountRecord;
      await this.options.vault.set(accountKey, updated);
      this.setState({
        status: "AUTHORIZED_OFFLINE",
        account: storedAccountProjection(updated),
        device: storedDeviceProjection(updated),
        devices: this.state.devices,
        offlineGrant: projectGrant(
          String((record.offlineGrant as { payload: { issuedAt: string } }).payload.issuedAt),
          verified.expiresAt,
          verified.entitlements,
          verified.trustedNow,
        ),
        lastError: null,
        notice: "Offline authorization is active. It expires at the time shown above.",
        agentEntry: { available: false, reason: "LOCAL_AGENT_INTEGRATION_PENDING" },
      });
    } catch (error) {
      const expired = error instanceof OfflineGrantError && error.code === "GRANT_EXPIRED";
      this.setState({
        ...this.accountState(expired ? "OFFLINE_GRANT_EXPIRED" : "SESSION_EXPIRED", record, null),
        offlineGrant: null,
        lastError: safeErrorProjection(error),
        notice: expired
          ? "Offline authorization has expired. Connect to Cloud and sign in again."
          : "Offline authorization could not be verified. Sign in when Cloud is reachable.",
      });
    }
  }

  private async clearStoredGrantAndRefresh(
    accountKey: string,
    record: StoredAccountRecord,
  ): Promise<void> {
    await this.options.vault.set(accountKey, {
      ...record,
      refreshToken: null,
      rotationUncertain: true,
      offlineGrant: null,
      lastTrustedServerTime: null,
      lastAcceptedTime: null,
    } satisfies StoredAccountRecord);
  }

  private async clearLocalSessionPreservingIdentity(): Promise<void> {
    if (this.activeAccountKey === null) return;
    const current = await this.options.vault.get(this.activeAccountKey);
    if (current === null) return;
    const record = parseStoredAccountRecord(current);
    await this.options.vault.set(this.activeAccountKey, {
      ...record,
      sessionId: null,
      refreshToken: null,
      rotationUncertain: false,
      offlineGrant: null,
      lastTrustedServerTime: null,
      lastAcceptedTime: null,
    } satisfies StoredAccountRecord);
    await this.options.vault.delete(ACTIVE_ACCOUNT_INDEX_KEY);
    this.activeAccountKey = null;
  }

  private requireOnlineToken(): string {
    const session = this.onlineSession;
    if (session === undefined || session.accessExpiresAt.getTime() <= this.now().getTime()) {
      this.clearOnlineSession();
      throw new AccountOperationError(
        "SESSION_EXPIRED",
        "The online session expired. Sign in again to continue.",
      );
    }
    return session.accessToken;
  }

  private accountState(
    status: AccountStatus,
    record: StoredAccountRecord,
    error: AccountState["lastError"],
  ): AccountState {
    return {
      status,
      ...(record.userId === null ? {} : { account: storedAccountProjection(record) }),
      ...(record.deviceId === null ? {} : { device: storedDeviceProjection(record) }),
      offlineGrant: null,
      lastError: error,
      notice: null,
      agentEntry: { available: false, reason: "LOCAL_AGENT_INTEGRATION_PENDING" },
    };
  }

  private assertBoundIdentity(record: StoredAccountRecord): void {
    if ((record.userId === null) !== (record.deviceId === null)) {
      throw new OfflineGrantError(
        "DEVICE_BINDING_INVALID",
        "The saved account and device binding is incomplete.",
      );
    }
  }

  private setStatus(status: AccountStatus, lastError: AccountState["lastError"]): void {
    this.setState({ ...this.state, status, lastError, notice: null });
  }

  private patch(patch: Partial<AccountState>): void {
    this.setState({ ...this.state, ...patch });
  }

  private failState(status: AccountStatus, error: unknown): void {
    this.clearOnlineSession();
    this.setState({
      ...this.state,
      status,
      lastError: safeErrorProjection(error),
    });
  }

  private setState(state: AccountState): void {
    this.state = structuredClone(state);
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Account state observation must never control authentication.
      }
    }
  }

  private clearOnlineSession(): void {
    this.onlineSession = undefined;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private monotonicNow(): number {
    return this.options.monotonicNow?.() ?? performance.now();
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function projectGrant(
  issuedAt: string,
  expiresAt: Date,
  entitlements: readonly string[],
  now: Date,
): NonNullable<AccountState["offlineGrant"]> {
  const remainingHours = Math.max(
    0,
    Math.ceil((expiresAt.getTime() - now.getTime()) / (60 * 60 * 1000)),
  );
  return {
    issuedAt,
    expiresAt: expiresAt.toISOString(),
    entitlements: [...entitlements],
    remainingHours,
  };
}

function safeAccountProjection(account: AccountView): SafeAccount {
  return {
    userId: account.userId,
    email: account.email,
    emailVerified: account.emailVerified,
    entitlements: account.entitlements.map(({ code, enabled }) => ({ code, enabled })),
    createdAt: account.createdAt,
  };
}

function storedAccountProjection(record: StoredAccountRecord): SafeAccount {
  if (record.userId === null || record.createdAt === null) {
    throw new OfflineGrantError(
      "ACCOUNT_BINDING_INVALID",
      "The saved account projection is incomplete.",
    );
  }
  return {
    userId: record.userId,
    email: record.accountEmail,
    emailVerified: record.emailVerified,
    entitlements: record.entitlements.map(({ code, enabled }) => ({ code, enabled })),
    createdAt: record.createdAt,
  };
}

function storedDeviceProjection(record: StoredAccountRecord): SafeDevice {
  if (record.deviceId === null || record.deviceCreatedAt === null) {
    throw new OfflineGrantError(
      "DEVICE_BINDING_INVALID",
      "The saved device projection is incomplete.",
    );
  }
  return {
    deviceId: record.deviceId,
    label: record.deviceLabel,
    createdAt: record.deviceCreatedAt,
    lastSeenAt: record.deviceLastSeenAt,
    revokedAt: null,
    current: true,
  };
}

function requiredDate(value: string | null): Date {
  if (value === null || !Number.isFinite(Date.parse(value))) {
    throw new OfflineGrantError(
      "CLOCK_EVIDENCE_MISSING",
      "Trusted server time evidence is missing.",
    );
  }
  return new Date(value);
}

function safeErrorProjection(error: unknown): NonNullable<AccountState["lastError"]> {
  if (error instanceof AccountOperationError || error instanceof CloudClientError) {
    return { code: error.code, message: error.message.slice(0, 512) };
  }
  if (error instanceof OfflineGrantError)
    return { code: error.code, message: error.message.slice(0, 512) };
  if (error instanceof VaultUnavailableError)
    return { code: "VAULT_UNAVAILABLE", message: error.message };
  return { code: "REQUEST_FAILED", message: "The account request could not be completed." };
}

function safeMessage(error: Error): string {
  return error.message.slice(0, 512);
}

function toOperationError(error: unknown): AccountOperationError {
  const projection = safeErrorProjection(error);
  return new AccountOperationError(projection.code, projection.message);
}

function isOfflineTransportFailure(error: unknown): boolean {
  return (
    error instanceof CloudClientError &&
    (error.code === "NETWORK_UNAVAILABLE" || error.code === "NETWORK_TIMEOUT")
  );
}

function isReplayDetected(error: unknown): boolean {
  return error instanceof CloudClientError && error.code === "AUTH_REFRESH_REPLAYED";
}
