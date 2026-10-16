import { useEffect, useRef, type ReactElement } from "react";
import type { ArchiveDeletionSelection, ArchiveDeletionPreviewResponse } from "@caelush/protocol";
export function ArchiveDeleteDialog(props: {
  readonly selection: ArchiveDeletionSelection;
  readonly preview?: ArchiveDeletionPreviewResponse | undefined;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onRetry?: (() => void) | undefined;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!latest.current.busy) latest.current.onCancel();
      }
      if (event.key === "Tab") {
        const controls = [
          ...(root.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href],[tabindex="0"]',
          ) ?? []),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.querySelector<HTMLElement>(".archive-page h1")?.focus();
    };
  }, []);
  const workspace =
    props.selection.type === "WORKSPACE" || props.selection.type === "WORKSPACE_FILTER";
  const bulk = props.selection.type.endsWith("FILTER");
  const counts = props.preview?.counts;
  return (
    <div className="archive-modal-backdrop">
      <div
        className="archive-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="archive-delete-title"
        aria-describedby="archive-delete-description"
        ref={root}
      >
        <h2 id="archive-delete-title">
          {bulk
            ? "彻底删除这些归档记录？"
            : workspace
              ? "彻底删除这个工作区？"
              : "彻底删除这个会话？"}
        </h2>
        <div id="archive-delete-description">
          {counts === undefined ? (
            <p role="status">正在核对删除范围…</p>
          ) : (
            <>
              <p>
                {workspace
                  ? `将删除 Caelush 中的 ${counts.workspaces} 个工作区记录及其 ${counts.sessions} 个会话。项目文件会保留。`
                  : `将永久删除 ${counts.sessions} 个会话及关联的 ${counts.runs} 个运行记录，无法恢复。`}
              </p>
              {bulk && (
                <p className="archive-muted">
                  {props.selection.type === "SESSION_FILTER" ||
                  props.selection.type === "WORKSPACE_FILTER"
                    ? props.selection.filter.query
                      ? `筛选：${props.selection.filter.query}`
                      : "范围：当前页签的全部匹配归档，涵盖所有分页"
                    : ""}
                </p>
              )}
              <ul>
                {props.preview?.samples.map((sample, index) => (
                  <li key={index}>
                    <strong>{sample.label}</strong>
                    {sample.canonicalPath && <small>{sample.canonicalPath}</small>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {props.error && (
          <p className="archive-error" role="alert">
            {props.error}
          </p>
        )}
        <div className="archive-dialog-actions">
          <button
            ref={cancel}
            className="archive-secondary"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            取消
          </button>
          {props.error && !props.preview ? (
            <button className="archive-secondary" disabled={props.busy} onClick={props.onRetry}>
              重新预览
            </button>
          ) : (
            <button
              className="archive-danger"
              disabled={props.busy || props.preview === undefined}
              onClick={props.onConfirm}
            >
              {props.busy ? "正在删除…" : "彻底删除"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
