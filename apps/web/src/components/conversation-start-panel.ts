import { createElement, type ReactElement } from "react";
import type { WorkspaceId, WorkspaceRecord } from "@caelush/protocol";
import caelushLogo from "../assets/logo/caelush-logo.png";
import { WorkspacePicker } from "./workspace-picker.js";

export interface ConversationStartPanelProps {
  readonly composer: ReactElement;
  readonly workspaces?: readonly WorkspaceRecord[] | undefined;
  readonly selectedWorkspaceId?: WorkspaceId | undefined;
  readonly workspaceName?: string | undefined;
  readonly isSettled?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly onAddWorkspace: () => void;
  readonly onSelectWorkspace: (workspaceId: WorkspaceId) => void;
}

export function ConversationStartPanel(props: ConversationStartPanelProps): ReactElement {
  const isSettled = props.isSettled === true;

  return createElement(
    "div",
    {
      className: isSettled
        ? "conversation-start-panel conversation-start-panel--settled"
        : "conversation-start-panel",
    },
    createElement(
      "div",
      { className: "conversation-start-brand", "aria-hidden": isSettled },
      createElement("img", { src: caelushLogo, alt: "Caelush" }),
    ),
    createElement(
      "div",
      { className: "conversation-start-controls", "aria-hidden": isSettled },
      createElement(WorkspacePicker, {
        workspaces: props.workspaces ?? [],
        selectedWorkspaceId: props.selectedWorkspaceId,
        fallbackWorkspaceName: props.workspaceName,
        disabled: props.disabled,
        onAddWorkspace: props.onAddWorkspace,
        onSelectWorkspace: props.onSelectWorkspace,
      }),
    ),
    createElement("div", { className: "conversation-composer-region" }, props.composer),
  );
}
