import { createElement, type ReactElement } from "react";
import { nonTerminalRuns } from "@caelush/client";
import type {
  WorkspaceId,
  WorkspaceRecord,
  WorkspaceSessionSummary,
  SessionId,
} from "@caelush/protocol";
import { Archive, CircleDot, Folder, FolderKanban, FolderOpen, Plus } from "lucide-react";
import { derivePromptTitle } from "../application/prompt.js";
import { CaelushBrand } from "@caelush/ui-theme/brand";
import type { ResolvedTheme } from "@caelush/ui-theme/appearance";
import { caelushBrandAssets } from "../brand-assets.js";
import archiveIcon from "../assets/icons/archive.svg";
import { RunStatusIcon, runStatusClass, runStatusLabel } from "./run-status.js";
import {
  WorkspaceSidebarFooter,
  type WorkspaceSidebarDesktopActions,
} from "./workspace-sidebar-footer.js";

export {
  WorkspaceSettingsMenu,
  type WorkspaceSettingsMenuProps,
  type WorkspaceSidebarDesktopActions,
} from "./workspace-sidebar-footer.js";

export interface WorkspaceSidebarProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId?: WorkspaceId | undefined;
  readonly expandedWorkspaceIds: readonly WorkspaceId[];
  readonly sessionSummaries: Readonly<Record<string, readonly WorkspaceSessionSummary[]>>;
  readonly selectedSessionId?: SessionId | undefined;
  readonly isDraft: boolean;
  readonly canNavigate: boolean;
  readonly theme?: ResolvedTheme | undefined;
  readonly isOpen?: boolean;
  readonly onToggleWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onSelectWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onNewSession: (workspaceId: WorkspaceId) => void;
  readonly onSelectSession: (workspaceId: WorkspaceId, sessionId: SessionId) => void;
  readonly onAddWorkspace: () => void;
  readonly onArchiveWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onArchiveSession: (sessionId: SessionId) => void;
  readonly onOpenSettings?: () => void;
  readonly onOpenAppearance?: (() => void) | undefined;
  readonly onOpenArchives?: () => void;
  readonly desktopActions?: WorkspaceSidebarDesktopActions | undefined;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps): ReactElement {
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
      createElement(CaelushBrand, {
        kind: "logo",
        theme: props.theme ?? "light",
        lightSrc: caelushBrandAssets.logo.light,
        darkSrc: caelushBrandAssets.logo.dark,
        className: "workspace-sidebar-logo",
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
      props.workspaces.map((workspace) => renderWorkspace(props, workspace)),
    ),
    createElement(WorkspaceSidebarFooter, {
      onOpenArchives: props.onOpenArchives,
      onOpenSettings: props.onOpenSettings,
      onOpenAppearance: props.onOpenAppearance,
      desktopActions: props.desktopActions,
    }),
  );
}

function renderWorkspace(props: WorkspaceSidebarProps, workspace: WorkspaceRecord): ReactElement {
  const selected = workspace.id === props.selectedWorkspaceId;
  const expanded = props.expandedWorkspaceIds.includes(workspace.id);
  const summaries = props.sessionSummaries[workspace.id] ?? [];
  const visibleSummaries = summaries;
  const hasActiveRun = summaries.some(
    (summary) => summary.latestRun !== undefined && nonTerminalRuns([summary.latestRun]).length > 0,
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
        "div",
        { className: "workspace-card-actions" },
        createElement(
          "button",
          {
            type: "button",
            className: "workspace-card-action-button workspace-new-session-icon-button",
            onClick: () => props.onNewSession(workspace.id),
            disabled: !props.canNavigate,
            title: `在工作区“${workspace.displayName}”中新建会话`,
            "aria-label": `在工作区“${workspace.displayName}”中新建会话`,
          },
          createElement(Plus, { size: 16, strokeWidth: 2.2, "aria-hidden": true }),
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "workspace-card-action-button workspace-forget-button",
            onClick: () => props.onArchiveWorkspace(workspace.id),
            disabled: hasActiveRun || !props.canNavigate,
            title: hasActiveRun ? "请先结束任务，再归档" : `归档工作区：${workspace.displayName}`,
            "aria-label": `归档工作区：${workspace.displayName}`,
          },
          createElement(Archive, { size: 16, strokeWidth: 2, "aria-hidden": true }),
        ),
      ),
    ),
    expanded
      ? createElement(
          "div",
          { className: "workspace-session-group" },
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
          visibleSummaries.map((summary) => renderSession(props, workspace, summary)),
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
): ReactElement {
  const latestRun = summary.latestRun;
  const status = latestRun?.status ?? "PENDING";
  const selected =
    summary.session.id === props.selectedSessionId && workspace.id === props.selectedWorkspaceId;
  const title = derivePromptTitle(latestRun?.goal ?? summary.session.title ?? "新会话");
  const showStatusIcon = status === "RUNNING" || status === "VERIFYING" || status === "FAILED";
  const statusIcon = showStatusIcon
    ? createElement(
        "span",
        {
          className: `session-status-icon ${runStatusClass(status)}`,
          role: "img",
          "aria-label": runStatusLabel(status),
          title: runStatusLabel(status),
        },
        createElement(RunStatusIcon, { status }),
      )
    : null;
  const sessionItemClasses = ["workspace-session-item"];
  if (selected) sessionItemClasses.push("workspace-session-item--selected");
  if (!showStatusIcon) sessionItemClasses.push("workspace-session-item--statusless");
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
        className: sessionItemClasses.join(" "),
        onClick: () => props.onSelectSession(workspace.id, summary.session.id),
        disabled: !props.canNavigate,
        "aria-current": selected ? "page" : undefined,
      },
      statusIcon,
      createElement("span", { className: "workspace-session-title" }, title),
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "workspace-session-archive-button",
        onClick: () => props.onArchiveSession(summary.session.id),
        disabled:
          !props.canNavigate ||
          (latestRun !== undefined && nonTerminalRuns([latestRun]).length > 0),
        title:
          latestRun !== undefined && nonTerminalRuns([latestRun]).length > 0
            ? "请先结束任务，再归档"
            : `归档会话：${title}（保留记录）`,
        "aria-label": `归档会话：${title}，保留会话记录`,
      },
      createElement("img", { src: archiveIcon, alt: "", "aria-hidden": true }),
    ),
  );
}
