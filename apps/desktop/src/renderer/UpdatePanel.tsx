import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../shared/update-contract.js";

export function UpdatePanel() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const api = window.caelushDesktop.update;
    let mounted = true;
    void api
      .getState()
      .then((s) => {
        if (mounted) setState(s);
      })
      .catch(() => {
        if (mounted) setError("更新服务暂不可用。");
      });
    const unsubscribe = api.subscribeState((s) => {
      if (mounted) setState(s);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  async function action(operation: () => Promise<unknown>) {
    setError(null);
    try {
      await operation();
    } catch {
      setError("更新请求未能完成，请稍后重试。");
    }
  }
  if (!state) return null;
  const api = window.caelushDesktop.update;
  const busy = ["CHECKING", "DOWNLOADING", "VERIFYING", "INSTALLING"].includes(state.status);
  const ready = ["READY_TO_INSTALL", "INSTALL_DEFERRED", "WAITING_FOR_SAFE_SHUTDOWN"].includes(
    state.status,
  );
  const percent = Math.floor((state.downloadedBytes / Math.max(1, state.artifactSize)) * 100);
  return (
    <details
      className="desktop-update-panel"
      open={
        state.status === "COMPLETED" ||
        state.status === "WAITING_FOR_SAFE_SHUTDOWN" ||
        state.status === "ERROR"
          ? true
          : undefined
      }
    >
      <summary>Caelush {state.currentVersion} · 更新</summary>
      <div className="desktop-update-content">
        <p role={state.status === "ERROR" ? "alert" : "status"}>
          {error ?? updateStatusMessage(state.status, state.latestVersion, percent)}
        </p>
        {state.latestVersion && (
          <p>
            <b>最新版本 {state.latestVersion}</b> · {(state.artifactSize / 1024 / 1024).toFixed(1)}{" "}
            MB {state.mandatory ? "· 必须更新" : ""}
          </p>
        )}
        {state.graceDeadline && (
          <p>
            更新请求时间：{new Date(state.graceDeadline).toLocaleString("zh-CN")}。安装将在 Agent
            到达安全检查点后进行。
          </p>
        )}
        {state.releaseNotes && /[\u3400-\u9fff]/u.test(state.releaseNotes) && (
          <pre className="desktop-release-notes">{state.releaseNotes}</pre>
        )}
        {state.status === "DOWNLOADING" && (
          <>
            <progress
              aria-label="安装包下载进度"
              max={state.artifactSize}
              value={state.downloadedBytes}
            />
            <p>{percent}%</p>
          </>
        )}
        <div className="desktop-update-actions">
          <button
            type="button"
            disabled={busy || ready}
            onClick={() => void action(() => api.check())}
          >
            检查更新
          </button>
          {state.latestVersion &&
            !ready &&
            !busy &&
            state.latestVersion !== state.currentVersion && (
              <button type="button" onClick={() => void action(() => api.download())}>
                下载更新
              </button>
            )}
          {state.status === "DOWNLOADING" && (
            <button type="button" onClick={() => void action(() => api.cancelDownload())}>
              取消下载
            </button>
          )}
          {ready && (
            <>
              <button type="button" onClick={() => void action(() => api.install())}>
                {state.status === "WAITING_FOR_SAFE_SHUTDOWN" ? "重试安全安装" : "安装并重启…"}
              </button>
              <button type="button" onClick={() => void action(() => api.deferInstall())}>
                稍后
              </button>
            </>
          )}
        </div>
      </div>
    </details>
  );
}

function updateStatusMessage(
  status: DesktopUpdateState["status"],
  latestVersion: string | null,
  percent: number,
): string {
  switch (status) {
    case "IDLE":
      return "可检查已签名的桌面端更新。";
    case "CHECKING":
      return "正在检查更新…";
    case "NO_POLICY":
      return "当前没有可用的更新策略。";
    case "UP_TO_DATE":
      return "当前已是最新版本。";
    case "UPDATE_AVAILABLE":
      return latestVersion ? `发现新版本 ${latestVersion}。` : "发现可用更新。";
    case "DOWNLOADING":
      return `正在下载更新（${percent}%）…`;
    case "VERIFYING":
      return "正在验证更新安装包…";
    case "READY_TO_INSTALL":
      return "更新已准备就绪，可以安装。";
    case "WAITING_FOR_SAFE_SHUTDOWN":
      return "正在等待 Agent 完成当前操作，之后即可安全安装。";
    case "INSTALLING":
      return "正在安装更新…";
    case "INSTALL_DEFERRED":
      return "更新安装已暂缓。";
    case "COMPLETED":
      return "更新已完成。";
    case "ERROR":
      return "更新失败，请稍后重试。";
  }
}
