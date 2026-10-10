import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  WorkspaceId,
  WorkspaceRecord,
  WorkspaceSessionSummary,
  SessionId,
} from "@caelush/protocol";
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Folder,
  FolderKanban,
  FolderOpen,
  Plus,
  SlidersHorizontal,
  Settings,
} from "lucide-react";
import { derivePromptTitle } from "../application/prompt.js";
import { sessionArchiveStore } from "../application/session-archive-store.js";
import caelushLogo from "../assets/logo/caelush-logo.png";
import archiveIcon from "../assets/icons/archive.svg";
import { RunStatusIcon, runStatusClass, runStatusLabel } from "./run-status.js";

export interface WorkspaceSidebarProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId?: WorkspaceId | undefined;
  readonly expandedWorkspaceIds: readonly WorkspaceId[];
  readonly sessionSummaries: Readonly<Record<string, readonly WorkspaceSessionSummary[]>>;
  readonly selectedSessionId?: SessionId | undefined;
  readonly isDraft: boolean;
  readonly canNavigate: boolean;
  readonly isOpen?: boolean;
  readonly onToggleWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onSelectWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onNewSession: (workspaceId: WorkspaceId) => void;
  readonly onSelectSession: (workspaceId: WorkspaceId, sessionId: SessionId) => void;
  readonly onAddWorkspace: () => void;
  readonly onForgetWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onOpenSettings?: () => void;
}

export interface WorkspaceSettingsMenuProps {
  readonly onSelect: () => void;
}

export function WorkspaceSettingsMenu(props: WorkspaceSettingsMenuProps): ReactElement {
  return createElement(
    "div",
    {
      id: "workspace-settings-menu",
      className: "workspace-settings-menu",
      role: "menu",
      "aria-label": "设置选项",
    },
    createElement(
      "button",
      {
        type: "button",
        className: "workspace-settings-menu-item",
        role: "menuitem",
        onClick: props.onSelect,
      },
      createElement(SlidersHorizontal, { size: 16, strokeWidth: 2, "aria-hidden": true }),
      createElement("span", null, "模型与配置"),
    ),
  );
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps): ReactElement {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState(() => sessionArchiveStore.list());
  const settingsControlRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const archivedSessionIds = new Set(archivedSessions.map((record) => record.sessionId));
  const isDesktopHost = globalThis.location?.protocol === "caelush-app:";

  const archiveSession = (sessionId: SessionId): void => {
    setArchivedSessions(sessionArchiveStore.archive(sessionId));
  };

  useEffect(() => {
    if (!settingsMenuOpen) return undefined;

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !settingsControlRef.current?.contains(target)) {
        setSettingsMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setSettingsMenuOpen(false);
      settingsButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [settingsMenuOpen]);

  return createElement(
    "aside",
    {
      id: "caelush-workspace-sidebar",
      className: `workspace-sidebar${props.isOpen === false ? " workspace-sidebar--closed" : ""}`,
      "aria-label": "项目和会话",
    },
    createElement(
      "div",
      { className: "workspace-sidebar-brand" },
      createElement("img", {
        className: "workspace-sidebar-logo",
        src: caelushLogo,
        alt: "Caelush",
      }),
    ),
    createElement(
      "div",
      { className: "workspace-sidebar-heading" },
      createElement(
        "h2",
        null,
        createElement(FolderKanban, { size: 16, strokeWidth: 2.15, "aria-hidden": true }),
        createElement("span", null, "项目"),
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "workspace-add-button",
          onClick: props.onAddWorkspace,
        },
        createElement(Plus, { size: 15, strokeWidth: 2.4, "aria-hidden": true }),
        createElement("span", null, "添加工作区"),
      ),
    ),
    createElement(
      "ol",
      { className: "workspace-list" },
      props.workspaces.map((workspace) =>
        renderWorkspace(props, workspace, archivedSessionIds, archiveSession),
      ),
    ),
    createElement(
      "div",
      { className: "workspace-sidebar-footer" },
      isDesktopHost
        ? createElement(
            "a",
            {
              className: "workspace-settings-button workspace-account-link",
              href: "caelush-login://app/",
            },
            createElement("span", null, "Desktop account"),
          )
        : null,
      createElement(
        "div",
        { className: "workspace-settings-control", ref: settingsControlRef },
        createElement(
          "button",
          {
            type: "button",
            className: "workspace-settings-button",
            ref: settingsButtonRef,
            onClick: () => setSettingsMenuOpen((open) => !open),
            "aria-haspopup": "menu",
            "aria-expanded": settingsMenuOpen,
          },
          createElement(Settings, { size: 16, strokeWidth: 2.1, "aria-hidden": true }),
          createElement("span", null, "设置"),
        ),
        settingsMenuOpen
          ? createElement(WorkspaceSettingsMenu, {
              onSelect: () => {
                setSettingsMenuOpen(false);
                props.onOpenSettings?.();
              },
            })
          : null,
      ),
    ),
  );
}

function renderWorkspace(
  props: WorkspaceSidebarProps,
  workspace: WorkspaceRecord,
  archivedSessionIds: ReadonlySet<SessionId>,
  onArchiveSession: (sessionId: SessionId) => void,
): ReactElement {
  const selected = workspace.id === props.selectedWorkspaceId;
  const expanded = props.expandedWorkspaceIds.includes(workspace.id);
  const summaries = props.sessionSummaries[workspace.id] ?? [];
  const visibleSummaries = summaries.filter(
    (summary) => !archivedSessionIds.has(summary.session.id),
  );
  return createElement(
    "li",
    {
      className: `workspace-list-item${selected ? " workspace-list-item--selected" : ""}`,
      key: workspace.id,
    },
    createElement(
      "div",
      {
        className: "workspace-card",
        "data-folder-path": workspace.canonicalPath,
        title: workspace.canonicalPath,
      },
      createElement(
        "button",
        {
          type: "button",
          className: "workspace-list-button",
          onClick: () =>
            selected
              ? props.onToggleWorkspace(workspace.id)
              : props.onSelectWorkspace(workspace.id),
          "aria-expanded": expanded,
          "aria-current": selected ? "page" : undefined,
          disabled: !props.canNavigate,
        },
        createElement(
          "span",
          { className: "workspace-expander", "aria-hidden": "true" },
          createElement(expanded ? ChevronDown : ChevronRight, { size: 15, strokeWidth: 2.3 }),
        ),
        createElement(expanded ? FolderOpen : Folder, {
          className: "workspace-folder-icon",
          size: 17,
          strokeWidth: 2.1,
          "aria-hidden": true,
        }),
        createElement(
          "span",
          { className: "workspace-list-copy" },
          createElement("strong", null, workspace.displayName),
        ),
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "workspace-forget-button",
          onClick: () => props.onForgetWorkspace(workspace.id),
          title: `从 ${workspace.displayName} 中移除`,
          "aria-label": `从 ${workspace.displayName} 中移除`,
        },
        createElement("img", { src: archiveIcon, alt: "", "aria-hidden": true }),
      ),
    ),
    expanded
      ? createElement(
          "div",
          { className: "workspace-session-group" },
          createElement(
            "button",
            {
              type: "button",
              className: "workspace-new-session-button",
              onClick: () => props.onNewSession(workspace.id),
              disabled: !props.canNavigate,
            },
            createElement(Plus, { size: 14, strokeWidth: 2.4, "aria-hidden": true }),
            createElement("span", null, "新建会话"),
          ),
          props.isDraft && selected
            ? createElement(
                "div",
                { className: "workspace-session-item workspace-session-item--draft" },
                createElement(
                  "span",
                  { className: "workspace-session-glyph" },
                  createElement(CircleDot, { size: 15, strokeWidth: 2.1, "aria-hidden": true }),
                ),
                createElement("span", null, "新会话"),
              )
            : null,
          visibleSummaries.map((summary) =>
            renderSession(props, workspace, summary, onArchiveSession),
          ),
          visibleSummaries.length === 0 && !(props.isDraft && selected)
            ? createElement("p", { className: "workspace-session-empty" }, "还没有会话。")
            : null,
        )
      : null,
  );
}

function renderSession(
  props: WorkspaceSidebarProps,
  workspace: WorkspaceRecord,
  summary: WorkspaceSessionSummary,
  onArchiveSession: (sessionId: SessionId) => void,
): ReactElement {
  const latestRun = summary.latestRun;
  const status = latestRun?.status ?? "PENDING";
  const selected =
    summary.session.id === props.selectedSessionId && workspace.id === props.selectedWorkspaceId;
  const title = derivePromptTitle(latestRun?.goal ?? summary.session.title ?? "新会话");
  return createElement(
    "div",
    {
      className: "workspace-session-row",
      key: summary.session.id,
    },
    createElement(
      "button",
      {
        type: "button",
        className: `workspace-session-item${selected ? " workspace-session-item--selected" : ""}`,
        onClick: () => props.onSelectSession(workspace.id, summary.session.id),
        disabled: !props.canNavigate,
        "aria-current": selected ? "page" : undefined,
      },
      createElement(
        "span",
        {
          className: `session-status-icon ${runStatusClass(status)}`,
          role: "img",
          "aria-label": runStatusLabel(status),
          title: runStatusLabel(status),
        },
        createElement(RunStatusIcon, { status }),
      ),
      createElement("span", { className: "workspace-session-title" }, title),
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "workspace-session-archive-button",
        onClick: () => onArchiveSession(summary.session.id),
        title: `归档会话：${title}（保留记录）`,
        "aria-label": `归档会话：${title}，保留会话记录`,
      },
      createElement("img", { src: archiveIcon, alt: "", "aria-hidden": true }),
    ),
  );
}
