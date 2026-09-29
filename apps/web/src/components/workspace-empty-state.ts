import { createElement, type ReactElement } from "react";

export function WorkspaceEmptyState(props: {
  readonly hasWorkspaces: boolean;
  readonly onAddWorkspace: () => void;
}): ReactElement {
  return createElement(
    "section",
    { className: "workspace-empty-state", "aria-live": "polite" },
    createElement("p", { className: "workspace-empty-kicker" }, "WORKSPACE REGISTRY"),
    createElement("h1", null, props.hasWorkspaces ? "请选择一个工作区" : "还没有工作区"),
    createElement(
      "p",
      null,
      props.hasWorkspaces
        ? "从左侧项目中选择工作区，查看它自己的会话。"
        : "添加一个本地项目目录后，就可以开始新的会话。",
    ),
    createElement(
      "button",
      { type: "button", className: "workspace-empty-action", onClick: props.onAddWorkspace },
      "添加工作区",
    ),
  );
}
