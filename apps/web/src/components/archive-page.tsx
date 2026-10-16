import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import {
  ArrowLeft,
  Archive,
  Check,
  ChevronDown,
  Folder,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import type { ArchiveSessionItem, ArchiveState, WorkspaceId } from "@caelush/protocol";
import {
  WebArchiveManager,
  type ArchiveManagerSnapshot,
  type ArchivePageClient,
} from "../application/archive-manager.js";
import { ArchiveDeleteDialog } from "./archive-delete-dialog.js";
import { ArchiveHistory } from "./archive-history.js";

const initial: ArchiveManagerSnapshot = {
  tab: "SESSIONS",
  sessionFilter: {},
  workspaceFilter: {},
  status: "LOADING",
};
export function ArchivePage(props: {
  readonly client: ArchivePageClient;
  readonly onClose: () => void;
  readonly onMutation: () => void;
}): ReactElement {
  const [manager, setManager] = useState<WebArchiveManager | null>(null);
  const [parent, setParent] = useState<WorkspaceId>();
  useEffect(() => {
    const next = new WebArchiveManager(props.client, {
      onMutation: props.onMutation,
      onParentWorkspaceRequired: setParent,
    });
    setManager(next);
    void next.refresh();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void next.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      next.dispose();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [props.client, props.onMutation]);
  const subscribe = useCallback(
    (listener: () => void) => manager?.subscribe(listener) ?? (() => undefined),
    [manager],
  );
  const snapshot = useCallback(() => manager?.getSnapshot() ?? initial, [manager]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (parent !== undefined && state.tab === "WORKSPACES" && state.status === "READY") {
      const row = document.getElementById(`archive-workspace-${parent}`);
      row?.focus();
      row?.scrollIntoView({ block: "center" });
    }
  }, [parent, state.tab, state.status, state.workspaces]);
  const actions: ArchivePageActions = {
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
    <>
      <main className="archive-page">
        <div className="archive-page-content">
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
            <ArchivePageView
              state={state}
              actions={actions}
              onClose={props.onClose}
              workspaceOptions={manager?.getWorkspaceOptions()}
            />
          )}
        </div>
      </main>
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
    </>
  );
}
type ArchivePageActions = {
  [
    K in
      | "setTab"
      | "setFilter"
      | "refresh"
      | "loadMore"
      | "restore"
      | "previewDeletion"
      | "openHistory"
  ]: (...args: Parameters<WebArchiveManager[K]>) => void;
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
export function ArchivePageView({
  state,
  actions,
  onClose,
  workspaceOptions,
}: {
  readonly state: ArchiveManagerSnapshot;
  readonly actions: ArchivePageActions;
  readonly onClose: () => void;
  readonly workspaceOptions?: readonly ArchiveSessionItem["group"][] | undefined;
}): ReactElement {
  const sessions = state.tab === "SESSIONS";
  const result = sessions ? state.sessions : state.workspaces;
  const filter = sessions ? state.sessionFilter : state.workspaceFilter;
  const [searchText, setSearchText] = useState(filter.query ?? "");
  const [workspaceFilterOpen, setWorkspaceFilterOpen] = useState(false);
  const workspaceFilterRootRef = useRef<HTMLDivElement>(null);
  const workspaceFilterTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceFilterOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const workspaceFilterId = useId();
  useEffect(() => {
    setSearchText(filter.query ?? "");
  }, [state.tab, filter.query]);
  useEffect(() => {
    if (!workspaceFilterOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!workspaceFilterRootRef.current?.contains(event.target as Node))
        setWorkspaceFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setWorkspaceFilterOpen(false);
      workspaceFilterTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceFilterOpen]);
  useEffect(() => {
    setWorkspaceFilterOpen(false);
  }, [state.tab]);
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
  const workspaceFilterValue = state.sessionFilter.unassociated
    ? "UNASSOCIATED"
    : (state.sessionFilter.workspaceId ?? "ALL");
  const workspaceFilterOptions = [
    { key: "ALL", displayName: "所有工作区", canonicalPath: "" },
    ...(workspaceOptions ?? [...groups.values()].map(({ item }) => item.group)),
  ];
  const selectedWorkspaceFilter =
    workspaceFilterOptions.find((option) => option.key === workspaceFilterValue) ??
    workspaceFilterOptions[0];
  const setWorkspaceFilter = (value: string): void => {
    actions.setFilter({
      ...(state.sessionFilter.query ? { query: state.sessionFilter.query } : {}),
      ...(value === "ALL"
        ? {}
        : value === "UNASSOCIATED"
          ? { unassociated: true as const }
          : { workspaceId: value as WorkspaceId }),
    });
    setWorkspaceFilterOpen(false);
    workspaceFilterTriggerRef.current?.focus();
  };
  const batch = sessions
    ? { type: "SESSION_FILTER" as const, filter: state.sessionFilter }
    : { type: "WORKSPACE_FILTER" as const, filter: state.workspaceFilter };
  const busy = state.status === "LOADING" || state.deletion?.status === "SUBMITTING";
  return (
    <>
      <button className="archive-back" onClick={onClose}>
        <ArrowLeft size={16} />
        返回工作台
      </button>
      <header className="archive-heading">
        <h1 tabIndex={-1}>已归档</h1>
        <button
          className="archive-bulk"
          disabled={busy || !result?.matchedCount}
          onClick={() => actions.previewDeletion(batch)}
        >
          <Trash2 size={14} />
          {filtered ? "删除筛选结果" : sessions ? "删除全部已归档会话" : "删除全部已归档工作区"}
        </button>
      </header>
      <div className="archive-tabs" role="tablist" aria-label="归档类型">
        <button
          role="tab"
          aria-selected={sessions}
          aria-controls="archive-results"
          onClick={() => actions.setTab("SESSIONS")}
        >
          会话
        </button>
        <button
          role="tab"
          aria-selected={!sessions}
          aria-controls="archive-results"
          onClick={() => actions.setTab("WORKSPACES")}
        >
          工作区
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
          <div
            className="archive-workspace-filter"
            ref={workspaceFilterRootRef}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setWorkspaceFilterOpen(false);
            }}
          >
            <button
              ref={workspaceFilterTriggerRef}
              type="button"
              className="archive-workspace-trigger"
              aria-label="筛选所属工作区"
              aria-haspopup="listbox"
              aria-expanded={workspaceFilterOpen}
              aria-controls={workspaceFilterOpen ? workspaceFilterId : undefined}
              onClick={() => setWorkspaceFilterOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                setWorkspaceFilterOpen(true);
                const selectedIndex = workspaceFilterOptions.findIndex(
                  (option) => option.key === workspaceFilterValue,
                );
                requestAnimationFrame(() => {
                  workspaceFilterOptionRefs.current[Math.max(selectedIndex, 0)]?.focus();
                });
              }}
            >
              <span className="archive-workspace-trigger-label">
                {selectedWorkspaceFilter?.displayName ?? "所有工作区"}
              </span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {workspaceFilterOpen && (
              <div
                id={workspaceFilterId}
                className="archive-workspace-popover"
                role="listbox"
                aria-label="筛选所属工作区"
              >
                {workspaceFilterOptions.map((option, index) => {
                  const selected = option.key === workspaceFilterValue;
                  return (
                    <button
                      key={option.key}
                      ref={(element) => {
                        workspaceFilterOptionRefs.current[index] = element;
                      }}
                      type="button"
                      className="archive-workspace-option"
                      role="option"
                      aria-selected={selected}
                      title={option.canonicalPath || option.displayName}
                      onClick={() => setWorkspaceFilter(option.key)}
                      onKeyDown={(event) => {
                        const currentIndex = workspaceFilterOptionRefs.current.indexOf(
                          event.currentTarget,
                        );
                        const nextIndex =
                          event.key === "ArrowDown"
                            ? Math.min(currentIndex + 1, workspaceFilterOptions.length - 1)
                            : event.key === "ArrowUp"
                              ? Math.max(currentIndex - 1, 0)
                              : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? workspaceFilterOptions.length - 1
                                  : undefined;
                        if (nextIndex === undefined) return;
                        event.preventDefault();
                        workspaceFilterOptionRefs.current[nextIndex]?.focus();
                      }}
                    >
                      <span className="archive-workspace-option-copy">
                        <span className="archive-workspace-option-name">{option.displayName}</span>
                        {option.canonicalPath && (
                          <small className="archive-workspace-option-path">
                            {option.canonicalPath}
                          </small>
                        )}
                      </span>
                      {selected && <Check size={15} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
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
