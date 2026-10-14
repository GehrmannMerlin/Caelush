import { createElement, type ReactElement } from "react";
import type { WorkspaceId, WorkspaceRecord } from "@caelush/protocol";
import { ConversationStartPanel } from "./conversation-start-panel.js";

export function WorkspaceEmptyState(props: {
  readonly hasWorkspaces: boolean;
  readonly workspaces?: readonly WorkspaceRecord[] | undefined;
  readonly selectedWorkspaceId?: WorkspaceId | undefined;
  readonly disabled?: boolean | undefined;
  readonly onAddWorkspace: () => void;
  readonly onSelectWorkspace?: ((workspaceId: WorkspaceId) => void) | undefined;
  readonly composer?: ReactElement | undefined;
}): ReactElement {
  return createElement(
    "section",
    {
      className: "workspace-empty-state workspace-empty-state--no-workspace",
      "aria-label": props.hasWorkspaces ? "选择工作区开始对话" : "添加工作区开始对话",
    },
    createElement(ConversationStartPanel, {
      composer:
        props.composer ?? createElement("div", { className: "conversation-composer-placeholder" }),
      workspaces: props.workspaces,
      selectedWorkspaceId: props.selectedWorkspaceId,
      disabled: props.disabled,
      onAddWorkspace: props.onAddWorkspace,
      onSelectWorkspace: props.onSelectWorkspace ?? (() => undefined),
    }),
  );
}
