import { useEffect, useState } from "react";

interface UpdateState {
  status: string;
  currentVersion: string;
  latestVersion: string | null;
  message: string;
  releaseNotes: string;
  artifactSize: number;
  downloadedBytes: number;
  mandatory: boolean;
}
interface UpdateApi {
  getState(): Promise<UpdateState>;
  check(): Promise<unknown>;
  download(): Promise<unknown>;
  install(): Promise<unknown>;
  cancelDownload(): Promise<unknown>;
  deferInstall(): Promise<unknown>;
  subscribeState(listener: (s: UpdateState) => void): () => void;
}
function updateApi(): UpdateApi | undefined {
  return (window as Window & { caelushDesktop?: { update?: UpdateApi } }).caelushDesktop?.update;
}
export function DesktopUpdateSettings() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const api = updateApi();
    if (!api) return;
    let active = true;
    void api
      .getState()
      .then((s) => {
        if (active) setState(s);
      })
      .catch(() => {});
    const unsubscribe = api.subscribeState((s) => {
      if (active) setState(s);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const api = updateApi();
  if (!api || !state) return null;
  const busy = ["CHECKING", "DOWNLOADING", "VERIFYING", "INSTALLING"].includes(state.status);
  const ready = ["READY_TO_INSTALL", "WAITING_FOR_SAFE_SHUTDOWN", "INSTALL_DEFERRED"].includes(
    state.status,
  );
  const action = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch {
      setError("更新操作未能完成，请稍后重试。");
    }
  };
  return (
    <section className="settings-intro" aria-label="桌面更新">
      <h3>Caelush 桌面版 {state.currentVersion}</h3>
      <p role="status">{error ?? state.message}</p>
      {state.latestVersion && (
        <p>
          新版本 {state.latestVersion} · {(state.artifactSize / 1024 / 1024).toFixed(1)} MB{" "}
          {state.mandatory ? "· 必要更新" : ""}
        </p>
      )}
      {state.releaseNotes && (
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{state.releaseNotes}</p>
      )}
      {state.status === "DOWNLOADING" && (
        <progress
          aria-label="更新下载进度"
          max={state.artifactSize}
          value={state.downloadedBytes}
        />
      )}
      <button type="button" disabled={busy || ready} onClick={() => void action(() => api.check())}>
        检查更新
      </button>{" "}
      {!busy && !ready && state.latestVersion && state.latestVersion !== state.currentVersion && (
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
          </button>{" "}
          <button type="button" onClick={() => void action(() => api.deferInstall())}>
            稍后安装
          </button>
        </>
      )}
    </section>
  );
}
