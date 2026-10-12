import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { UpdatePage } from "./UpdatePage.js";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cloud,
  Download,
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
} from "lucide-react";
import type { AccountState, SafeDevice } from "../main/account/state.js";
import type {
  LegacyDataImportSummary,
  LegacyImportProgress,
} from "../shared/legacy-data-contract.js";

type AuthScreen = "login" | "register" | "verify" | "forgot" | "reset";
type AccountScreen = "home" | "devices" | "security" | "updates";

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
    return screen === "devices" || screen === "security" || screen === "updates" ? screen : "home";
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
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setScreen((current) =>
        current === "devices" || current === "security" || current === "updates"
          ? "login"
          : current,
      );
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

  async function signOut() {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await window.caelushDesktop.account.logout();
      setScreen("login");
      setFeedback(
        result.serverRevoked
          ? "已退出登录，并撤销云端会话。"
          : "本地凭据已清除，但未能确认云端会话是否已撤销。",
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

  return <div className="desktop-app">{authenticatedScreen}</div>;
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
          <p className="eyebrow">本地优先 · 账户已就绪</p>
          <h1>
            你的工作
            <br />
            <em>由你掌控。</em>
          </h1>
          <p className="brand-copy">
            登录 Caelush 账户以授权此设备。本地工作区仍保留在这台电脑上。
          </p>
          <div className="brand-rail">
            <div className="rail-item is-active">
              <span>
                <LockKeyhole size={15} />
              </span>
              <div>
                <b>隐私优先</b>
                <small>凭据保存在 Windows 安全存储中</small>
              </div>
              <Check size={15} />
            </div>
            <div className="rail-item">
              <span>
                <Clock3 size={15} />
              </span>
              <div>
                <b>离线可用</b>
                <small>使用签名授权，最长可离线使用 15 天</small>
              </div>
            </div>
          </div>
        </div>
        <div className="brand-panel-foot">
          <span>01</span>
          <i />
          <span>账户访问</span>
        </div>
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
                无法打开 Windows 受保护的凭据存储。为保护账户安全，Caelush 不会在此状态下保存凭据。
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
                <div className="form-symbol">
                  {props.screen === "verify" ? (
                    <Mail size={19} />
                  ) : props.screen === "forgot" || props.screen === "reset" ? (
                    <KeyRound size={19} />
                  ) : (
                    <ShieldCheck size={19} />
                  )}
                </div>
                <p className="eyebrow">CAELUSH 账户</p>
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
  const accountName = accountState.account?.email ?? "Caelush 账户";
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
          className={`side-nav ${props.activeView === "devices" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("devices")}
        >
          <LaptopMinimal size={16} /> 设备
        </button>
        <button
          className={`side-nav ${props.activeView === "security" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("security")}
        >
          <KeyRound size={16} /> 安全设置
        </button>
        <button
          className={`side-nav ${props.activeView === "updates" ? "is-current" : ""}`}
          onClick={() => props.onNavigate("updates")}
        >
          <Download size={16} /> 检查更新
        </button>
        <div className="sidebar-separator" />
        <div className="sidebar-profile">
          <div className="profile-avatar">{accountName.slice(0, 1).toUpperCase()}</div>
          <div className="profile-meta">
            <b>{accountName}</b>
            <span>{offline ? "离线授权" : "已连接"}</span>
          </div>
          <button
            type="button"
            className="icon-button signout-icon"
            aria-label="退出登录"
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
          <LogOut size={15} /> 退出登录
        </button>
      </aside>

      <section className="account-content">
        <div className="account-page-head">
          <div>
            <p className="eyebrow">
              账户中心 <span>/</span> {accountViewLabel(props.activeView)}
            </p>
            <h2>
              {props.activeView === "home"
                ? "账户总览"
                : props.activeView === "devices"
                  ? "设备管理"
                  : props.activeView === "security"
                    ? "安全设置"
                    : "检查更新"}
            </h2>
          </div>
          <div className={`authorization-pill ${offline ? "is-offline" : ""}`}>
            <span className="connection-dot" />
            {offline ? "离线授权" : "账户已连接"}
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
        {props.activeView === "updates" && <UpdatePage />}
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
        ) : (
          <button
            className="icon-button banner-action"
            type="button"
            disabled={props.busy}
            aria-label="刷新账户连接状态"
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
        <section className="detail-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">账户信息</span>
              <h3>账户详情</h3>
            </div>
            <BadgeCheck size={18} />
          </div>
          <div className="detail-row">
            <span>邮箱地址</span>
            <b>{state.account?.email ?? "—"}</b>
          </div>
          <div className="detail-row">
            <span>邮箱验证</span>
            <b className="verified-state">
              <Check size={14} /> 已验证
            </b>
          </div>
          <div className="detail-row">
            <span>账户权益</span>
            <b>
              {formatEntitlement(state.account?.entitlements.find((item) => item.enabled)?.code)}
            </b>
          </div>
          <div className="detail-row">
            <span>注册时间</span>
            <b>{state.account ? formatDate(state.account.createdAt) : "—"}</b>
          </div>
        </section>
        <section className="detail-panel device-summary">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">当前设备</span>
              <h3>Windows 桌面端</h3>
            </div>
            <LaptopMinimal size={18} />
          </div>
          <div className="device-name">
            <div className="device-tile">
              <LaptopMinimal size={19} />
            </div>
            <div>
              <b>{formatDeviceLabel(state.device?.label ?? "Caelush Desktop")}</b>
              <span>{state.device?.current ? "当前设备" : "设备尚未验证"}</span>
            </div>
          </div>
          <div className="detail-row">
            <span>设备 ID</span>
            <b className="mono-value">{state.device?.deviceId ?? "—"}</b>
          </div>
          <button
            type="button"
            className="inline-action"
            onClick={() => props.onNavigate("devices")}
          >
            管理设备 <ChevronRight size={15} />
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
          <p className="eyebrow">本地 Agent</p>
          <h3>
            {state.agentEntry.available
              ? "本地 Agent 已就绪"
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
            打开 Agent <ArrowRight size={15} />
          </button>
        ) : (
          <span className="pending-status">
            {state.agentEntry.reason === "DAEMON_STARTING" ? "正在启动" : "暂不可用"}
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
          <p className="eyebrow">本地数据</p>
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

function agentStatusTitle(reason: AccountState["agentEntry"]["reason"]): string {
  switch (reason) {
    case "DAEMON_STARTING":
      return "正在启动本地 Agent";
    case "PROTOCOL_INCOMPATIBLE":
      return "桌面端与本地 Agent 版本不匹配";
    case "SAFE_SHUTDOWN_PENDING":
      return "本地 Agent 正在安全关闭";
    case "DAEMON_UNAVAILABLE":
      return "本地 Agent 暂不可用";
    case "ACCOUNT_NOT_AUTHORIZED":
    case undefined:
      return "本地 Agent 暂不可用";
  }
}

function agentStatusDescription(reason: AccountState["agentEntry"]["reason"]): string {
  switch (reason) {
    case "DAEMON_STARTING":
      return "正在准备并检查账户数据，完成后即可打开工作区。";
    case "PROTOCOL_INCOMPATIBLE":
      return "桌面端与其管理的本地服务通过兼容性检查后，才能访问工作区。";
    case "SAFE_SHUTDOWN_PENDING":
      return "本地操作正在进入安全检查点，暂时无法切换账户数据。";
    case "DAEMON_UNAVAILABLE":
      return "本地服务未能通过启动检查。请重新登录或重启桌面端后再试。";
    case "ACCOUNT_NOT_AUTHORIZED":
    case undefined:
      return "请登录或恢复有效的离线授权，以打开本地工作区。";
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
          <h3>已登录设备</h3>
          <p>查看已连接到账户的设备，并撤销不再使用的设备。</p>
        </div>
        <button
          type="button"
          className="secondary-button compact"
          disabled={!online || props.busy}
          onClick={props.onRefresh}
        >
          <RefreshCw size={14} /> 刷新账户
        </button>
      </div>
      {!online ? (
        <div className="empty-state">
          <Unplug size={20} />
          <b>离线时无法查看设备列表</b>
          <span>连接云端后即可查看设备状态或撤销访问权限。</span>
        </div>
      ) : props.devices.length === 0 ? (
        <div className="empty-state">
          <LoaderCircle size={20} className="spin" />
          <b>正在加载设备列表</b>
          <span>Caelush 正在检查此账户关联的设备。</span>
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
                  {formatDeviceLabel(device.label)}{" "}
                  {device.current && <span className="current-tag">当前设备</span>}
                </b>
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
        <ShieldCheck size={15} />{" "}
        撤销设备后，其在线会话会立即失效。设备重新连接时，系统也会重新检查离线授权。
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
            <h3>修改密码</h3>
            <p>修改密码后，其他已登录的账户会话将会失效。</p>
          </div>
          <KeyRound size={18} />
        </div>
        {!props.online && <MessageBox message="请先连接云端，再修改账户密码。" tone="info" />}
        <form className="password-change-form" onSubmit={props.onChangePassword}>
          <label className="field-label" htmlFor="current-password">
            当前密码
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
            新密码
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
            {props.busy ? <LoaderCircle size={15} className="spin" /> : null} 修改密码{" "}
            <ArrowRight size={15} />
          </button>
        </form>
      </section>
      <section className="security-note">
        <ShieldCheck size={18} />
        <div>
          <b>凭据存储</b>
          <span>
            刷新凭据、设备签名密钥和离线授权均通过当前 Windows
            用户配置加密。访问凭据仅保存在主进程内存中。
          </span>
        </div>
      </section>
      <button
        type="button"
        className="inline-action"
        disabled={props.busy}
        onClick={props.onRefresh}
      >
        检查账户授权状态 <ChevronRight size={15} />
      </button>
    </div>
  );
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

function accountViewLabel(view: AccountScreen): string {
  switch (view) {
    case "home":
      return "总览";
    case "devices":
      return "设备";
    case "security":
      return "安全设置";
    case "updates":
      return "检查更新";
  }
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

function formatEntitlement(code: string | undefined): string {
  if (code === undefined) return "暂无有效权益";
  if (code === "CAELUSH_DESKTOP_BASIC") return "Caelush 桌面端基础版";
  return code;
}

function localizeUiMessage(message: string): string {
  if (/[\u3400-\u9fff]/u.test(message)) return message;
  const normalized = message.toLowerCase();
  if (normalized.includes("vault") || normalized.includes("credential storage")) {
    return "无法访问 Windows 安全存储。请检查当前用户配置后重新启动 Caelush。";
  }
  if (normalized.includes("expired") && normalized.includes("session")) {
    return "云端会话已过期，请刷新账户授权后继续。";
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
  if (normalized.includes("device")) return "设备授权请求未能完成，请刷新账户后重试。";
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
