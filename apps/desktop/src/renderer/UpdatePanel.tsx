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
        if (mounted) setError("Update service unavailable.");
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
      setError("The update request could not be completed. Retry later.");
    }
  }
  if (!state) return null;
  const api = window.caelushDesktop.update;
  const busy = ["CHECKING", "DOWNLOADING", "VERIFYING", "INSTALLING"].includes(state.status);
  const ready = ["READY_TO_INSTALL", "INSTALL_DEFERRED", "WAITING_FOR_SAFE_SHUTDOWN"].includes(
    state.status,
  );
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
      <summary>Caelush {state.currentVersion} · Updates</summary>
      <div className="desktop-update-content">
        <p role={state.status === "ERROR" ? "alert" : "status"}>{error ?? state.message}</p>
        {state.latestVersion && (
          <p>
            <b>Version {state.latestVersion}</b> · {(state.artifactSize / 1024 / 1024).toFixed(1)}{" "}
            MB {state.mandatory ? "· Required update" : ""}
          </p>
        )}
        {state.graceDeadline && (
          <p>
            Requested by {new Date(state.graceDeadline).toLocaleString()}. Installation waits for a
            safe Agent checkpoint.
          </p>
        )}
        {state.releaseNotes && <pre className="desktop-release-notes">{state.releaseNotes}</pre>}
        {state.status === "DOWNLOADING" && (
          <>
            <progress
              aria-label="Installer download"
              max={state.artifactSize}
              value={state.downloadedBytes}
            />
            <p>{Math.floor((state.downloadedBytes / Math.max(1, state.artifactSize)) * 100)}%</p>
          </>
        )}
        <div className="desktop-update-actions">
          <button
            type="button"
            disabled={busy || ready}
            onClick={() => void action(() => api.check())}
          >
            Check for updates
          </button>
          {state.latestVersion &&
            !ready &&
            !busy &&
            state.latestVersion !== state.currentVersion && (
              <button type="button" onClick={() => void action(() => api.download())}>
                Download update
              </button>
            )}
          {state.status === "DOWNLOADING" && (
            <button type="button" onClick={() => void action(() => api.cancelDownload())}>
              Cancel download
            </button>
          )}
          {ready && (
            <>
              <button type="button" onClick={() => void action(() => api.install())}>
                {state.status === "WAITING_FOR_SAFE_SHUTDOWN"
                  ? "Retry safe installation"
                  : "Install and restart…"}
              </button>
              <button type="button" onClick={() => void action(() => api.deferInstall())}>
                Later
              </button>
            </>
          )}
        </div>
      </div>
    </details>
  );
}
