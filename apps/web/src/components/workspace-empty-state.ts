import { createElement, type ReactElement } from "react";
import caelushLogo from "../assets/logo/caelush-logo.png";

export function WorkspaceEmptyState(props: {
  readonly hasWorkspaces: boolean;
  readonly onAddWorkspace: () => void;
}): ReactElement {
  const hasNoWorkspace = !props.hasWorkspaces;

  return createElement(
    "section",
    {
      className: `workspace-empty-state${
        hasNoWorkspace ? " workspace-empty-state--no-workspace" : ""
      }`,
      "aria-live": "polite",
    },
    hasNoWorkspace
      ? createElement(
          "div",
          { className: "workspace-empty-welcome" },
          createElement("img", {
            className: "workspace-empty-logo",
            src: caelushLogo,
            alt: "Caelush",
          }),
          createElement("p", { className: "workspace-empty-slogan" }, "保持对未知的探索热情"),
          createElement(
            "button",
            {
              type: "button",
              className: "workspace-empty-action",
              onClick: props.onAddWorkspace,
            },
            "创建工作区",
          ),
        )
      : createElement(
          "div",
          { className: "workspace-empty-selection" },
          createElement("p", { className: "workspace-empty-kicker" }, "WORKSPACE REGISTRY"),
          createElement("h1", null, "请选择一个工作区"),
          createElement("p", null, "从左侧项目中选择工作区，查看它自己的会话。"),
          createElement(
            "button",
            { type: "button", className: "workspace-empty-action", onClick: props.onAddWorkspace },
            "添加工作区",
          ),
        ),
  );
}
