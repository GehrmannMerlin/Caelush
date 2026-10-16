import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UpdatePage } from "./UpdatePage.js";
import { AccountProfileScreen } from "./components/account-profile-screen.js";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CircleAlert,
  Clock3,
  Cloud,
  Download,
  Eye,
  EyeOff,
  House,
  KeyRound,
  LaptopMinimal,
  LoaderCircle,
  LockKeyhole,
  Mail,
  MonitorCog,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import type { AccountState, DesktopAccountProfile, SafeDevice } from "../main/account/state.js";
import type { AccountProfileUpdateInput } from "../main/cloud/schemas.js";
import type {
  LegacyDataImportSummary,
  LegacyImportProgress,
} from "../shared/legacy-data-contract.js";

type AuthScreen = "login" | "register" | "verify" | "forgot" | "reset";
type AccountScreen = "home" | "profile" | "updates";
type AppScreen = AuthScreen | AccountScreen | "agent-starting";

const brandTitlePrefix = Array.from("让灵感 ");
const brandTitleAccent = Array.from("自由生长。");
const brandTitleCharacterCount = brandTitlePrefix.length + brandTitleAccent.length;
const brandTitleText = [...brandTitlePrefix, ...brandTitleAccent].join("");
const brandCopyCharacters = Array.from("每一段思绪，都可以成为新的开始。");
const brandCopyText = brandCopyCharacters.join("");

const initialState: AccountState = {
  status: "INITIALIZING",
  lastError: null,
  notice: null,
  agentEntry: { available: false, reason: "ACCOUNT_NOT_AUTHORIZED" },
};

export function DesktopApp() {
  const [accountState, setAccountState] = useState<AccountState>(initialState);
  const [screen, setScreen] = useState<AppScreen>("login");
  const accountRouteRequested =
    window.location.protocol === "caelush-login:" &&
    new URLSearchParams(window.location.search).get("view") === "account";
  const agentLaunchRequested =
    window.location.protocol === "caelush-login:" &&
    new URLSearchParams(window.location.search).get("view") === "agent";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [token, setToken] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agentRetrying, setAgentRetrying] = useState(false);
  const [manualReconnect, setManualReconnect] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const agentNavigationStarted = useRef(false);
  const agentLaunchRetryStarted = useRef(false);
  const [devices, setDevices] = useState<readonly SafeDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [profile, setProfile] = useState<DesktopAccountProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const [legacySummary, setLegacySummary] = useState<LegacyDataImportSummary | null>(null);
  const [legacyLoading, setLegacyLoading] = useState(false);
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
  const reconnectingOffline =
    accountState.status === "AUTHORIZED_OFFLINE" && authScreenOpen && manualReconnect;
  const shouldStartAgent =
    authenticated &&
    !accountRouteRequested &&
    !reconnectingOffline &&
    (authScreenOpen || screen === "agent-starting");
  const activeView: AccountScreen = screen === "profile" || screen === "updates" ? screen : "home";
  const retryAgentStartup = useCallback(async () => {
    setAgentRetrying(true);
    setFeedback(null);
    try {
      setAccountState(await window.caelushDesktop.account.retryAgentStartup());
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setAgentRetrying(false);
    }
  }, []);

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
      .catch(() => {
        if (active) {
          setAccountState((current) =>
            current.status === "INITIALIZING"
              ? {
                  ...current,
                  status: "ERROR",
                  lastError: {
                    code: "ACCOUNT_STATE_UNAVAILABLE",
                    message: "暂时无法读取账户状态，请重新打开页面。",
                  },
                }
              : current,
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authenticated || activeView !== "profile") {
      if (!authenticated) setProfile(null);
      return;
    }
    let active = true;
    setProfileLoading(true);
    setProfileLoadError(null);
    void window.caelushDesktop.account
      .getProfile()
      .then((value) => {
        if (active) setProfile(value);
      })
      .catch((error) => {
        if (active) setProfileLoadError(errorMessage(error));
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeView, authenticated, accountState.account?.userId]);

  useEffect(() => {
    if (!authenticated) {
      agentNavigationStarted.current = false;
      setScreen((current) =>
        current === "profile" || current === "updates" || current === "agent-starting"
          ? "login"
          : current,
      );
      return;
    }
    if (shouldStartAgent && screen !== "agent-starting") setScreen("agent-starting");
    if (!shouldStartAgent) agentNavigationStarted.current = false;
  }, [authenticated, shouldStartAgent, screen]);

  useEffect(() => {
    if (!shouldStartAgent || !accountState.agentEntry.available || agentNavigationStarted.current)
      return;
    agentNavigationStarted.current = true;
    window.location.assign("caelush-app://app/agent/");
  }, [accountState.agentEntry.available, shouldStartAgent]);

  useEffect(() => {
    if (
      !agentLaunchRequested ||
      !authenticated ||
      accountState.agentEntry.available ||
      accountState.agentEntry.reason === undefined ||
      accountState.agentEntry.reason === "DAEMON_STARTING" ||
      agentRetrying ||
      agentLaunchRetryStarted.current
    ) {
      return;
    }
    agentLaunchRetryStarted.current = true;
    void retryAgentStartup();
  }, [
    accountState.agentEntry.available,
    accountState.agentEntry.reason,
    agentLaunchRequested,
    agentRetrying,
    retryAgentStartup,
    authenticated,
  ]);

  useEffect(() => {
    if (!online) {
      setDevicesLoading(false);
      setDevices([]);
      return;
    }
    let active = true;
    setDevicesLoading(true);
    void window.caelushDesktop.account
      .listDevices()
      .then((result) => {
        if (active) setDevices(result);
      })
      .catch((error: unknown) => {
        if (active) setFeedback(errorMessage(error));
      })
      .finally(() => {
        if (active) setDevicesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [online]);

  useEffect(() => {
    if (!authenticated || accountState.account?.userId === undefined) {
      setLegacySummary(null);
      setLegacyProgress(null);
      setLegacyMessage(null);
      setLegacyLoading(false);
      return;
    }
    let active = true;
    setLegacySummary(null);
    setLegacyDismissed(false);
    setLegacyLoading(true);
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
      })
      .finally(() => {
        if (active) setLegacyLoading(false);
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
      setManualReconnect(false);
      setScreen("agent-starting");
    });
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.register({ email, password });
      setPassword("");
      setFeedback("如果该邮箱可以注册，我们已发送验证邮件。");
      setScreen("verify");
    });
  }

  async function verifyEmail(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.verifyEmail({ verificationToken: token });
      setToken("");
      setPassword("");
      setFeedback("邮箱验证成功。请登录以连接此设备。");
      setScreen("login");
    });
  }

  async function resendVerification(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.resendVerification({ email });
      setFeedback("如果该邮箱需要验证，我们已重新发送验证邮件。");
    });
  }

  async function forgotPassword(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.forgotPassword({ email });
      setFeedback("如果该邮箱已注册，我们已发送密码重置说明。");
      setScreen("reset");
    });
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.resetPassword({ resetToken: token, newPassword });
      setToken("");
      setNewPassword("");
      setFeedback("密码已重置。现在可以使用新密码登录。");
      setScreen("login");
    });
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await window.caelushDesktop.account.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setFeedback("密码已修改，请使用新密码重新登录。");
      setScreen("login");
    });
  }

  async function revokeDevice(device: SafeDevice) {
    const label = device.current ? "此设备" : formatDeviceLabel(device.label);
    if (!window.confirm(`确定撤销“${label}”的访问权限吗？该设备需要重新登录。`)) return;
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
        message: "本地数据导入完成。受保护的备份已验证，原始数据仍保留在原位置。",
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
        message: "受保护的数据恢复已完成。目标账户数据已验证，原始数据仍保留在原位置。",
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
    accountRouteRequested && accountState.status === "INITIALIZING" ? (
      <AccountLoadingScreen view={activeView} />
    ) : shouldStartAgent ? (
      <AgentStartupScreen
        state={accountState}
        retrying={agentRetrying}
        message={feedback}
        onRetry={() => void retryAgentStartup()}
      />
    ) : authenticated && !reconnectingOffline ? (
      <AccountHome
        accountState={accountState}
        activeView={activeView}
        devices={devices}
        devicesLoading={devicesLoading}
        busy={busy}
        feedback={apiError}
        onNavigate={(nextView) => {
          setScreen(nextView);
        }}
        onRevoke={(device) => void revokeDevice(device)}
        onReconnect={() => {
          setEmail(accountState.account?.email ?? "");
          setManualReconnect(true);
          setFeedback(null);
          setScreen("login");
        }}
        onChangePassword={(event) => void changePassword(event)}
        legacySummary={legacySummary}
        legacyLoading={legacyLoading}
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
        profile={profile}
        profileLoading={profileLoading}
        profileLoadError={profileLoadError}
        onSelectAvatar={() => window.caelushDesktop.account.selectAvatar()}
        onSaveProfile={async (input) => {
          const updated = await window.caelushDesktop.account.updateProfile(input);
          setProfile(updated);
          return updated;
        }}
      />
    ) : (
      <AuthShell
        screen={screen === "agent-starting" ? "login" : (screen as AuthScreen)}
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

  return <div className="desktop-app">{authenticatedScreen}</div>;
}

function AgentStartupScreen(props: {
  state: AccountState;
  retrying: boolean;
  message: string | null;
  onRetry(): void;
}) {
  const reason = props.state.agentEntry.reason;
  const isStarting =
    props.state.agentEntry.available || reason === undefined || reason === "DAEMON_STARTING";
  const status = agentStartupStatus(reason);

  return (
    <main className="agent-startup-page" aria-busy={isStarting || props.retrying}>
      <section className="agent-startup-content" aria-live="polite" aria-atomic="true">
        <img className="agent-startup-logo" src="/caelush-logo.png" alt="Caelush" />
        {isStarting && !props.message ? (
          <LoaderCircle className="agent-startup-indicator spin" aria-hidden="true" />
        ) : (
          <CircleAlert className="agent-startup-indicator is-error" aria-hidden="true" />
        )}
        <p className="agent-startup-status">
          {props.message ? "本地 Agent 启动遇到问题" : status.title}
        </p>
        <p className="agent-startup-description">{props.message ?? status.description}</p>
        {(!isStarting || props.message) && (
          <button
            type="button"
            className="agent-startup-retry"
            onClick={props.onRetry}
            disabled={props.retrying}
          >
            {props.retrying ? (
              <LoaderCircle className="spin" size={15} aria-hidden="true" />
            ) : (
              <RefreshCw size={15} aria-hidden="true" />
            )}
            {props.retrying ? "正在重试" : "重试启动"}
          </button>
        )}
      </section>
    </main>
  );
}

function agentStartupStatus(reason: AccountState["agentEntry"]["reason"]): {
  title: string;
  description: string;
} {
  switch (reason) {
    case "DAEMON_UNAVAILABLE":
      return {
        title: "本地 Agent 暂时无法启动",
        description: "请重试启动本地 Agent。",
      };
    case "PROTOCOL_INCOMPATIBLE":
      return {
        title: "本地 Agent 版本不兼容",
        description: "请更新桌面端后再试。",
      };
    case "SAFE_SHUTDOWN_PENDING":
      return {
        title: "正在等待上一会话安全退出",
        description: "完成后会自动进入工作台。",
      };
    case "ACCOUNT_NOT_AUTHORIZED":
      return {
        title: "本地 Agent 尚未获得此账户授权",
        description: "请重试启动本地 Agent。",
      };
    case "DAEMON_STARTING":
    case undefined:
    default:
      return {
        title: "正在准备本地 Agent",
        description: "准备完成后会自动进入工作台。",
      };
  }
}

function BrandIntroduction() {
  const [reducedMotion] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const [visibleCharacters, setVisibleCharacters] = useState(
    reducedMotion ? brandTitleCharacterCount : 0,
  );
  const [copyRevealed, setCopyRevealed] = useState(reducedMotion);

  useEffect(() => {
    if (reducedMotion) return;

    let visibleCount = 0;
    let timeoutId = 0;
    const typeNextCharacter = () => {
      visibleCount += 1;
      setVisibleCharacters(visibleCount);

      if (visibleCount === brandTitleCharacterCount) {
        timeoutId = window.setTimeout(() => setCopyRevealed(true), 160);
        return;
      }

      timeoutId = window.setTimeout(typeNextCharacter, 92);
    };

    timeoutId = window.setTimeout(typeNextCharacter, 180);
    return () => window.clearTimeout(timeoutId);
  }, [reducedMotion]);

  const visiblePrefix = brandTitlePrefix.slice(0, visibleCharacters).join("");
  const visibleAccentCount = Math.max(0, visibleCharacters - brandTitlePrefix.length);
  const titleComplete = visibleCharacters === brandTitleCharacterCount;

  return (
    <div className="brand-panel-content">
      <h1 aria-label={brandTitleText}>
        <span className="brand-title-visual" aria-hidden="true">
          <span>{visiblePrefix}</span>
          <em>{brandTitleAccent.slice(0, visibleAccentCount).join("")}</em>
          <span className={`brand-typing-caret${titleComplete ? " is-complete" : ""}`} />
        </span>
      </h1>
      <p className={`brand-copy${copyRevealed ? " is-revealed" : ""}`} aria-label={brandCopyText}>
        {brandCopyCharacters.map((character, index) => (
          <span key={index} aria-hidden="true" style={{ animationDelay: `${index * 38}ms` }}>
            {character}
          </span>
        ))}
      </p>
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
      <div className="brand-emblem">
        <img src="/caelush-logo.png" alt="Caelush" />
      </div>
      <div className="auth-content">
        <section className="brand-panel">
          <BrandIntroduction />
        </section>

        <section className="auth-panel">
          <div className="auth-panel-inner">
            {props.status === "LOCKED" ? (
              <div className="locked-state">
                <div className="form-symbol is-warning">
                  <LockKeyhole size={20} />
                </div>
                <p className="eyebrow">安全存储不可用</p>
                <h2>登录功能已锁定</h2>
                <p className="auth-description">
                  无法打开 Windows 受保护的凭据存储。为保护账户安全，Caelush
                  不会在此状态下保存凭据。
                </p>
                <MessageBox
                  message={
                    props.message ?? "请检查当前 Windows 用户配置，然后重新启动 Caelush 桌面端。"
                  }
                  tone="error"
                />
              </div>
            ) : (
              <>
                <div className="auth-heading">
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
                      label="密码"
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
                        忘记密码？
                      </button>
                    </div>
                    <PrimaryButton busy={props.busy}>
                      登录 <ArrowRight size={16} />
                    </PrimaryButton>
                    <div className="auth-switch">
                      还没有 Caelush 账户？{" "}
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => props.setScreen("register")}
                      >
                        创建账户
                      </button>
                    </div>
                  </form>
                )}
                {props.screen === "register" && (
                  <form className="auth-form" onSubmit={props.onRegister}>
                    <EmailField value={props.email} onChange={props.setEmail} />
                    <PasswordField
                      value={props.password}
                      label="设置密码"
                      autoComplete="new-password"
                      visible={props.showPassword}
                      onChange={props.setPassword}
                      onToggle={() => props.setShowPassword(!props.showPassword)}
                    />
                    <p className="field-hint">需要先验证邮箱，才能登录此账户。</p>
                    <PrimaryButton busy={props.busy}>
                      创建账户 <ArrowRight size={16} />
                    </PrimaryButton>
                    <div className="auth-switch">
                      已有账户？{" "}
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => props.setScreen("login")}
                      >
                        登录
                      </button>
                    </div>
                  </form>
                )}
                {props.screen === "verify" && (
                  <div className="auth-form">
                    <form onSubmit={props.onVerify}>
                      <label className="field-label" htmlFor="verification-token">
                        邮箱验证码
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
                        验证邮箱 <ArrowRight size={16} />
                      </PrimaryButton>
                    </form>
                    <form className="secondary-form" onSubmit={props.onResend}>
                      <p className="field-hint">
                        没有收到邮件？如果该邮箱需要验证，我们可以重新发送。
                      </p>
                      <EmailField value={props.email} onChange={props.setEmail} />
                      <button className="secondary-button" disabled={props.busy} type="submit">
                        重新发送验证邮件
                      </button>
                    </form>
                    <BackLink onClick={() => props.setScreen("login")}>返回登录</BackLink>
                  </div>
                )}
                {props.screen === "forgot" && (
                  <form className="auth-form" onSubmit={props.onForgot}>
                    <EmailField value={props.email} onChange={props.setEmail} />
                    <PrimaryButton busy={props.busy}>
                      发送密码重置邮件 <ArrowRight size={16} />
                    </PrimaryButton>
                    <BackLink onClick={() => props.setScreen("login")}>返回登录</BackLink>
                  </form>
                )}
                {props.screen === "reset" && (
                  <form className="auth-form" onSubmit={props.onReset}>
                    <label className="field-label" htmlFor="reset-token">
                      密码重置码
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
                      label="新密码"
                      autoComplete="new-password"
                      visible={props.showPassword}
                      onChange={props.setNewPassword}
                      onToggle={() => props.setShowPassword(!props.showPassword)}
                    />
                    <PrimaryButton busy={props.busy}>
                      重置密码 <ArrowRight size={16} />
                    </PrimaryButton>
                    <BackLink onClick={() => props.setScreen("login")}>返回登录</BackLink>
                  </form>
                )}
              </>
            )}
          </div>
          <div className="auth-panel-bottom">
            <span>已在此 Windows 用户配置中加密</span>
            <span>CAELUSH · 桌面端</span>
          </div>
        </section>
      </div>
    </main>
  );
}

function AccountLoadingScreen(props: { view: AccountScreen }) {
  const navigation = ["home", "profile", "updates"] as const;
  return (
    <main
      className="account-layout account-layout--loading"
      aria-busy="true"
      aria-label="正在加载账户页面"
    >
      <aside className="account-sidebar" aria-hidden="true">
        <div className="sidebar-section-label">账户</div>
        {navigation.map((view) => (
          <div className={`side-nav ${props.view === view ? "is-current" : ""}`} key={view}>
            <span className="account-skeleton-icon skeleton-block" />
            <span className="skeleton-block account-skeleton-nav-label" />
          </div>
        ))}
        <div className="sidebar-separator" />
        <div className="icon-button sidebar-home-button">
          <span className="skeleton-block account-skeleton-home-icon" />
        </div>
      </aside>
      <section className="account-content">
        <div
          className={`account-content-inner${props.view === "profile" ? " is-profile-view" : ""}`}
        >
          <div className="account-page-head">
            <span className="skeleton-block account-skeleton-title" />
          </div>
          <AccountPageSkeleton view={props.view} />
        </div>
      </section>
      <span className="visually-hidden" role="status">
        正在加载账户页面
      </span>
    </main>
  );
}

function AccountPageSkeleton(props: { view: AccountScreen }) {
  if (props.view === "profile") {
    return (
      <div className="account-profile-stack" aria-hidden="true">
        <section className="profile-card">
          <div className="profile-edit-form">
            <div className="profile-avatar-row">
              <span className="skeleton-block account-skeleton-profile-avatar" />
            </div>
            <span className="skeleton-block account-skeleton-profile-name" />
            <span className="skeleton-block account-skeleton-profile-email" />
          </div>
        </section>
        <section className="password-panel">
          <div className="table-heading">
            <div>
              <span className="skeleton-block account-skeleton-section-title" />
              <span className="skeleton-block account-skeleton-copy" />
            </div>
          </div>
          <div className="account-skeleton-form">
            {[0, 1].map((item) => (
              <div className="account-skeleton-field" key={item}>
                <span className="skeleton-block account-skeleton-label" />
                <span className="skeleton-block account-skeleton-input" />
              </div>
            ))}
            <span className="skeleton-block account-skeleton-submit" />
          </div>
        </section>
      </div>
    );
  }

  if (props.view === "updates") {
    return (
      <div className="update-page" aria-hidden="true">
        <section className="update-status-card account-skeleton-panel">
          <div className="account-skeleton-update-heading">
            <span className="skeleton-block account-skeleton-icon-large" />
            <div>
              <span className="skeleton-block account-skeleton-section-title" />
              <span className="skeleton-block account-skeleton-copy" />
            </div>
          </div>
          <div className="account-skeleton-update-toolbar">
            <span className="skeleton-block account-skeleton-button" />
            <span className="skeleton-block account-skeleton-button" />
          </div>
          <span className="skeleton-block account-skeleton-message" />
        </section>
        <span className="skeleton-block account-skeleton-note" />
      </div>
    );
  }

  return (
    <div className="account-skeleton-overview" aria-hidden="true">
      <span className="skeleton-block account-skeleton-connection" />
      <section className="detail-panel account-skeleton-panel">
        <div className="account-skeleton-panel-heading">
          <span className="skeleton-block account-skeleton-section-title" />
          <span className="skeleton-block account-skeleton-icon-large" />
        </div>
        <div className="account-skeleton-device-line">
          <span className="skeleton-block account-skeleton-device-icon" />
          <span className="skeleton-block account-skeleton-value" />
        </div>
        <span className="skeleton-block account-skeleton-detail-line" />
        <DeviceRowsSkeleton />
      </section>
      <section className="legacy-import-panel account-skeleton-panel">
        <div className="account-skeleton-panel-heading">
          <span className="skeleton-block account-skeleton-icon-large" />
          <div>
            <span className="skeleton-block account-skeleton-section-title" />
          </div>
        </div>
        <span className="skeleton-block account-skeleton-copy" />
        <div className="account-skeleton-count-grid">
          {Array.from({ length: 10 }, (_, index) => (
            <span className="skeleton-block account-skeleton-count" key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}

function DeviceRowsSkeleton() {
  return (
    <div className="device-list account-skeleton-device-list" aria-hidden="true">
      {[0, 1].map((row) => (
        <div className="device-row account-skeleton-device-row" key={row}>
          <span className="skeleton-block account-skeleton-device-icon" />
          <div className="account-skeleton-device-copy">
            <span className="skeleton-block account-skeleton-value" />
            <span className="skeleton-block account-skeleton-copy" />
          </div>
          <span className="skeleton-block account-skeleton-device-status" />
          <span className="skeleton-block account-skeleton-button-small" />
        </div>
      ))}
    </div>
  );
}

function AccountHome(props: {
  accountState: AccountState;
  activeView: AccountScreen;
  devices: readonly SafeDevice[];
  devicesLoading: boolean;
  busy: boolean;
  feedback: string | null;
  onNavigate(screen: AccountScreen): void;
  onReconnect(): void;
  onRevoke(device: SafeDevice): void;
  onChangePassword(event: FormEvent<HTMLFormElement>): void;
  legacySummary: LegacyDataImportSummary | null;
  legacyLoading: boolean;
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
  profile: DesktopAccountProfile | null;
  profileLoading: boolean;
  profileLoadError: string | null;
  onSelectAvatar(): Promise<{
    readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
    readonly bytes: Uint8Array;
  } | null>;
  onSaveProfile(input: AccountProfileUpdateInput): Promise<DesktopAccountProfile>;
}) {
  const { accountState } = props;
  const offline = accountState.status === "AUTHORIZED_OFFLINE";
  return (
    <main className="account-layout">
      <aside className="account-sidebar">
        <div className="sidebar-section-label">账户</div>
        <button
          className={`side-nav ${props.activeView === "home" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("home")}
        >
          <MonitorCog size={16} /> 总览
        </button>
        <button
          className={`side-nav ${props.activeView === "profile" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("profile")}
        >
          <BadgeCheck size={16} /> 个人信息
        </button>
        <button
          className={`side-nav ${props.activeView === "updates" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("updates")}
        >
          <Download size={16} /> 检查更新
        </button>
        <div className="sidebar-separator" />
        <button
          type="button"
          className="icon-button sidebar-home-button"
          aria-label="返回工作台"
          title="返回工作台"
          onClick={() => window.location.assign("caelush-login://app/?view=agent")}
        >
          <House size={18} aria-hidden="true" />
        </button>
      </aside>

      <section className="account-content">
        <div
          className={`account-content-inner${props.activeView === "profile" ? " is-profile-view" : ""}`}
        >
          <div className="account-page-head">
            <h2>
              {props.activeView === "home"
                ? "总览"
                : props.activeView === "profile"
                  ? "个人信息"
                  : "检查更新"}
            </h2>
          </div>
          {props.feedback && <MessageBox message={props.feedback} tone="info" />}
          {props.activeView === "home" && (
            <Overview
              state={accountState}
              devices={props.devices}
              devicesLoading={props.devicesLoading}
              onReconnect={props.onReconnect}
              onRevoke={props.onRevoke}
              busy={props.busy}
              legacySummary={props.legacySummary}
              legacyLoading={props.legacyLoading}
              legacyDismissed={props.legacyDismissed}
              legacyBusy={props.legacyBusy}
              legacyProgress={props.legacyProgress}
              legacyMessage={props.legacyMessage}
              onDismissLegacy={props.onDismissLegacy}
              onImportLegacy={props.onImportLegacy}
              onResumeLegacy={props.onResumeLegacy}
            />
          )}
          {props.activeView === "profile" && (
            <AccountProfileScreen
              profile={props.profile}
              loading={props.profileLoading}
              loadError={props.profileLoadError}
              online={!offline}
              busy={props.busy}
              onSelectAvatar={props.onSelectAvatar}
              onSave={props.onSaveProfile}
              currentPassword={props.currentPassword}
              newPassword={props.newPassword}
              setCurrentPassword={props.setCurrentPassword}
              setNewPassword={props.setNewPassword}
              onChangePassword={props.onChangePassword}
            />
          )}
          {props.activeView === "updates" && <UpdatePage />}
        </div>
      </section>
    </main>
  );
}

function Overview(props: {
  state: AccountState;
  devices: readonly SafeDevice[];
  devicesLoading: boolean;
  onReconnect(): void;
  onRevoke(device: SafeDevice): void;
  busy: boolean;
  legacySummary: LegacyDataImportSummary | null;
  legacyLoading: boolean;
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
  const currentDevice = props.devices.find((device) => device.current) ?? state.device;
  const currentDeviceCanBeRevoked =
    currentDevice !== undefined &&
    props.devices.some((device) => device.deviceId === currentDevice.deviceId && !device.revokedAt);
  const otherDevices = props.devices.filter((device) => !device.current);
  return (
    <>
      <section className={`connection-banner ${offline ? "is-offline" : ""}`}>
        <div className="banner-icon">{offline ? <Unplug size={19} /> : <Cloud size={19} />}</div>
        <div className="banner-copy">
          <b>{offline ? "离线授权已启用" : "账户已连接"}</b>
          <span>
            {offline
              ? "此设备可在签名授权到期前继续离线使用。"
              : "你的账户已通过此 Windows 设备连接到 Caelush 云端。"}
          </span>
        </div>
        {offline ? (
          <button
            className="secondary-button compact"
            type="button"
            disabled={props.busy}
            onClick={props.onReconnect}
          >
            登录并重新连接 <ArrowRight size={14} />
          </button>
        ) : null}
      </section>
      {offline && grant && (
        <section className="grant-panel">
          <div className="grant-head">
            <div className="grant-icon">
              <Clock3 size={17} />
            </div>
            <div>
              <span>离线授权</span>
              <b>
                {grant.remainingHours < 24
                  ? `还剩 ${grant.remainingHours} 小时`
                  : `还剩 ${Math.ceil(grant.remainingHours / 24)} 天`}
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
            <span>签发时间：{formatDate(grant.issuedAt)}</span>
            <span>到期时间：{formatDate(grant.expiresAt)}</span>
          </div>
        </section>
      )}
      <div className="overview-grid">
        <section className="detail-panel device-summary">
          <div className="panel-heading">
            <h3>Windows 桌面端</h3>
            <LaptopMinimal size={18} />
          </div>
          <div className="device-name">
            <div className="device-tile">
              <LaptopMinimal size={19} />
            </div>
            <div>
              <b>{formatDeviceLabel(currentDevice?.label ?? "Caelush Desktop")}</b>
              <span>{currentDevice ? "当前设备" : "设备尚未验证"}</span>
            </div>
          </div>
          <div className="detail-row">
            <span>设备 ID</span>
            <b className="mono-value">{currentDevice?.deviceId ?? "—"}</b>
          </div>
          {currentDeviceCanBeRevoked && currentDevice && (
            <button
              type="button"
              className="revoke-button device-current-revoke"
              disabled={offline || props.busy}
              onClick={() => props.onRevoke(currentDevice)}
            >
              撤销此设备
            </button>
          )}
          <div className="device-list-heading">其他已登录设备</div>
          {offline ? (
            <p className="device-list-message">连接云端后可管理其他登录设备。</p>
          ) : props.devicesLoading ? (
            <DeviceRowsSkeleton />
          ) : otherDevices.length === 0 ? (
            <p className="device-list-message">暂无其他已登录设备。</p>
          ) : (
            <div className="device-list">
              {otherDevices.map((device) => (
                <div className="device-row" key={device.deviceId}>
                  <div className="device-tile">
                    <LaptopMinimal size={18} />
                  </div>
                  <div className="device-row-main">
                    <b>{formatDeviceLabel(device.label)}</b>
                    <span>
                      最近活动：{device.lastSeenAt ? formatDate(device.lastSeenAt) : "暂无记录"}
                    </span>
                  </div>
                  <div className="device-row-status">
                    <span className={`status-dot ${device.revokedAt ? "is-revoked" : ""}`} />
                    {device.revokedAt ? "已撤销" : "使用中"}
                  </div>
                  {!device.revokedAt && (
                    <button
                      type="button"
                      className="revoke-button"
                      disabled={props.busy}
                      onClick={() => props.onRevoke(device)}
                    >
                      撤销
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="table-note">
            <ShieldCheck size={15} />
            <span>
              撤销设备后，其在线会话会立即失效。设备重新连接时，系统也会重新检查离线授权。
            </span>
          </div>
        </section>
      </div>
      <LegacyImportPanel
        summary={props.legacySummary}
        loading={
          props.legacyLoading || (props.legacySummary === null && props.legacyMessage === null)
        }
        dismissed={props.legacyDismissed}
        busy={props.legacyBusy}
        progress={props.legacyProgress}
        message={props.legacyMessage}
        onDismiss={props.onDismissLegacy}
        onImport={props.onImportLegacy}
        onResume={props.onResumeLegacy}
      />
    </>
  );
}

function LegacyImportPanel(props: {
  summary: LegacyDataImportSummary | null;
  loading: boolean;
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
  if (summary === null && props.loading) {
    return (
      <section
        className="legacy-import-panel account-skeleton-panel account-skeleton-legacy"
        aria-hidden="true"
      >
        <div className="account-skeleton-panel-heading">
          <span className="skeleton-block account-skeleton-icon-large" />
          <div>
            <span className="skeleton-block account-skeleton-section-title" />
          </div>
        </div>
        <span className="skeleton-block account-skeleton-copy" />
        <span className="skeleton-block account-skeleton-copy account-skeleton-copy-short" />
        <div className="account-skeleton-detail-line" />
        <div className="account-skeleton-count-grid">
          {Array.from({ length: 10 }, (_, index) => (
            <span className="skeleton-block account-skeleton-count" key={index} />
          ))}
        </div>
      </section>
    );
  }
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
          <h3>{summary.pendingRecovery ? "需要恢复本地数据导入" : "发现旧版 Caelush 数据"}</h3>
        </div>
      </div>
      {summary.pendingRecovery ? (
        <p className="legacy-import-copy">
          上次的数据导入尚未完成。请先通过受保护的恢复流程，并确认本地 Agent
          已启动。原始数据会保留。
        </p>
      ) : (
        <p className="legacy-import-copy">
          此 Windows 用户配置中发现旧版 Caelush 数据。请先检查数据内容，再决定是否导入到此账户。
        </p>
      )}
      {summary.sources.map((source) => (
        <div className="legacy-source" key={source.candidateId}>
          <div className="legacy-source-title">
            <b>{formatImportSourceLabel(source.sourceLabel)}</b>
            <span>{formatBytes(source.estimatedBytes)}</span>
          </div>
          <div className="legacy-count-grid">
            <LegacyCount label="工作区" value={source.workspaces} />
            <LegacyCount label="会话" value={source.sessions} />
            <LegacyCount label="运行记录" value={source.runs} />
            <LegacyCount label="消息" value={source.messages} />
            <LegacyCount label="持久化事件" value={source.durableEvents} />
            <LegacyCount label="上下文检查点" value={source.contextCheckpoints} />
            <LegacyCount label="工具记录" value={source.toolExecutions} />
            <LegacyCount label="模型服务凭据" value={source.providerCredentials} />
            <LegacyCount label="模型选择" value={source.modelSelections} />
            <LegacyCount label="私密回放文件" value={source.privateReplayFiles} />
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
                查看导入内容 <ArrowRight size={14} />
              </button>
              <button
                type="button"
                className="text-button"
                disabled={props.busy}
                onClick={props.onDismiss}
              >
                暂不导入
              </button>
            </div>
          )}
          {showReview && candidate?.candidateId === source.candidateId && (
            <div className="legacy-confirmation">
              <b>将数据导入此账户的本地配置中？</b>
              <p>
                数据会保留在这台电脑上，不会上传到云端。Caelush
                会先创建并验证受保护的备份。原始文件夹会保留，其他云端账户也不会自动共享这些数据。
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
                  导入到此账户
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
                  暂不导入
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
              ? "目标数据已通过检查；需要确认本地 Agent 成功启动"
              : summary.recoveryState === "RECOVERY_BLOCKED"
                ? "恢复流程已暂停，等待安全重试"
                : "已备妥并验证数据导入备份"}
          </b>
          <p>
            继续操作会核对备份与此账户的数据，完成凭据保护，并在启动本地 Agent 前再次验证目标数据。
          </p>
          <button
            type="button"
            className="primary-button compact-primary"
            disabled={props.busy}
            onClick={props.onResume}
          >
            {props.busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            继续安全恢复
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
      return "受保护的备份已验证";
    case "IMPORT_STAGED":
      return "导入内容已准备就绪";
    case "DESTINATION_VERIFIED":
      return "账户数据已恢复并检查";
    case "CREDENTIALS_SECURED":
      return "模型服务凭据已安全保存";
    case "COMMITTED":
      return "导入完成";
    case "RECOVERY_REQUIRED":
      return "需要进行受保护的数据恢复";
  }
}

function legacyBlockReason(
  reason: NonNullable<LegacyDataImportSummary["sources"][number]["reason"]>,
): string {
  switch (reason) {
    case "SOURCE_UNREADABLE":
      return "无法安全读取此数据来源。";
    case "UNSUPPORTED_SCHEMA":
      return "安全导入程序不支持此数据格式。";
    case "TARGET_NOT_EMPTY":
      return "此账户的数据空间已有内容。为保护现有数据，已禁用导入。";
    case "NO_IMPORTABLE_DATA":
      return "未找到本地 Agent 记录或回放文件。";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function EmailField(props: { value: string; onChange(value: string): void }) {
  return (
    <div className="field-group">
      <label className="field-label" htmlFor="account-email">
        邮箱地址
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
          aria-label={props.visible ? "隐藏密码" : "显示密码"}
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
      <span>{localizeUiMessage(props.message)}</span>
    </div>
  );
}

function authTitle(screen: AuthScreen): string {
  switch (screen) {
    case "register":
      return "创建账户";
    case "verify":
      return "验证邮箱";
    case "forgot":
      return "找回密码";
    case "reset":
      return "设置新密码";
    default:
      return "欢迎回来";
  }
}

function authDescription(screen: AuthScreen): string {
  switch (screen) {
    case "register":
      return "创建账户，以授权 Caelush 在此设备上运行。";
    case "verify":
      return "请输入发送到此邮箱的验证码。";
    case "forgot":
      return "如果此邮箱已注册，我们会发送密码重置说明。";
    case "reset":
      return "请输入密码重置邮件中的验证码，以设置新密码。";
    default:
      return "登录以连接账户并授权此设备。";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDeviceLabel(label: string): string {
  if (label === "Caelush Desktop") return "Caelush 桌面端";
  if (label === "Windows desktop") return "Windows 桌面端";
  return label;
}

function formatImportSourceLabel(label: string): string {
  if (label === "Default Caelush data") return "Caelush 默认数据目录";
  if (label === "Custom CAELUSH_HOME") return "自定义 CAELUSH_HOME 目录";
  return label;
}

function localizeUiMessage(message: string): string {
  if (/[\u3400-\u9fff]/u.test(message)) return message;
  const normalized = message.toLowerCase();
  if (normalized.includes("vault") || normalized.includes("credential storage")) {
    return "无法访问 Windows 安全存储。请检查当前用户配置后重新启动 Caelush。";
  }
  if (normalized.includes("expired") && normalized.includes("session")) {
    return "云端会话已过期，请重新连接账户后继续。";
  }
  if (normalized.includes("expired") && normalized.includes("offline")) {
    return "离线授权已过期，请连接云端后继续。";
  }
  if (
    normalized.includes("password") &&
    (normalized.includes("invalid") || normalized.includes("incorrect"))
  ) {
    return "密码不正确，请检查后重试。";
  }
  if (normalized.includes("verification") || normalized.includes("verify")) {
    return "邮箱验证未完成或验证码无效，请检查邮件后重试。";
  }
  if (normalized.includes("email")) return "邮箱地址无效或账户请求未能完成，请检查后重试。";
  if (
    normalized.includes("network") ||
    normalized.includes("fetch") ||
    normalized.includes("timeout")
  ) {
    return "网络连接暂不可用，请检查网络后重试。";
  }
  if (normalized.includes("device")) return "设备授权请求未能完成，请重新连接账户后重试。";
  if (normalized.includes("request") || normalized.includes("account")) {
    return "账户请求未能完成，请检查信息或稍后重试。";
  }
  return "请求未能完成，请检查信息或网络连接后重试。";
}

function errorMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return localizeUiMessage(error.message.slice(0, 512));
  }
  return "账户请求未能完成，请稍后重试。";
}
