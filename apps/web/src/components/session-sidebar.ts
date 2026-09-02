import { createElement, type ReactElement } from "react";
import type { SessionCandidate } from "@caelush/client";
import type { SessionId } from "@caelush/protocol";
import { derivePromptTitle } from "../application/prompt.js";
import { runStatusClass, runStatusLabel } from "./run-status.js";

export interface SessionSidebarProps {
  readonly candidates: readonly SessionCandidate[];
  readonly selectedSessionId?: SessionId | undefined;
  readonly isDraft: boolean;
  readonly canInteract: boolean;
  readonly onNewSession: () => void;
  readonly onSelectSession: (sessionId: SessionId) => void;
}

export function sessionDisplayTitle(candidate: SessionCandidate): string {
  return derivePromptTitle(candidate.latestRun?.goal ?? candidate.session.title ?? "新会话");
}

export function SessionSidebar(props: SessionSidebarProps): ReactElement {
  const draftItem = props.isDraft
    ? createElement(
        "li",
        { className: "session-list-item session-list-item--draft" },
        createElement(
          "button",
          {
            type: "button",
            className: "session-list-button session-list-button--selected",
            disabled: true,
            "aria-current": "page",
          },
          createElement("span", { className: "session-list-title" }, "新会话"),
          createElement("span", { className: "session-list-meta" }, "尚未开始"),
        ),
      )
    : null;

  return createElement(
    "aside",
    { className: "session-sidebar", "aria-label": "会话列表" },
    createElement(
      "div",
      { className: "session-sidebar-heading" },
      createElement("h2", null, "会话"),
      createElement(
        "button",
        {
          type: "button",
          className: "new-session-button",
          onClick: props.onNewSession,
          disabled: !props.canInteract,
        },
        createElement("span", { "aria-hidden": "true" }, "+"),
        " 新建会话",
      ),
    ),
    createElement(
      "ol",
      { className: "session-list" },
      draftItem,
      props.candidates.map((candidate) => {
        const selected = candidate.session.id === props.selectedSessionId;
        const latestRun = candidate.latestRun;
        return createElement(
          "li",
          { className: "session-list-item", key: candidate.session.id },
          createElement(
            "button",
            {
              type: "button",
              className: `session-list-button${selected ? " session-list-button--selected" : ""}`,
              onClick: () => props.onSelectSession(candidate.session.id),
              disabled: !props.canInteract,
              "aria-current": selected ? "page" : undefined,
            },
            createElement(
              "span",
              { className: "session-list-title" },
              sessionDisplayTitle(candidate),
            ),
            createElement(
              "span",
              {
                className: latestRun
                  ? `session-list-meta ${runStatusClass(latestRun.status)}`
                  : "session-list-meta",
              },
              latestRun === undefined ? "未运行" : runStatusLabel(latestRun.status),
            ),
          ),
        );
      }),
    ),
    props.candidates.length === 0 && !props.isDraft
      ? createElement("p", { className: "session-empty" }, "还没有会话。")
      : null,
  );
}
