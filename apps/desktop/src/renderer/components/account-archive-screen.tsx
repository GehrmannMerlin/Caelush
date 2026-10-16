import { useEffect, useState, type ReactElement } from "react";
import { Archive, Folder, Search, Trash2, Undo2 } from "lucide-react";
import type { ArchiveSessionItem, ArchiveState, WorkspaceId } from "@caelush/protocol";
import type { DesktopArchiveApi } from "../../preload/api-types.js";
import type {
  AccountArchiveManager,
  AccountArchiveSnapshot,
} from "../archive/account-archive-manager.js";
import { useAccountArchives } from "../archive/use-account-archives.js";
import { ArchiveDeleteDialog } from "./archive-delete-dialog.js";
import { ArchiveHistory } from "./archive-history.js";

export function AccountArchiveEntry(props: {
  readonly api?: DesktopArchiveApi | undefined;
  readonly identityKey: string;
  readonly onMutation: () => void;
}): ReactElement {
  if (props.api?.capabilityVersion !== 1)
    return (
      <section className="archive-page account-archive-host">
        <h1>已归档</h1>
        <p className="archive-error" role="alert">
          归档功能不可用，请重建或更新桌面端。
        </p>
      </section>
    );
  return (
    <AccountArchiveScreen
      api={props.api}
      identityKey={props.identityKey}
      onMutation={props.onMutation}
    />
  );
}
export function AccountArchiveScreen(props: {
  readonly api: DesktopArchiveApi;
  readonly identityKey: string;
  readonly onMutation: () => void;
}): ReactElement {
  const [parent, setParent] = useState<WorkspaceId>();
  const { state, manager } = useAccountArchives(props.api, props.identityKey, {
    onMutation: props.onMutation,
    onParentWorkspaceRequired: setParent,
  });
  useEffect(() => {
    if (parent !== undefined && state.tab === "WORKSPACES" && state.status === "READY") {
      const row = document.getElementById(`archive-workspace-${parent}`);
      row?.focus();
      row?.scrollIntoView({ block: "center" });
    }
  }, [parent, state.tab, state.status, state.workspaces]);
  const actions: AccountArchiveActions = {
    setTab: (tab) => manager?.setTab(tab),
    setFilter: (filter) => manager?.setFilter(filter),
    refresh: () => {
      void manager?.refresh();
    },
    loadMore: () => {
      void manager?.loadMore();
    },
    restore: (value) => {
      void manager?.restore(value);
    },
    previewDeletion: (selection) => {
      void manager?.previewDeletion(selection);
    },
    openHistory: (id) => {
      void manager?.openHistory(id);
    },
  };
  return (
    <section className="archive-page account-archive-host">
      {state.history ? (
        <>
          <ArchiveHistory
            title={state.history.title}
            entries={state.history.items}
            loading={state.history.loading}
            hasMore={state.history.nextCursor !== undefined}
            onLoadMore={() => {
              void manager?.loadMoreHistory();
            }}
            onBack={() => manager?.closeHistory()}
          />
          {state.history.error && (
            <p role="alert" className="archive-error">
              {state.history.error.message}
            </p>
          )}
        </>
      ) : (
        <AccountArchiveView
          state={state}
          actions={actions}
          workspaceOptions={manager?.getWorkspaceOptions()}
        />
      )}
      {state.deletion && (
        <ArchiveDeleteDialog
          selection={state.deletion.selection}
          preview={state.deletion.preview}
          busy={state.deletion.status === "SUBMITTING"}
          error={state.deletion.error?.message}
          onCancel={() => manager?.cancelDeletion()}
          onConfirm={() => {
            void manager?.confirmDeletion();
          }}
          onRetry={() => {
            if (state.deletion) void manager?.previewDeletion(state.deletion.selection);
          }}
        />
      )}
    </section>
  );
}
type AccountArchiveActions = {
  [
    K in
      | "setTab"
      | "setFilter"
      | "refresh"
      | "loadMore"
      | "restore"
      | "previewDeletion"
      | "openHistory"
  ]: (...args: Parameters<AccountArchiveManager[K]>) => void;
};
export function archiveDate(time: number | null): string {
  return time === null
    ? "归档时间未知"
    : `归档于 ${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(time)}`;
}
function RestoreButton({
  state,
  onRestore,
}: {
  state: ArchiveState;
  onRestore: (state: ArchiveState) => void;
}) {
  return (
    <button
      className="archive-restore"
      disabled={state.restoreDisposition === "WORKSPACE_UNAVAILABLE"}
      onClick={() => onRestore(state)}
      title={
        state.restoreDisposition === "WORKSPACE_UNAVAILABLE"
          ? "原工作区不可用，暂时无法恢复"
          : undefined
      }
    >
      {state.restoreDisposition === "PARENT_ARCHIVED"
        ? "先恢复工作区"
        : state.target.type === "WORKSPACE"
          ? "恢复工作区"
          : "取消归档"}
      <Undo2 size={14} aria-hidden="true" />
    </button>
  );
}
export function AccountArchiveView({
  state,
  actions,
  workspaceOptions,
}: {
  readonly state: AccountArchiveSnapshot;
  readonly actions: AccountArchiveActions;
  readonly workspaceOptions?: readonly ArchiveSessionItem["group"][] | undefined;
}): ReactElement {
  const sessions = state.tab === "SESSIONS";
  const result = sessions ? state.sessions : state.workspaces;
  const counts = result?.totalCounts ?? { sessions: 0, workspaces: 0 };
  const filter = sessions ? state.sessionFilter : state.workspaceFilter;
  const [searchText, setSearchText] = useState(filter.query ?? "");
  useEffect(() => {
    setSearchText(filter.query ?? "");
  }, [state.tab, filter.query]);
  const filtered =
    Boolean(filter.query) ||
    (sessions &&
      (state.sessionFilter.workspaceId !== undefined || state.sessionFilter.unassociated === true));
  const groups = new Map<string, { item: ArchiveSessionItem; items: ArchiveSessionItem[] }>();
  for (const item of state.sessions?.items ?? []) {
    const group = groups.get(item.group.key);
    if (group) group.items.push(item);
    else groups.set(item.group.key, { item, items: [item] });
  }
  const batch = sessions
    ? { type: "SESSION_FILTER" as const, filter: state.sessionFilter }
    : { type: "WORKSPACE_FILTER" as const, filter: state.workspaceFilter };
  const busy = state.status === "LOADING" || state.deletion?.status === "SUBMITTING";
  return (
    <>
      <header className="archive-heading">
        <h1 tabIndex={-1}>已归档</h1>
        <button
          className="archive-bulk"
          disabled={busy || !result?.matchedCount}
          onClick={() => actions.previewDeletion(batch)}
        >
          <Trash2 size={14} />
          {filtered
            ? "删除筛选结果"
            : sessions
              ? "删除全部已归档会话"
              : "删除全部已归档工作区"} · {result?.matchedCount ?? 0}
        </button>
      </header>
      <div className="archive-tabs" role="tablist" aria-label="归档类型">
        <button
          role="tab"
          aria-selected={sessions}
          aria-controls="archive-results"
          onClick={() => actions.setTab("SESSIONS")}
        >
          会话 · {counts.sessions}
        </button>
        <button
          role="tab"
          aria-selected={!sessions}
          aria-controls="archive-results"
          onClick={() => actions.setTab("WORKSPACES")}
        >
          工作区 · {counts.workspaces}
        </button>
      </div>
      <div className="archive-toolbar">
        <label className="archive-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label={sessions ? "搜索已归档会话" : "搜索已归档工作区"}
            placeholder={sessions ? "搜索已归档会话" : "搜索已归档工作区"}
            value={searchText}
            maxLength={200}
            onChange={(event) => {
              setSearchText(event.target.value);
              actions.setFilter({ ...filter, query: event.target.value });
            }}
          />
        </label>
        {sessions && (
          <select
            aria-label="筛选所属工作区"
            value={
              state.sessionFilter.unassociated
                ? "UNASSOCIATED"
                : (state.sessionFilter.workspaceId ?? "ALL")
            }
            onChange={(event) => {
              const value = event.target.value;
              actions.setFilter({
                ...(state.sessionFilter.query ? { query: state.sessionFilter.query } : {}),
                ...(value === "ALL"
                  ? {}
                  : value === "UNASSOCIATED"
                    ? { unassociated: true as const }
                    : { workspaceId: value as WorkspaceId }),
              });
            }}
          >
            <option value="ALL">所有工作区</option>
            {(workspaceOptions ?? [...groups.values()].map(({ item }) => item.group)).map(
              (group) => (
                <option key={group.key} value={group.key}>
                  {group.displayName}
                  {group.canonicalPath ? ` · ${group.canonicalPath}` : ""}
                </option>
              ),
            )}
          </select>
        )}
      </div>
      {state.error && (
        <div className="archive-error" role="alert">
          {state.error.message}
          <button onClick={() => actions.refresh()}>重试</button>
        </div>
      )}
      <section
        id="archive-results"
        role="tabpanel"
        aria-label={sessions ? "已归档会话" : "已归档工作区"}
        aria-busy={state.status === "LOADING"}
      >
        {state.status === "LOADING" && result === undefined ? (
          <div className="archive-skeleton" role="status">
            正在加载归档记录…
          </div>
        ) : result?.items.length === 0 ? (
          <div className="archive-empty">
            <Archive size={28} strokeWidth={1.5} />
            <p>
              {filtered ? "没有找到匹配结果" : sessions ? "暂无已归档会话" : "暂无已归档工作区"}
            </p>
            {filtered && (
              <button className="archive-secondary" onClick={() => actions.setFilter({})}>
                清除筛选
              </button>
            )}
          </div>
        ) : sessions ? (
          [...groups.values()].map(({ item, items }) => (
            <section className="archive-group" key={item.group.key}>
              <header>
                <div>
                  <Folder size={15} />
                  <strong>{item.group.displayName}</strong>
                </div>
                <span>{item.group.matchedCount} 个会话</span>
              </header>
              {item.group.canonicalPath && (
                <p className="archive-group-path">{item.group.canonicalPath}</p>
              )}
              <div className="archive-list">
                {items.map((session) => (
                  <div className="archive-row" key={session.sessionId}>
                    <div className="archive-row-copy">
                      <button
                        className="archive-title"
                        onClick={() => actions.openHistory(session.sessionId)}
                      >
                        {session.title}
                      </button>
                      <small>
                        {archiveDate(session.archivedAt)}
                        {session.state.ownArchive === undefined ? " · 随工作区归档" : ""}
                      </small>
                    </div>
                    <div className="archive-row-actions">
                      <RestoreButton state={session.state} onRestore={actions.restore} />
                      <button
                        className="archive-delete-icon"
                        aria-label="彻底删除会话"
                        title="彻底删除会话"
                        onClick={() =>
                          actions.previewDeletion({ type: "SESSION", sessionId: session.sessionId })
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="archive-list archive-workspace-list">
            {state.workspaces?.items.map((item) => (
              <div
                className="archive-row archive-workspace-row"
                id={`archive-workspace-${item.workspace.id}`}
                tabIndex={-1}
                key={item.workspace.id}
              >
                <Folder size={19} aria-hidden="true" />
                <div className="archive-row-copy">
                  <strong>{item.workspace.displayName}</strong>
                  <small className="archive-path">{item.workspace.canonicalPath}</small>
                  <small>
                    {archiveDate(item.archivedAt)} · {item.sessionCount} 个会话
                  </small>
                </div>
                <div className="archive-row-actions">
                  <RestoreButton state={item.state} onRestore={actions.restore} />
                  <button
                    className="archive-delete-icon"
                    aria-label="彻底删除工作区"
                    title="彻底删除工作区"
                    onClick={() =>
                      actions.previewDeletion({ type: "WORKSPACE", workspaceId: item.workspace.id })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {result?.nextCursor && (
          <button className="archive-load-more" disabled={busy} onClick={() => actions.loadMore()}>
            {busy ? "正在加载…" : "加载更多"}
          </button>
        )}
      </section>
    </>
  );
}
