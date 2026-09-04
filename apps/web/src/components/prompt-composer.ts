import {
  createElement,
  useCallback,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import type { WebSessionError, WebSubmissionState } from "../application/session-manager.js";
import type { ContextUsageProjection } from "@caelush/protocol";
import { ContextUsageRing } from "./context-usage-ring.js";

export interface PromptComposerProps {
  readonly disabled: boolean;
  readonly submission: WebSubmissionState;
  readonly error?: WebSessionError | undefined;
  readonly contextUsage?: ContextUsageProjection | null;
  readonly onSubmit: (prompt: string) => Promise<boolean>;
}

export function shouldSubmitPrompt(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && event.isComposing !== true;
}

export function PromptComposer(props: PromptComposerProps): ReactElement {
  const [value, setValue] = useState("");
  const submit = useCallback(async () => {
    if (props.disabled) return;
    const accepted = await props.onSubmit(value);
    if (accepted) setValue("");
  }, [props.disabled, props.onSubmit, value]);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitPrompt(event)) return;
    event.preventDefault();
    void submit();
  };

  return createElement(
    "form",
    { className: "prompt-composer", onSubmit },
    createElement("textarea", {
      className: "prompt-input",
      value,
      onChange: (event) => setValue((event.currentTarget as HTMLTextAreaElement).value),
      onKeyDown,
      disabled: props.disabled,
      placeholder: "输入任务……",
      "aria-label": "任务输入",
      rows: 3,
    }),
    createElement(
      "div",
      { className: "prompt-composer-footer" },
      createElement(ContextUsageRing, { usage: props.contextUsage ?? null }),
      createElement("span", { className: "prompt-hint" }, "Enter 发送 · Shift + Enter 换行"),
      createElement(
        "button",
        {
          type: "submit",
          className: "prompt-submit-button",
          disabled: props.disabled,
        },
        submissionLabel(props.submission),
      ),
    ),
    props.error === undefined
      ? null
      : createElement("p", { className: "web-error", role: "alert" }, props.error.message),
  );
}

function submissionLabel(submission: WebSubmissionState): string {
  switch (submission) {
    case "SUBMITTING":
      return "正在创建任务";
    case "RUN_CREATED":
      return "任务已创建";
    case "STARTING":
      return "正在启动";
    case "ACTIVE":
      return "运行中";
    case "IDLE":
      return "运行 →";
  }
}
