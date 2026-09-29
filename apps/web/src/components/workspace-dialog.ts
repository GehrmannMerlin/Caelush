import { createElement, type FormEvent, type ReactElement } from "react";

export interface WorkspaceDialogProps {
  readonly path: string;
  readonly isPicking: boolean;
  readonly error?: string | undefined;
  readonly onClose: () => void;
  readonly onPick: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function WorkspaceDialog(props: WorkspaceDialogProps): ReactElement {
  const hasPath = props.path.trim().length > 0;
  return createElement(
    "div",
    { className: "workspace-dialog-backdrop", role: "presentation" },
    createElement(
      "form",
      {
        className: "workspace-dialog",
        onSubmit: props.onSubmit,
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "workspace-dialog-title",
      },
      createElement("h2", { id: "workspace-dialog-title" }, "添加工作区"),
      createElement("p", null, "选择一个本机项目文件夹。不会复制、移动或删除目录中的文件。"),
      createElement("span", { className: "workspace-picker-label" }, "项目文件夹"),
      createElement(
        "div",
        { className: "workspace-picker" },
        createElement(
          "button",
          {
            type: "button",
            className: "workspace-picker-button",
            onClick: props.onPick,
            disabled: props.isPicking,
          },
          createElement("span", { "aria-hidden": "true" }, "▣"),
          props.isPicking ? "正在打开文件夹选择器…" : "选择文件夹",
        ),
        createElement(
          "div",
          {
            className: `workspace-picker-selection${hasPath ? "" : " workspace-picker-selection--empty"}`,
            "aria-live": "polite",
          },
          createElement(
            "code",
            { className: "workspace-picker-path" },
            hasPath ? props.path : "尚未选择文件夹",
          ),
        ),
      ),
      props.error === undefined
        ? null
        : createElement("p", { className: "workspace-dialog-error", role: "alert" }, props.error),
      createElement(
        "div",
        { className: "workspace-dialog-actions" },
        createElement(
          "button",
          { type: "button", className: "workspace-dialog-cancel", onClick: props.onClose },
          "取消",
        ),
        createElement(
          "button",
          {
            type: "submit",
            className: "workspace-dialog-submit",
            disabled: !hasPath || props.isPicking,
          },
          "添加",
        ),
      ),
    ),
  );
}
