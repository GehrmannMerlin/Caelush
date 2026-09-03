import { createElement, type ReactElement } from "react";
import type { RunId, RunStatus } from "@caelush/protocol";
import type { WebControlMode } from "../application/session-manager.js";

export interface RecoveryRunView {
  readonly id: RunId;
  readonly goal: string;
  readonly status: RunStatus;
  readonly createdAt: number;
}

export interface RecoveryPanelProps {
  readonly mode: Extract<WebControlMode, "RECOVERY_PICKER" | "PENDING_RUN_CONFIRMATION">;
  readonly runs: readonly RecoveryRunView[];
  readonly onSelectRun: (runId: RunId) => Promise<boolean> | void;
  readonly onConfirmPending: (runId: RunId) => Promise<boolean> | void;
}

export function RecoveryPanel(props: RecoveryPanelProps): ReactElement {
  const pending = props.mode === "PENDING_RUN_CONFIRMATION";
  return createElement(
    "section",
    { className: "recovery-panel", "aria-labelledby": "recovery-title" },
    createElement("h2", { id: "recovery-title" }, pending ? "确认启动任务" : "选择要恢复的任务"),
    createElement(
      "ul",
      { className: "recovery-run-list" },
      props.runs.map((run) =>
        createElement(
          "li",
          { key: run.id, className: "recovery-run" },
          createElement("strong", null, boundedGoal(run.goal)),
          createElement("span", null, run.status),
          createElement(
            "time",
            { dateTime: new Date(run.createdAt).toISOString() },
            new Date(run.createdAt).toLocaleString("zh-CN"),
          ),
          createElement("code", null, run.id),
          createElement(
            "button",
            {
              type: "button",
              onClick: () =>
                void (pending ? props.onConfirmPending(run.id) : props.onSelectRun(run.id)),
            },
            pending ? "确认启动" : "恢复此任务",
          ),
        ),
      ),
    ),
  );
}

function boundedGoal(goal: string): string {
  const bytes = new TextEncoder().encode(goal);
  if (bytes.byteLength <= 2 * 1024) return goal;
  return new TextDecoder().decode(bytes.slice(0, 2 * 1024)).replace(/\uFFFD$/u, "");
}
