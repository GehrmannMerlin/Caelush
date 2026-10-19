import { createElement, useEffect, useRef, type ReactElement, type Ref } from "react";
import { FilePlus2 } from "lucide-react";

export interface AttachmentMenuProps {
  readonly onChooseFiles: () => void;
  readonly containerRef?: Ref<HTMLDivElement> | undefined;
}

export function AttachmentMenu(props: AttachmentMenuProps): ReactElement {
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => uploadButtonRef.current?.focus(), []);
  return createElement(
    "div",
    {
      className: "attachment-menu",
      id: "prompt-attachment-menu",
      ref: props.containerRef,
      role: "menu",
      "aria-label": "添加",
    },
    createElement("span", { className: "attachment-menu-heading" }, "添加"),
    createElement(
      "div",
      { className: "attachment-menu-items" },
      createElement(
        "button",
        {
          type: "button",
          className: "attachment-menu-item",
          ref: uploadButtonRef,
          role: "menuitem",
          onClick: props.onChooseFiles,
        },
        createElement(FilePlus2, { size: 17, "aria-hidden": true }),
        createElement("span", null, "上传文件"),
      ),
    ),
    createElement(
      "p",
      { className: "attachment-menu-hint" },
      "也可以将文件拖到输入框，或粘贴截图。",
    ),
  );
}
