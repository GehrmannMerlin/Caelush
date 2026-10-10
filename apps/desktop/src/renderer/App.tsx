import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cloud,
  Eye,
  EyeOff,
  KeyRound,
  LaptopMinimal,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  MonitorCog,
  RefreshCw,
  ShieldCheck,
  Unplug,
  X,
} from "lucide-react";
import type { AccountState, SafeDevice } from "../main/account/state.js";
import type {
  LegacyDataImportSummary,
  LegacyImportProgress,
} from "../shared/legacy-data-contract.js";

type AuthScreen = "login" | "register" | "verify" | "forgot" | "reset";
type AccountScreen = "home" | "devices" | "security";

const initialState: AccountState = {
  status: "INITIALIZING",
  lastError: null,
  notice: null,
  agentEntry: { available: false, reason: "ACCOUNT_NOT_AUTHORIZED" },
};

export function DesktopApp() {
  const [accountState, setAccountState] = useState<AccountState>(initialState);
  const [screen, setScreen] = useState<AuthScreen | AccountScreen>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [token, setToken] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [devices, setDevices] = useState<readonly SafeDevice[]>([]);
  const [platformLabel, setPlatformLabel] = useState("Windows · Desktop");
  const [legacySummary, setLegacySummary] = useState<LegacyDataImportSummary | null>(null);
  const [legacyDismissed, setLegacyDismissed] = useState(false);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyProgress, setLegacyProgress] = useState<LegacyImportProgress | null>(null);
  const [legacyMessage, setLegacyMessage] = useState<{
    readonly tone: "info" | "error";
    readonly message: string;
  } | null>(null);

  const authenticated =
    accountState.status === "AUTHENTICATED_ONLINE" || accountState.status === "AUTHORIZED_OFFLINE";
  const online = accountState.status === "AUTHENTICATED_ONLINE";
  const authScreenOpen =
    screen === "login" ||
    screen === "register" ||
    screen === "verify" ||
    screen === "forgot" ||
    screen === "reset";
  const reconnectingOffline = accountState.status === "AUTHORIZED_OFFLINE" && authScreenOpen;
  const activeView = useMemo<AccountScreen>(() => {
    return screen === "devices" || screen === "security" ? screen : "home";
  }, [screen]);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.caelushDesktop.account.subscribeState((state) => {
      if (active) setAccountState(state);
    });
    void window.caelushDesktop.account
      .getState()
      .then((state) => {
        if (active) setAccountState(state);
      })
      .catch(() => undefined);
    void window.caelushDesktop.window
      .getPlatform()
      .then(({ platform, arch, version }) => {
        if (active)
          setPlatformLabel(`${platform === "win32" ? "Windows" : platform} ${arch} · ${version}`);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setScreen((current) => (current === "devices" || current === "security" ? "login" : current));
    } else if (online && authScreenOpen) {
      setScreen("home");
    }
  }, [authenticated, online, authScreenOpen, screen]);

  useEffect(() => {
    if (screen !== "devices" || !online) {
      if (!online) setDevices([]);
      return;
    }
    let active = true;
    void window.caelushDesktop.account
      .listDevices()
      .then((result) => {
        if (active) setDevices(result);
      })
      .catch((error: unknown) => {
        if (active) setFeedback(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [online, screen]);

  useEffect(() => {
    if (!authenticated || accountState.account?.userId === undefined) {
      setLegacySummary(null);
      setLegacyProgress(null);
      setLegacyMessage(null);
      return;
    }
    let active = true;
    setLegacyDismissed(false);
    const unsubscribe = window.caelushDesktop.legacyData.subscribeProgress((progress) => {
      if (active) setLegacyProgress(progress);
    });
    void window.caelushDesktop.legacyData
      .inspect()
      .then((summary) => {
        if (active) setLegacySummary(summary);
      })
      .catch((error: unknown) => {
        if (active) setLegacyMessage({ tone: "error", message: errorMessage(error) });
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [authenticated, accountState.account?.userId]);

  async function submit(event: FormEvent<HTMLFormElement>, operation: () => Promise<unknown>) {
    event.preventDefault();
    setFeedback(null);
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.login({ email, password });
      setPassword("");
      setScreen("home");
    });
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.register({ email, password });
      setPassword("");
      setFeedback("If this address can be registered, a verification email is on its way.");
      setScreen("verify");
    });
  }

  async function verifyEmail(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.verifyEmail({ verificationToken: token });
      setToken("");
      setPassword("");
      setFeedback("Email verified. Sign in to connect this device.");
      setScreen("login");
    });
  }

  async function resendVerification(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.resendVerification({ email });
      setFeedback("If the address needs verification, a new email has been sent.");
    });
  }

  async function forgotPassword(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.forgotPassword({ email });
      setFeedback(
        "If an account exists for this address, password recovery instructions have been sent.",
      );
      setScreen("reset");
    });
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.resetPassword({ resetToken: token, newPassword });
      setToken("");
      setNewPassword("");
      setFeedback("Password reset. You can sign in with the new password.");
      setScreen("login");
    });
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setFeedback("Password changed. Sign in again with your new password.");
      setScreen("login");
    });
  }

  async function signOut() {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await window.caelushDesktop.account.logout();
      setScreen("login");
      setFeedback(
        result.serverRevoked
          ? "Signed out and Cloud session revoked."
          : "Local credentials cleared. Cloud session revocation could not be confirmed.",
      );
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshAccount() {
    setBusy(true);
    setFeedback(null);
    try {
      await window.caelushDesktop.account.refreshNow();
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function revokeDevice(device: SafeDevice) {
    const label = device.current ? "this device" : device.label;
    if (!window.confirm(`Revoke ${label}? That device will need to sign in again.`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await window.caelushDesktop.account.revokeDevice({ deviceId: device.deviceId });
      setDevices((current) => current.filter((item) => item.deviceId !== device.deviceId));
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function importLegacyData(candidateId: string) {
    setLegacyBusy(true);
    setLegacyProgress(null);
    setLegacyMessage(null);
    try {
      await window.caelushDesktop.legacyData.import({ candidateId, confirmed: true });
      setLegacyMessage({
        tone: "info",
        message:
          "Local data import completed. The protected backup is verified and the original source remains in place.",
      });
      setLegacySummary(await window.caelushDesktop.legacyData.inspect());
    } catch (error) {
      setLegacyMessage({ tone: "error", message: errorMessage(error) });
      await window.caelushDesktop.legacyData
        .inspect()
        .then(setLegacySummary)
        .catch(() => undefined);
    } finally {
      setLegacyBusy(false);
    }
  }

  async function resumeLegacyImport() {
    setLegacyBusy(true);
    setLegacyProgress(null);
    setLegacyMessage(null);
    try {
      await window.caelushDesktop.legacyData.resume();
      setLegacyMessage({
        tone: "info",
        message:
          "Protected recovery completed. The destination Profile passed verification and the original source remains in place.",
      });
      setLegacySummary(await window.caelushDesktop.legacyData.inspect());
    } catch (error) {
      setLegacyMessage({ tone: "error", message: errorMessage(error) });
      await window.caelushDesktop.legacyData
        .inspect()
        .then(setLegacySummary)
        .catch(() => undefined);
    } finally {
      setLegacyBusy(false);
    }
  }

  const apiError = feedback ?? accountState.lastError?.message ?? null;
  const authenticatedScreen =
    authenticated && !reconnectingOffline ? (
      <AccountHome
        accountState={accountState}
        activeView={activeView}
        devices={devices}
        busy={busy}
        feedback={apiError}
        onNavigate={setScreen}
        onLogout={() => void signOut()}
        onOpenAgent={() => window.location.assign("caelush-app://app/agent/")}
        onRefresh={() => void refreshAccount()}
        onRevoke={(device) => void revokeDevice(device)}
        onReconnect={() => {
          setEmail(accountState.account?.email ?? "");
          setFeedback(null);
          setScreen("login");
        }}
        onChangePassword={(event) => void changePassword(event)}
        legacySummary={legacySummary}
        legacyDismissed={legacyDismissed}
        legacyBusy={legacyBusy}
        legacyProgress={legacyProgress}
        legacyMessage={legacyMessage}
        onDismissLegacy={() => setLegacyDismissed(true)}
        onImportLegacy={(candidateId) => void importLegacyData(candidateId)}
        onResumeLegacy={() => void resumeLegacyImport()}
        currentPassword={currentPassword}
        newPassword={newPassword}
        setCurrentPassword={setCurrentPassword}
        setNewPassword={setNewPassword}
      />
    ) : (
      <AuthShell
        screen={screen as AuthScreen}
        status={accountState.status}
        email={email}
        password={password}
        newPassword={newPassword}
        token={token}
        busy={busy}
        showPassword={showPassword}
        message={apiError ?? accountState.notice}
        setEmail={setEmail}
        setPassword={setPassword}
        setNewPassword={setNewPassword}
        setToken={setToken}
        setShowPassword={setShowPassword}
        setScreen={setScreen}
        onLogin={(event) => void login(event)}
        onRegister={(event) => void register(event)}
        onVerify={(event) => void verifyEmail(event)}
        onResend={(event) => void resendVerification(event)}
        onForgot={(event) => void forgotPassword(event)}
        onReset={(event) => void resetPassword(event)}
      />
    );

  return (
    <div className="desktop-app">
      <header className="app-topbar">
        <div className="topbar-brand">
          <img src="/caelush-app-icon.png" alt="" />
          <span>CAELUSH</span>
          <i />
          <span className="topbar-product">Desktop</span>
        </div>
        <div className="topbar-state">
          <span
            className={`connection-dot ${online ? "is-online" : authenticated ? "is-offline" : ""}`}
          />
          <span>
            {online
              ? "Cloud connected"
              : accountState.status === "AUTHORIZED_OFFLINE"
                ? "Offline authorization"
                : "Account"}
          </span>
        </div>
        <div className="native-controls" aria-label="Window controls">
          <button
            type="button"
            aria-label="Minimize window"
            onClick={() => void window.caelushDesktop.window.minimize()}
          >
            <span className="minimize-mark" />
          </button>
          <button
            type="button"
            aria-label="Maximize or restore window"
            onClick={() => void window.caelushDesktop.window.maximizeOrRestore()}
          >
            <span className="maximize-mark" />
          </button>
          <button
            type="button"
            className="close-control"
            aria-label="Close window"
            onClick={() => void window.caelushDesktop.window.close()}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      {authenticatedScreen}
      <footer className="app-footer">
        <span>{platformLabel}</span>
        <span>
          <ShieldCheck size={13} /> Credentials stay in Windows protected storage
        </span>
      </footer>
    </div>
  );
}

function AuthShell(props: {
  screen: AuthScreen;
  status: AccountState["status"];
  email: string;
  password: string;
  newPassword: string;
  token: string;
  busy: boolean;
  showPassword: boolean;
  message: string | null;
  setEmail(value: string): void;
  setPassword(value: string): void;
  setNewPassword(value: string): void;
  setToken(value: string): void;
  setShowPassword(value: boolean): void;
  setScreen(value: AuthScreen | AccountScreen): void;
  onLogin(event: FormEvent<HTMLFormElement>): void;
  onRegister(event: FormEvent<HTMLFormElement>): void;
  onVerify(event: FormEvent<HTMLFormElement>): void;
  onResend(event: FormEvent<HTMLFormElement>): void;
  onForgot(event: FormEvent<HTMLFormElement>): void;
  onReset(event: FormEvent<HTMLFormElement>): void;
}) {
  return (
    <main className="auth-layout">
      <section className="brand-panel">
        <div className="brand-orbit brand-orbit-one" />
        <div className="brand-orbit brand-orbit-two" />
        <div className="brand-panel-content">
          <div className="brand-emblem">
            <img src="/caelush-app-icon.png" alt="Caelush" />
          </div>
          <p className="eyebrow">LOCAL FIRST · ACCOUNT READY</p>
          <h1>
            Your work
            <br />
            <em>stays yours.</em>
          </h1>
          <p className="brand-copy">
            Connect your Caelush account to authorize this device. Your local workspace remains on
            this computer.
          </p>
          <div className="brand-rail">
            <div className="rail-item is-active">
              <span>
                <LockKeyhole size={15} />
              </span>
              <div>
                <b>Private by design</b>
                <small>Credentials stay in the Windows vault</small>
              </div>
              <Check size={15} />
            </div>
            <div className="rail-item">
              <span>
                <Clock3 size={15} />
              </span>
              <div>
                <b>Offline ready</b>
                <small>Use a signed grant for up to 15 days</small>
              </div>
            </div>
          </div>
        </div>
        <div className="brand-panel-foot">
          <span>01</span>
          <i />
          <span>ACCOUNT ACCESS</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-panel-inner">
          {props.status === "LOCKED" ? (
            <div className="locked-state">
              <div className="form-symbol is-warning">
                <LockKeyhole size={20} />
              </div>
              <p className="eyebrow">SECURE STORAGE UNAVAILABLE</p>
              <h2>Sign in is locked</h2>
              <p className="auth-description">
                Windows protected credential storage could not be opened. Caelush will not save
                credentials without it.
              </p>
              <MessageBox
                message={
                  props.message ?? "Check this Windows user profile and restart Caelush Desktop."
                }
                tone="error"
              />
            </div>
          ) : (
            <>
              <div className="auth-heading">
                <div className="form-symbol">
                  {props.screen === "verify" ? (
                    <Mail size={19} />
                  ) : props.screen === "forgot" || props.screen === "reset" ? (
                    <KeyRound size={19} />
                  ) : (
                    <ShieldCheck size={19} />
                  )}
                </div>
                <p className="eyebrow">CAELUSH ACCOUNT</p>
                <h2>{authTitle(props.screen)}</h2>
                <p className="auth-description">{authDescription(props.screen)}</p>
              </div>
              {props.message && (
                <MessageBox
                  message={props.message}
                  tone={props.status === "ERROR" ? "error" : "info"}
                />
              )}
              {props.screen === "login" && (
                <form className="auth-form" onSubmit={props.onLogin}>
                  <EmailField value={props.email} onChange={props.setEmail} />
                  <PasswordField
                    value={props.password}
                    label="Password"
                    autoComplete="current-password"
                    visible={props.showPassword}
                    onChange={props.setPassword}
                    onToggle={() => props.setShowPassword(!props.showPassword)}
                  />
                  <div className="form-row form-row-end">
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => props.setScreen("forgot")}
                    >
                      Forgot password?
                    </button>
                  </div>
                  <PrimaryButton busy={props.busy}>
                    Sign in <ArrowRight size={16} />
                  </PrimaryButton>
                  <div className="auth-switch">
                    New to Caelush?{" "}
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => props.setScreen("register")}
                    >
                      Create an account
                    </button>
                  </div>
                </form>
              )}
              {props.screen === "register" && (
                <form className="auth-form" onSubmit={props.onRegister}>
                  <EmailField value={props.email} onChange={props.setEmail} />
                  <PasswordField
                    value={props.password}
                    label="Create password"
                    autoComplete="new-password"
                    visible={props.showPassword}
                    onChange={props.setPassword}
                    onToggle={() => props.setShowPassword(!props.showPassword)}
                  />
                  <p className="field-hint">
                    A verification email is required before this account can sign in.
                  </p>
                  <PrimaryButton busy={props.busy}>
                    Create account <ArrowRight size={16} />
                  </PrimaryButton>
                  <div className="auth-switch">
                    Already registered?{" "}
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => props.setScreen("login")}
                    >
                      Sign in
                    </button>
                  </div>
                </form>
              )}
              {props.screen === "verify" && (
                <div className="auth-form">
                  <form onSubmit={props.onVerify}>
                    <label className="field-label" htmlFor="verification-token">
                      Email verification token
                    </label>
                    <div className="input-wrap">
                      <Mail size={16} />
                      <input
                        id="verification-token"
                        value={props.token}
                        onChange={(event) => props.setToken(event.target.value)}
                        minLength={16}
                        maxLength={4096}
                        required
                        autoComplete="one-time-code"
                      />
                    </div>
                    <PrimaryButton busy={props.busy}>
                      Verify email <ArrowRight size={16} />
                    </PrimaryButton>
                  </form>
                  <form className="secondary-form" onSubmit={props.onResend}>
                    <p className="field-hint">
                      Didn’t receive an email? We’ll send another if this address needs
                      verification.
                    </p>
                    <EmailField value={props.email} onChange={props.setEmail} />
                    <button className="secondary-button" disabled={props.busy} type="submit">
                      Resend verification email
                    </button>
                  </form>
                  <BackLink onClick={() => props.setScreen("login")}>Back to sign in</BackLink>
                </div>
              )}
              {props.screen === "forgot" && (
                <form className="auth-form" onSubmit={props.onForgot}>
                  <EmailField value={props.email} onChange={props.setEmail} />
                  <PrimaryButton busy={props.busy}>
                    Send recovery email <ArrowRight size={16} />
                  </PrimaryButton>
                  <BackLink onClick={() => props.setScreen("login")}>Back to sign in</BackLink>
                </form>
              )}
              {props.screen === "reset" && (
                <form className="auth-form" onSubmit={props.onReset}>
                  <label className="field-label" htmlFor="reset-token">
                    Password reset token
                  </label>
                  <div className="input-wrap">
                    <KeyRound size={16} />
                    <input
                      id="reset-token"
                      value={props.token}
                      onChange={(event) => props.setToken(event.target.value)}
                      minLength={16}
                      maxLength={4096}
                      required
                      autoComplete="one-time-code"
                    />
                  </div>
                  <PasswordField
                    value={props.newPassword}
                    label="New password"
                    autoComplete="new-password"
                    visible={props.showPassword}
                    onChange={props.setNewPassword}
                    onToggle={() => props.setShowPassword(!props.showPassword)}
                  />
                  <PrimaryButton busy={props.busy}>
                    Reset password <ArrowRight size={16} />
                  </PrimaryButton>
                  <BackLink onClick={() => props.setScreen("login")}>Back to sign in</BackLink>
                </form>
              )}
            </>
          )}
        </div>
        <div className="auth-panel-bottom">
          <span>Encrypted on this Windows user profile</span>
          <span>CAELUSH · DESKTOP</span>
        </div>
      </section>
    </main>
  );
}

function AccountHome(props: {
  accountState: AccountState;
  activeView: AccountScreen;
  devices: readonly SafeDevice[];
  busy: boolean;
  feedback: string | null;
  onNavigate(screen: AccountScreen): void;
  onLogout(): void;
  onOpenAgent(): void;
  onRefresh(): void;
  onReconnect(): void;
  onRevoke(device: SafeDevice): void;
  onChangePassword(event: FormEvent<HTMLFormElement>): void;
  legacySummary: LegacyDataImportSummary | null;
  legacyDismissed: boolean;
  legacyBusy: boolean;
  legacyProgress: LegacyImportProgress | null;
  legacyMessage: { readonly tone: "info" | "error"; readonly message: string } | null;
  onDismissLegacy(): void;
  onImportLegacy(candidateId: string): void;
  onResumeLegacy(): void;
  currentPassword: string;
  newPassword: string;
  setCurrentPassword(value: string): void;
  setNewPassword(value: string): void;
}) {
  const { accountState } = props;
  const offline = accountState.status === "AUTHORIZED_OFFLINE";
  const accountName = accountState.account?.email ?? "Caelush account";
  return (
    <main className="account-layout">
      <aside className="account-sidebar">
        <div className="sidebar-section-label">ACCOUNT</div>
        <button
          className={`side-nav ${props.activeView === "home" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("home")}
        >
          <MonitorCog size={16} /> Overview
        </button>
        <button
          className={`side-nav ${props.activeView === "devices" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("devices")}
        >
          <LaptopMinimal size={16} /> Devices
        </button>
        <button
          className={`side-nav ${props.activeView === "security" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("security")}
        >
          <KeyRound size={16} /> Security
        </button>
        <div className="sidebar-separator" />
        <div className="sidebar-profile">
          <div className="profile-avatar">{accountName.slice(0, 1).toUpperCase()}</div>
          <div className="profile-meta">
            <b>{accountName}</b>
            <span>{offline ? "Offline authorized" : "Connected"}</span>
          </div>
          <button
            type="button"
            className="icon-button signout-icon"
            aria-label="Sign out"
            disabled={props.busy}
            onClick={props.onLogout}
          >
            <LogOut size={16} />
          </button>
        </div>
        <button
          className="sidebar-logout"
          type="button"
          disabled={props.busy}
          onClick={props.onLogout}
        >
          <LogOut size={15} /> Sign out
        </button>
      </aside>

      <section className="account-content">
        <div className="account-page-head">
          <div>
            <p className="eyebrow">
              ACCOUNT CENTER <span>/</span> {props.activeView.toUpperCase()}
            </p>
            <h2>
              {props.activeView === "home"
                ? "Account overview"
                : props.activeView === "devices"
                  ? "Your devices"
                  : "Security settings"}
            </h2>
          </div>
          <div className={`authorization-pill ${offline ? "is-offline" : ""}`}>
            <span className="connection-dot" />
            {offline ? "Offline authorized" : "Account connected"}
          </div>
        </div>
        {props.feedback && <MessageBox message={props.feedback} tone="info" />}
        {props.activeView === "home" && (
          <Overview
            state={accountState}
            onNavigate={props.onNavigate}
            onRefresh={props.onRefresh}
            onReconnect={props.onReconnect}
            onOpenAgent={props.onOpenAgent}
            busy={props.busy}
            legacySummary={props.legacySummary}
            legacyDismissed={props.legacyDismissed}
            legacyBusy={props.legacyBusy}
            legacyProgress={props.legacyProgress}
            legacyMessage={props.legacyMessage}
            onDismissLegacy={props.onDismissLegacy}
            onImportLegacy={props.onImportLegacy}
            onResumeLegacy={props.onResumeLegacy}
          />
        )}
        {props.activeView === "devices" && (
          <DeviceManager
            state={accountState}
            devices={props.devices}
            busy={props.busy}
            onRevoke={props.onRevoke}
            onRefresh={props.onRefresh}
          />
        )}
        {props.activeView === "security" && (
          <SecuritySettings
            online={!offline}
            busy={props.busy}
            currentPassword={props.currentPassword}
            newPassword={props.newPassword}
            setCurrentPassword={props.setCurrentPassword}
            setNewPassword={props.setNewPassword}
            onChangePassword={props.onChangePassword}
            onRefresh={props.onRefresh}
          />
        )}
      </section>
    </main>
  );
}

function Overview(props: {
  state: AccountState;
  onNavigate(screen: AccountScreen): void;
  onRefresh(): void;
  onReconnect(): void;
  onOpenAgent(): void;
  busy: boolean;
  legacySummary: LegacyDataImportSummary | null;
  legacyDismissed: boolean;
  legacyBusy: boolean;
  legacyProgress: LegacyImportProgress | null;
  legacyMessage: { readonly tone: "info" | "error"; readonly message: string } | null;
  onDismissLegacy(): void;
  onImportLegacy(candidateId: string): void;
  onResumeLegacy(): void;
}) {
  const { state } = props;
  const offline = state.status === "AUTHORIZED_OFFLINE";
  const grant = state.offlineGrant;
  return (
    <>
      <section className={`connection-banner ${offline ? "is-offline" : ""}`}>
        <div className="banner-icon">{offline ? <Unplug size={19} /> : <Cloud size={19} />}</div>
        <div className="banner-copy">
          <b>{offline ? "Offline authorization is active" : "Account connected"}</b>
          <span>
            {offline
              ? "This device can use its signed authorization until it expires."
              : "Your account and this Windows device are connected to Caelush Cloud."}
          </span>
        </div>
        {offline ? (
          <button
            className="secondary-button compact"
            type="button"
            disabled={props.busy}
            onClick={props.onReconnect}
          >
            Sign in to reconnect <ArrowRight size={14} />
          </button>
        ) : (
          <button
            className="icon-button banner-action"
            type="button"
            disabled={props.busy}
            aria-label="Refresh account connection"
            onClick={props.onRefresh}
          >
            <RefreshCw size={16} className={props.busy ? "spin" : ""} />
          </button>
        )}
      </section>
      {offline && grant && (
        <section className="grant-panel">
          <div className="grant-head">
            <div className="grant-icon">
              <Clock3 size={17} />
            </div>
            <div>
              <span>OFFLINE GRANT</span>
              <b>
                {grant.remainingHours < 24
                  ? `${grant.remainingHours} hours remaining`
                  : `${Math.ceil(grant.remainingHours / 24)} days remaining`}
              </b>
            </div>
          </div>
          <div className="grant-progress">
            <i
              style={{
                width: `${Math.max(4, Math.min(100, (grant.remainingHours / 360) * 100))}%`,
              }}
            />
          </div>
          <div className="grant-dates">
            <span>Issued {formatDate(grant.issuedAt)}</span>
            <span>Expires {formatDate(grant.expiresAt)}</span>
          </div>
        </section>
      )}
      <div className="overview-grid">
        <section className="detail-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">IDENTITY</span>
              <h3>Account details</h3>
            </div>
            <BadgeCheck size={18} />
          </div>
          <div className="detail-row">
            <span>Email address</span>
            <b>{state.account?.email ?? "—"}</b>
          </div>
          <div className="detail-row">
            <span>Verification</span>
            <b className="verified-state">
              <Check size={14} /> Verified
            </b>
          </div>
          <div className="detail-row">
            <span>Entitlement</span>
            <b>
              {state.account?.entitlements.find((item) => item.enabled)?.code ??
                "No active entitlement"}
            </b>
          </div>
          <div className="detail-row">
            <span>Account since</span>
            <b>{state.account ? formatDate(state.account.createdAt) : "—"}</b>
          </div>
        </section>
        <section className="detail-panel device-summary">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">THIS DEVICE</span>
              <h3>Windows desktop</h3>
            </div>
            <LaptopMinimal size={18} />
          </div>
          <div className="device-name">
            <div className="device-tile">
              <LaptopMinimal size={19} />
            </div>
            <div>
              <b>{state.device?.label ?? "Caelush Desktop"}</b>
              <span>{state.device?.current ? "Current device" : "Device not verified"}</span>
            </div>
          </div>
          <div className="detail-row">
            <span>Device ID</span>
            <b className="mono-value">{state.device?.deviceId ?? "—"}</b>
          </div>
          <button
            type="button"
            className="inline-action"
            onClick={() => props.onNavigate("devices")}
          >
            Manage devices <ChevronRight size={15} />
          </button>
        </section>
      </div>
      <LegacyImportPanel
        summary={props.legacySummary}
        dismissed={props.legacyDismissed}
        busy={props.legacyBusy}
        progress={props.legacyProgress}
        message={props.legacyMessage}
        onDismiss={props.onDismissLegacy}
        onImport={props.onImportLegacy}
        onResume={props.onResumeLegacy}
      />
      <section className="agent-pending">
        <div className="pending-mark">
          <MonitorCog size={20} />
        </div>
        <div className="pending-copy">
          <p className="eyebrow">LOCAL AGENT</p>
          <h3>
            {state.agentEntry.available
              ? "Your local Agent is ready"
              : agentStatusTitle(state.agentEntry.reason)}
          </h3>
          <p>{agentStatusDescription(state.agentEntry.reason)}</p>
        </div>
        {state.agentEntry.available ? (
          <button
            type="button"
            className="primary-button compact-primary"
            onClick={props.onOpenAgent}
          >
            Open Agent <ArrowRight size={15} />
          </button>
        ) : (
          <span className="pending-status">
            {state.agentEntry.reason === "DAEMON_STARTING" ? "STARTING" : "UNAVAILABLE"}
          </span>
        )}
      </section>
    </>
  );
}

function LegacyImportPanel(props: {
  summary: LegacyDataImportSummary | null;
  dismissed: boolean;
  busy: boolean;
  progress: LegacyImportProgress | null;
  message: { readonly tone: "info" | "error"; readonly message: string } | null;
  onDismiss(): void;
  onImport(candidateId: string): void;
  onResume(): void;
}) {
  const [reviewCandidateId, setReviewCandidateId] = useState<string | null>(null);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const summary = props.summary;
  if (
    summary === null ||
    (summary.sources.length === 0 && !summary.pendingRecovery) ||
    (props.dismissed && props.message === null)
  ) {
    return null;
  }
  const candidate = summary.sources.find(
    (source) => source.candidateId === reviewCandidateId && source.importable,
  );
  const showReview = candidate !== undefined && !reviewDismissed && !summary.pendingRecovery;
  return (
    <section className={`legacy-import-panel ${summary.pendingRecovery ? "is-recovery" : ""}`}>
      <div className="legacy-import-heading">
        <div className="legacy-import-icon">
          <ShieldCheck size={18} />
        </div>
        <div>
          <p className="eyebrow">LOCAL DATA</p>
          <h3>
            {summary.pendingRecovery ? "Local import recovery needed" : "Legacy Caelush data"}
          </h3>
        </div>
      </div>
      {summary.pendingRecovery ? (
        <p className="legacy-import-copy">
          A previous import has not been committed. The Profile must pass protected recovery and a
          local Agent start before completion. Your legacy source is kept.
        </p>
      ) : (
        <p className="legacy-import-copy">
          A previous Caelush data folder is available on this Windows user profile. Review its
          contents before adding them to this account.
        </p>
      )}
      {summary.sources.map((source) => (
        <div className="legacy-source" key={source.candidateId}>
          <div className="legacy-source-title">
            <b>{source.sourceLabel}</b>
            <span>{formatBytes(source.estimatedBytes)}</span>
          </div>
          <div className="legacy-count-grid">
            <LegacyCount label="Workspaces" value={source.workspaces} />
            <LegacyCount label="Sessions" value={source.sessions} />
            <LegacyCount label="Runs" value={source.runs} />
            <LegacyCount label="Messages" value={source.messages} />
            <LegacyCount label="Durable events" value={source.durableEvents} />
            <LegacyCount label="Context checkpoints" value={source.contextCheckpoints} />
            <LegacyCount label="Tool records" value={source.toolExecutions} />
            <LegacyCount label="Provider credentials" value={source.providerCredentials} />
            <LegacyCount label="Model selections" value={source.modelSelections} />
            <LegacyCount label="Private Replay files" value={source.privateReplayFiles} />
          </div>
          {!summary.pendingRecovery && !source.importable && source.reason && (
            <p className="legacy-block-reason">{legacyBlockReason(source.reason)}</p>
          )}
          {source.importable && !summary.pendingRecovery && !showReview && (
            <div className="legacy-import-actions">
              <button
                type="button"
                className="secondary-button compact"
                disabled={props.busy}
                onClick={() => {
                  setReviewCandidateId(source.candidateId);
                  setReviewDismissed(false);
                }}
              >
                Review import <ArrowRight size={14} />
              </button>
              <button
                type="button"
                className="text-button"
                disabled={props.busy}
                onClick={props.onDismiss}
              >
                Not now
              </button>
            </div>
          )}
          {showReview && candidate?.candidateId === source.candidateId && (
            <div className="legacy-confirmation">
              <b>Import into this account’s local Profile?</b>
              <p>
                The data will stay on this PC and will not be uploaded to Cloud. Caelush creates and
                verifies a protected backup first. The source folder stays in place, and other Cloud
                accounts will not automatically share this data.
              </p>
              <div className="legacy-import-actions">
                <button
                  type="button"
                  className="primary-button compact-primary"
                  disabled={props.busy}
                  onClick={() => props.onImport(source.candidateId)}
                >
                  {props.busy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <ShieldCheck size={15} />
                  )}
                  Import into this account
                </button>
                <button
                  type="button"
                  className="secondary-button compact"
                  disabled={props.busy}
                  onClick={() => {
                    setReviewCandidateId(null);
                    setReviewDismissed(true);
                  }}
                >
                  Not now
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      {summary.pendingRecovery && (
        <div className="legacy-confirmation">
          <b>
            {summary.recoveryState === "DESTINATION_VERIFIED"
              ? "The destination passed checks; the local Agent needs a verified start"
              : summary.recoveryState === "RECOVERY_BLOCKED"
                ? "Recovery is waiting for a protected retry"
                : "A verified import backup is available"}
          </b>
          <p>
            Resume checks the backup against this account Profile, continues credential protection,
            and verifies the destination before the local Agent starts.
          </p>
          <button
            type="button"
            className="primary-button compact-primary"
            disabled={props.busy}
            onClick={props.onResume}
          >
            {props.busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            Resume protected recovery
          </button>
        </div>
      )}
      {props.progress &&
        props.progress !== "COMMITTED" &&
        props.progress !== "RECOVERY_REQUIRED" && (
          <div className="legacy-progress" role="status">
            <LoaderCircle size={14} className="spin" /> {legacyProgressLabel(props.progress)}
          </div>
        )}
      {props.message && <MessageBox message={props.message.message} tone={props.message.tone} />}
    </section>
  );
}

function LegacyCount(props: { label: string; value: number }) {
  return (
    <div className="legacy-count">
      <b>{new Intl.NumberFormat().format(props.value)}</b>
      <span>{props.label}</span>
    </div>
  );
}

function legacyProgressLabel(progress: LegacyImportProgress): string {
  switch (progress) {
    case "BACKUP_VERIFIED":
      return "Protected backup verified";
    case "IMPORT_STAGED":
      return "Import prepared";
    case "DESTINATION_VERIFIED":
      return "Profile data restored and checked";
    case "CREDENTIALS_SECURED":
      return "Provider credentials secured";
    case "COMMITTED":
      return "Import complete";
    case "RECOVERY_REQUIRED":
      return "Protected recovery is required";
  }
}

function legacyBlockReason(
  reason: NonNullable<LegacyDataImportSummary["sources"][number]["reason"]>,
): string {
  switch (reason) {
    case "SOURCE_UNREADABLE":
      return "This source could not be read safely.";
    case "UNSUPPORTED_SCHEMA":
      return "This data format is not supported by the safe importer.";
    case "TARGET_NOT_EMPTY":
      return "This account Profile already contains data. Import is disabled to protect it.";
    case "NO_IMPORTABLE_DATA":
      return "No local Agent records or replay files were found.";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function agentStatusTitle(reason: AccountState["agentEntry"]["reason"]): string {
  switch (reason) {
    case "DAEMON_STARTING":
      return "Starting your local Agent";
    case "PROTOCOL_INCOMPATIBLE":
      return "Desktop and local Agent versions differ";
    case "SAFE_SHUTDOWN_PENDING":
      return "The local Agent is finishing a safe shutdown";
    case "DAEMON_UNAVAILABLE":
      return "The local Agent is unavailable";
    case "ACCOUNT_NOT_AUTHORIZED":
    case undefined:
      return "Local Agent unavailable";
  }
}

function agentStatusDescription(reason: AccountState["agentEntry"]["reason"]): string {
  switch (reason) {
    case "DAEMON_STARTING":
      return "Your account Profile is being prepared and checked before workspace access opens.";
    case "PROTOCOL_INCOMPATIBLE":
      return "Workspace access is disabled until Desktop and its managed Daemon pass the compatibility checks.";
    case "SAFE_SHUTDOWN_PENDING":
      return "A local operation is reaching a safe checkpoint. Profile switching remains paused.";
    case "DAEMON_UNAVAILABLE":
      return "The managed local service did not pass startup verification. Retry by signing in again or restarting Desktop.";
    case "ACCOUNT_NOT_AUTHORIZED":
    case undefined:
      return "Sign in or restore a valid offline authorization to open your local workspace.";
  }
}

function DeviceManager(props: {
  state: AccountState;
  devices: readonly SafeDevice[];
  busy: boolean;
  onRevoke(device: SafeDevice): void;
  onRefresh(): void;
}) {
  const online = props.state.status === "AUTHENTICATED_ONLINE";
  return (
    <section className="table-panel">
      <div className="table-heading">
        <div>
          <h3>Signed-in devices</h3>
          <p>Review and revoke devices connected to your account.</p>
        </div>
        <button
          type="button"
          className="secondary-button compact"
          disabled={!online || props.busy}
          onClick={props.onRefresh}
        >
          <RefreshCw size={14} /> Refresh account
        </button>
      </div>
      {!online ? (
        <div className="empty-state">
          <Unplug size={20} />
          <b>Device list is unavailable offline</b>
          <span>Reconnect to Cloud to check device status or revoke access.</span>
        </div>
      ) : props.devices.length === 0 ? (
        <div className="empty-state">
          <LoaderCircle size={20} className="spin" />
          <b>Loading device list</b>
          <span>Caelush is checking the devices on your account.</span>
        </div>
      ) : (
        <div className="device-list">
          {props.devices.map((device) => (
            <div className="device-row" key={device.deviceId}>
              <div className="device-tile">
                <LaptopMinimal size={18} />
              </div>
              <div className="device-row-main">
                <b>
                  {device.label}{" "}
                  {device.current && <span className="current-tag">THIS DEVICE</span>}
                </b>
                <span>
                  Last active{" "}
                  {device.lastSeenAt ? formatDate(device.lastSeenAt) : "Not yet recorded"}
                </span>
              </div>
              <div className="device-row-status">
                <span className={`status-dot ${device.revokedAt ? "is-revoked" : ""}`} />
                {device.revokedAt ? "Revoked" : "Active"}
              </div>
              {!device.revokedAt && (
                <button
                  type="button"
                  className="revoke-button"
                  disabled={props.busy}
                  onClick={() => props.onRevoke(device)}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="table-note">
        <ShieldCheck size={15} /> Revoking a device immediately invalidates its online sessions.
        Offline grants are checked again when that device reconnects.
      </div>
    </section>
  );
}

function SecuritySettings(props: {
  online: boolean;
  busy: boolean;
  currentPassword: string;
  newPassword: string;
  setCurrentPassword(value: string): void;
  setNewPassword(value: string): void;
  onChangePassword(event: FormEvent<HTMLFormElement>): void;
  onRefresh(): void;
}) {
  return (
    <div className="security-stack">
      <section className="table-panel password-panel">
        <div className="table-heading">
          <div>
            <h3>Change password</h3>
            <p>Updating your password ends other active account sessions.</p>
          </div>
          <KeyRound size={18} />
        </div>
        {!props.online && (
          <MessageBox
            message="Connect to Cloud before changing the account password."
            tone="info"
          />
        )}
        <form className="password-change-form" onSubmit={props.onChangePassword}>
          <label className="field-label" htmlFor="current-password">
            Current password
          </label>
          <div className="input-wrap">
            <LockKeyhole size={16} />
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              minLength={1}
              maxLength={1024}
              required
              value={props.currentPassword}
              onChange={(event) => props.setCurrentPassword(event.target.value)}
            />
          </div>
          <label className="field-label" htmlFor="new-password">
            New password
          </label>
          <div className="input-wrap">
            <KeyRound size={16} />
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={1}
              maxLength={1024}
              required
              value={props.newPassword}
              onChange={(event) => props.setNewPassword(event.target.value)}
            />
          </div>
          <button
            className="primary-button compact-primary"
            type="submit"
            disabled={!props.online || props.busy}
          >
            {props.busy ? <LoaderCircle size={15} className="spin" /> : null} Change password{" "}
            <ArrowRight size={15} />
          </button>
        </form>
      </section>
      <section className="security-note">
        <ShieldCheck size={18} />
        <div>
          <b>Credential storage</b>
          <span>
            Refresh credentials, the device signing key, and offline authorization are encrypted
            with the Windows user profile. Access credentials are kept in Main process memory only.
          </span>
        </div>
      </section>
      <button
        type="button"
        className="inline-action"
        disabled={props.busy}
        onClick={props.onRefresh}
      >
        Check account authorization <ChevronRight size={15} />
      </button>
    </div>
  );
}

function EmailField(props: { value: string; onChange(value: string): void }) {
  return (
    <div className="field-group">
      <label className="field-label" htmlFor="account-email">
        Email address
      </label>
      <div className="input-wrap">
        <Mail size={16} />
        <input
          id="account-email"
          type="email"
          autoComplete="email"
          maxLength={320}
          required
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

function PasswordField(props: {
  value: string;
  label: string;
  autoComplete: string;
  visible: boolean;
  onChange(value: string): void;
  onToggle(): void;
}) {
  return (
    <div className="field-group">
      <label className="field-label" htmlFor="account-password">
        {props.label}
      </label>
      <div className="input-wrap">
        <LockKeyhole size={16} />
        <input
          id="account-password"
          type={props.visible ? "text" : "password"}
          autoComplete={props.autoComplete}
          minLength={1}
          maxLength={1024}
          required
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <button
          type="button"
          className="input-action"
          aria-label={props.visible ? "Hide password" : "Show password"}
          onClick={props.onToggle}
        >
          {props.visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

function PrimaryButton(props: { children: ReactNode; busy: boolean }) {
  return (
    <button className="primary-button" type="submit" disabled={props.busy}>
      {props.busy ? <LoaderCircle size={16} className="spin" /> : props.children}
    </button>
  );
}

function BackLink(props: { children: ReactNode; onClick(): void }) {
  return (
    <button className="back-link" type="button" onClick={props.onClick}>
      <ArrowLeft size={14} /> {props.children}
    </button>
  );
}

function MessageBox(props: { message: string; tone: "info" | "error" }) {
  return (
    <div className={`message-box ${props.tone}`} role={props.tone === "error" ? "alert" : "status"}>
      {props.tone === "error" ? <CircleAlert size={16} /> : <BadgeCheck size={16} />}
      <span>{props.message}</span>
    </div>
  );
}

function authTitle(screen: AuthScreen): string {
  switch (screen) {
    case "register":
      return "Create your account";
    case "verify":
      return "Verify your email";
    case "forgot":
      return "Recover your password";
    case "reset":
      return "Set a new password";
    default:
      return "Welcome back";
  }
}

function authDescription(screen: AuthScreen): string {
  switch (screen) {
    case "register":
      return "Create an account to authorize Caelush on this device.";
    case "verify":
      return "Enter the verification token from the email sent to your address.";
    case "forgot":
      return "We’ll send recovery instructions if this email has an account.";
    case "reset":
      return "Use the token in your recovery email to update your password.";
    default:
      return "Sign in to connect your account and authorize this device.";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

function errorMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.slice(0, 512);
  }
  return "The account request could not be completed.";
}
