import {
  createElement,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
} from "react";
import { Files, PanelRightClose, PanelRightOpen, TerminalSquare, Globe2 } from "lucide-react";
import type { DesktopPanelApi } from "../host/desktop-panel-api.js";
import { DesktopFileExplorer } from "./desktop-file-explorer.js";
import { DesktopTerminal } from "./desktop-terminal.js";
import { DesktopBrowserControls } from "./desktop-browser-controls.js";

type DesktopPanelTab = "FILES" | "TERMINAL" | "BROWSER";

export function DesktopWorkspacePanel(props: {
  readonly api: DesktopPanelApi;
  readonly workspaceId: string | null;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<DesktopPanelTab>("FILES");
  const [width, setWidth] = useState(340);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const [activatedWorkspaceId, setActivatedWorkspaceId] = useState<string | null>(null);
  const browserVisible = expanded && tab === "BROWSER";
  const terminalVisible = expanded && tab === "TERMINAL";

  useEffect(() => {
    const frame = panelRef.current?.parentElement;
    if (frame !== null && frame !== undefined) {
      frame.style.setProperty("--desktop-panel-width", expanded ? `${width}px` : "42px");
    }
  }, [expanded, width]);

  useEffect(() => {
    let active = true;
    setActivatedWorkspaceId(null);
    setError(null);
    void props.api.workspace
      .activate({ workspaceId: props.workspaceId })
      .then(() => {
        if (active) setActivatedWorkspaceId(props.workspaceId);
      })
      .catch((activateError: unknown) => {
        if (active) setError(messageOf(activateError, "当前工作区无法在桌面面板中打开。"));
      });
    return () => {
      active = false;
    };
  }, [props.api, props.workspaceId]);

  useEffect(() => {
    if (!expanded) return;
    const widthFromStorage = window.innerWidth;
    setWidth((current) => Math.min(Math.round(widthFromStorage * 0.36), Math.max(280, current)));
  }, [expanded]);

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (!expanded) return;
    event.preventDefault();
    const move = (moveEvent: globalThis.PointerEvent) => {
      const next = Math.min(
        Math.round(window.innerWidth * 0.36),
        Math.max(280, window.innerWidth - moveEvent.clientX),
      );
      setWidth(next);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const label = props.workspaceId === null ? "未选择工作区" : "工作区面板";
  const activeWorkspaceId = activatedWorkspaceId === props.workspaceId ? props.workspaceId : null;
  return createElement(
    "aside",
    {
      ref: panelRef,
      className: `desktop-workspace-panel${expanded ? " is-expanded" : " is-collapsed"}`,
      style: { width: expanded ? `${width}px` : "42px" },
      "aria-label": label,
    },
    expanded
      ? createElement("button", {
          type: "button",
          className: "desktop-panel-resize-grip",
          onPointerDown: startResize,
          title: "拖动调整面板宽度",
          "aria-label": "调整面板宽度",
        })
      : null,
    createElement(
      "div",
      { className: "desktop-panel-heading" },
      expanded ? createElement("strong", null, label) : null,
      createElement(
        "button",
        {
          type: "button",
          className: "desktop-panel-toggle",
          onClick: () => setExpanded((open) => !open),
          title: expanded ? "收起桌面面板" : "展开桌面面板",
          "aria-label": expanded ? "收起桌面面板" : "展开桌面面板",
          "aria-expanded": expanded,
        },
        createElement(expanded ? PanelRightClose : PanelRightOpen, { size: 17 }),
      ),
    ),
    expanded
      ? createElement(
          "div",
          { className: "desktop-panel-body" },
          activeWorkspaceId === null
            ? createElement(
                "div",
                { className: "desktop-panel-empty", role: "status" },
                createElement(
                  "strong",
                  null,
                  props.workspaceId === null ? "未选择工作区" : "正在切换工作区",
                ),
                createElement(
                  "span",
                  null,
                  props.workspaceId === null
                    ? "从左侧工作区列表选择项目，Files 和 Terminal 面板即可使用。"
                    : "正在验证当前 Profile 中的工作区记录…",
                ),
              )
            : null,
          createElement(
            "nav",
            { className: "desktop-panel-tabs", "aria-label": "桌面面板" },
            tabButton("FILES", "文件", Files, tab, setTab),
            tabButton("TERMINAL", "终端", TerminalSquare, tab, (next) => {
              setTab(next);
              if (next === "TERMINAL") setTerminalOpened(true);
            }),
            tabButton("BROWSER", "浏览器", Globe2, tab, setTab),
          ),
          error === null
            ? null
            : createElement("p", { className: "desktop-panel-error", role: "alert" }, error),
          createElement(
            "div",
            { className: "desktop-panel-content" },
            createElement(
              "div",
              { className: "desktop-panel-tab-content", hidden: tab !== "FILES" },
              createElement(DesktopFileExplorer, {
                api: props.api,
                workspaceId: activeWorkspaceId,
              }),
            ),
            terminalOpened
              ? createElement(
                  "div",
                  { className: "desktop-panel-tab-content", hidden: tab !== "TERMINAL" },
                  createElement(DesktopTerminal, {
                    api: props.api,
                    workspaceId: activeWorkspaceId,
                    visible: terminalVisible,
                  }),
                )
              : null,
            createElement(
              "div",
              { className: "desktop-panel-tab-content", hidden: tab !== "BROWSER" },
              createElement(DesktopBrowserControls, { api: props.api, visible: browserVisible }),
            ),
          ),
        )
      : createElement(
          "div",
          { className: "desktop-panel-collapsed-tabs", "aria-label": "桌面面板快捷入口" },
          createElement(
            "button",
            {
              type: "button",
              className: "desktop-panel-tab-icon",
              onClick: () => {
                setTab("FILES");
                setExpanded(true);
              },
              title: "文件",
              "aria-label": "展开文件面板",
            },
            createElement(Files, { size: 16 }),
          ),
          createElement(
            "button",
            {
              type: "button",
              className: "desktop-panel-tab-icon",
              onClick: () => {
                setTab("TERMINAL");
                setTerminalOpened(true);
                setExpanded(true);
              },
              title: "终端",
              "aria-label": "展开终端面板",
            },
            createElement(TerminalSquare, { size: 16 }),
          ),
          createElement(
            "button",
            {
              type: "button",
              className: "desktop-panel-tab-icon",
              onClick: () => {
                setTab("BROWSER");
                setExpanded(true);
              },
              title: "浏览器",
              "aria-label": "展开浏览器面板",
            },
            createElement(Globe2, { size: 16 }),
          ),
        ),
  );
}

function tabButton(
  value: DesktopPanelTab,
  label: string,
  Icon: typeof Files,
  selected: DesktopPanelTab,
  onSelect: (value: DesktopPanelTab) => void,
): ReactElement {
  return createElement(
    "button",
    {
      key: value,
      type: "button",
      role: "tab",
      className: `desktop-panel-tab${selected === value ? " is-active" : ""}`,
      "aria-selected": selected === value,
      onClick: () => onSelect(value),
    },
    createElement(Icon, { size: 14 }),
    label,
  );
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 240)
    : fallback;
}
