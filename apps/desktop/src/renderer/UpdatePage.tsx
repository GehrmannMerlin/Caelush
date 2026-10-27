import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock3,
  Download,
  FileText,
  RefreshCw,
} from "lucide-react";
import { CaelushBrand } from "@caelush/ui-theme/brand";
import type { ResolvedTheme } from "@caelush/ui-theme/appearance";
import caelushIconLight from "@caelush/ui-theme/assets/caelush-icon.png";
import caelushIconDark from "@caelush/ui-theme/assets/caelush-icon-white.png";
import type { DesktopReleaseHistoryItem, DesktopUpdateState } from "../shared/update-contract.js";

export function UpdatePage({ theme = "light" }: { readonly theme?: ResolvedTheme } = {}) {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [releases, setReleases] = useState<readonly DesktopReleaseHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  useEffect(() => {
    const api = window.caelushDesktop.update;
    let mounted = true;
    const unsubscribe = api.subscribeState((next) => {
      if (mounted) setState(next);
    });
    void api
      .getState()
      .then((next) => {
        if (mounted) setState(next);
      })
      .catch(() => {
        if (mounted) setRequestError("更新服务暂不可用，请稍后重试。");
      });
    void api
      .getReleaseHistory()
      .then((items) => {
        if (mounted) setReleases(items);
      })
      .catch(() => {
        if (mounted) setHistoryError(true);
      })
      .finally(() => {
        if (mounted) setHistoryLoading(false);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const api = window.caelushDesktop.update;
  const status = state?.status ?? "IDLE";
  const busy = ["CHECKING", "DOWNLOADING", "VERIFYING", "INSTALLING"].includes(status);
  const ready = ["READY_TO_INSTALL", "INSTALL_DEFERRED", "WAITING_FOR_SAFE_SHUTDOWN"].includes(
    status,
  );
  const canCheck = !busy && !ready;
  const isError = requestError !== null || status === "ERROR";
  const isSuccess = requestError === null && ["UP_TO_DATE", "COMPLETED"].includes(status);
  const percent = Math.min(
    100,
    Math.floor(((state?.downloadedBytes ?? 0) / Math.max(1, state?.artifactSize ?? 0)) * 100),
  );
  const selectedRelease =
    releases.find((release) => release.version === selectedVersion) ?? releases[0] ?? null;

  if (state === null && requestError === null) return <UpdatePageSkeleton />;

  async function action(operation: () => Promise<unknown>) {
    setRequestError(null);
    try {
      await operation();
    } catch {
      setRequestError("更新请求未能完成，请稍后重试。");
    }
  }

  const statusMessage = requestError
    ? requestError
    : state
      ? updateStatusMessage(state, percent)
      : "正在读取当前桌面端状态…";
  const statusHeading = updateStatusHeading(status, requestError);

  return (
    <div className="update-page">
      <section className="update-status-card" aria-labelledby="update-status-heading">
        <div className="update-status-copy">
          <CaelushBrand
            kind="icon"
            theme={theme}
            lightSrc={caelushIconLight}
            darkSrc={caelushIconDark}
            className="update-symbol"
            alt="Caelush"
          />
          <div>
            <h3 id="update-status-heading">软件更新</h3>
            <p className="update-current-version">
              当前版本{" "}
              <b>Caelush {state?.currentVersion ?? (requestError ? "暂不可用" : "读取中…")}</b>
            </p>
          </div>
        </div>

        <div
          className={`update-state-panel${isError ? " is-error" : isSuccess ? " is-success" : ""}`}
        >
          <span className="update-state-icon" aria-hidden="true">
            {isError ? (
              <AlertCircle size={20} />
            ) : isSuccess ? (
              <Check size={20} />
            ) : status === "IDLE" ? (
              <Clock3 size={20} />
            ) : status === "UPDATE_AVAILABLE" || status === "DOWNLOADING" || ready ? (
              <Download size={20} />
            ) : (
              <RefreshCw size={19} className={busy ? "spin" : ""} />
            )}
          </span>
          <div className="update-state-copy">
            <h4 id="update-state-heading">{statusHeading}</h4>
            <p role={isError ? "alert" : "status"}>{statusMessage}</p>

            {state?.latestVersion && state.latestVersion !== state.currentVersion && (
              <div className="update-version-facts">
                <span>目标版本</span>
                <b>Caelush {state.latestVersion}</b>
                <span>安装包</span>
                <b>
                  {(state.artifactSize / 1024 / 1024).toFixed(1)} MB
                  {state.mandatory ? " · 必须更新" : ""}
                </b>
              </div>
            )}

            {status === "DOWNLOADING" && state && (
              <div className="update-download-progress">
                <div>
                  <span>正在下载并校验安装包</span>
                  <b>{percent}%</b>
                </div>
                <progress
                  aria-label="安装包下载进度"
                  max={Math.max(1, state.artifactSize)}
                  value={state.downloadedBytes}
                />
              </div>
            )}
          </div>

          <div className="update-status-actions">
            {ready ? (
              <>
                <button
                  type="button"
                  className="primary-button update-action-primary"
                  onClick={() => void action(() => api.install())}
                >
                  {status === "WAITING_FOR_SAFE_SHUTDOWN" ? "重试安全安装" : "安装并重启…"}
                </button>
                <button
                  type="button"
                  className="secondary-button update-action-secondary"
                  onClick={() => void action(() => api.deferInstall())}
                >
                  稍后安装
                </button>
              </>
            ) : status === "DOWNLOADING" ? (
              <button
                type="button"
                className="text-button update-cancel-download"
                onClick={() => void action(() => api.cancelDownload())}
              >
                取消下载
              </button>
            ) : (
              <button
                type="button"
                className="primary-button update-check-button"
                disabled={!canCheck}
                onClick={() => void action(() => api.check())}
              >
                <RefreshCw size={14} className={status === "CHECKING" ? "spin" : ""} />
                {status === "CHECKING"
                  ? "正在检查…"
                  : status === "VERIFYING"
                    ? "正在验证…"
                    : status === "INSTALLING"
                      ? "正在安装…"
                      : "检查更新"}
              </button>
            )}
          </div>
        </div>

        <div className="update-history-section">
          <button
            type="button"
            className="update-history-toggle"
            aria-expanded={historyOpen}
            aria-controls="update-history-panel"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <span className="update-history-symbol" aria-hidden="true">
              <FileText size={18} />
            </span>
            <span className="update-history-copy">
              <span>版本记录</span>
              <small>查看更新说明</small>
            </span>
            <ChevronDown size={16} className={historyOpen ? "is-open" : ""} aria-hidden="true" />
          </button>
          {historyOpen && (
            <div className="update-history-panel" id="update-history-panel">
              {historyLoading ? (
                <div className="update-history-skeleton" aria-label="正在加载版本记录">
                  {[0, 1, 2].map((item) => (
                    <span className="skeleton-block" key={item} />
                  ))}
                </div>
              ) : historyError ? (
                <p className="update-history-empty">版本记录暂时无法加载。</p>
              ) : releases.length === 0 ? (
                <p className="update-history-empty">当前渠道还没有已发布的版本记录。</p>
              ) : (
                <>
                  <div className="update-release-list" aria-label="版本记录">
                    {releases.map((release) => (
                      <button
                        type="button"
                        key={`${release.channel}-${release.version}`}
                        className={`update-release-option ${selectedRelease?.version === release.version ? "is-selected" : ""}`}
                        aria-pressed={selectedRelease?.version === release.version}
                        onClick={() => setSelectedVersion(release.version)}
                      >
                        <span>
                          <b>版本 {release.version}</b>
                          <small>{formatPublishedAt(release.publishedAt)}</small>
                        </span>
                        {selectedRelease?.version === release.version && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                  {selectedRelease && (
                    <article className="update-release-detail">
                      <pre>{selectedRelease.releaseNotes || "此版本没有填写更新说明。"}</pre>
                    </article>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function UpdatePageSkeleton() {
  return (
    <div
      className="update-page update-page--loading"
      aria-busy="true"
      aria-label="正在读取更新状态"
    >
      <section className="update-status-card update-skeleton-card" aria-hidden="true">
        <div className="update-status-copy">
          <span className="skeleton-block update-skeleton-symbol" />
          <div className="update-skeleton-title-group">
            <span className="skeleton-block update-skeleton-title" />
            <span className="skeleton-block update-skeleton-version" />
          </div>
        </div>
        <div className="update-skeleton-state">
          <span className="skeleton-block update-skeleton-state-icon" />
          <div className="update-skeleton-state-copy">
            <span className="skeleton-block update-skeleton-title" />
            <span className="skeleton-block update-skeleton-version" />
          </div>
          <span className="skeleton-block update-skeleton-button" />
        </div>
        <div className="update-skeleton-history">
          <span className="skeleton-block update-skeleton-symbol" />
          <span className="skeleton-block update-skeleton-history-copy" />
        </div>
      </section>
      <span className="visually-hidden" role="status">
        正在读取更新状态
      </span>
    </div>
  );
}

function updateStatusHeading(status: DesktopUpdateState["status"], requestError: string | null) {
  if (requestError !== null) return "更新请求未完成";
  switch (status) {
    case "IDLE":
      return "尚未检查更新";
    case "CHECKING":
      return "正在检查更新";
    case "NO_POLICY":
      return "暂时无法确认更新";
    case "UP_TO_DATE":
      return "当前已是最新版本";
    case "UPDATE_AVAILABLE":
      return "发现新版本";
    case "DOWNLOADING":
      return "正在下载更新";
    case "VERIFYING":
      return "正在验证安装包";
    case "READY_TO_INSTALL":
      return "更新已准备就绪";
    case "WAITING_FOR_SAFE_SHUTDOWN":
      return "等待安全安装";
    case "INSTALLING":
      return "正在安装更新";
    case "INSTALL_DEFERRED":
      return "更新已暂缓安装";
    case "COMPLETED":
      return "更新已完成";
    case "ERROR":
      return "更新检查失败";
  }
}

function updateStatusMessage(state: DesktopUpdateState, percent: number): string {
  switch (state.status) {
    case "IDLE":
      return "点击“检查更新”查询当前渠道的已签名版本。";
    case "CHECKING":
      return "正在检查更新…";
    case "NO_POLICY":
      return "此渠道暂无适用于当前版本的更新策略，暂时无法确认是否有新版本。";
    case "UP_TO_DATE":
      return "当前已是最新版本。";
    case "UPDATE_AVAILABLE":
      return state.latestVersion
        ? `发现新版本 ${state.latestVersion}，正在自动下载。`
        : "发现新版本，正在自动下载。";
    case "DOWNLOADING":
      return `正在下载更新（${percent}%）…`;
    case "VERIFYING":
      return "正在验证更新安装包…";
    case "READY_TO_INSTALL":
      return "更新已下载并验证完成，可以安装。";
    case "WAITING_FOR_SAFE_SHUTDOWN":
      return "正在等待 Agent 完成当前操作，之后即可安全安装。";
    case "INSTALLING":
      return "正在安装更新…";
    case "INSTALL_DEFERRED":
      return "更新安装已暂缓。";
    case "COMPLETED":
      return "更新已完成。";
    case "ERROR":
      return "更新检查失败，请稍后重试。";
  }
}

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}
