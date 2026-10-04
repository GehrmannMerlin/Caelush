import {
  createElement,
  useCallback,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { LoaderCircle, Send } from "lucide-react";
import type { WebSessionError, WebSubmissionState } from "../application/session-manager.js";
import type { ContextUsageProjection } from "@caelush/protocol";
import { ContextUsageRing } from "./context-usage-ring.js";

export interface PromptComposerProps {
  readonly disabled: boolean;
  readonly submission: WebSubmissionState;
  readonly error?: WebSessionError | undefined;
  readonly contextUsage?: ContextUsageProjection | null;
  readonly modelReady?: boolean;
  readonly modelPicker?: ReactElement;
  readonly permissionSelector?: ReactElement;
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
    if (props.disabled || props.modelReady === false) return;
    const accepted = await props.onSubmit(value);
    if (accepted) setValue("");
  }, [props.disabled, props.modelReady, props.onSubmit, value]);
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
      createElement(
        "div",
        { className: "prompt-composer-context-controls" },
        createElement(ContextUsageRing, { usage: props.contextUsage ?? null }),
        props.permissionSelector ?? null,
      ),
      createElement("span", { className: "prompt-hint" }, "Enter 发送 · Shift + Enter 换行"),
      props.modelPicker ?? null,
      createElement(
        "button",
        {
          type: "submit",
          className: "prompt-submit-button prompt-submit-button--icon",
          disabled: props.disabled || props.modelReady === false,
          "aria-label": submissionLabel(props.submission),
          title: submissionLabel(props.submission),
        },
        props.submission === "IDLE"
          ? createElement(Send, { size: 17, strokeWidth: 2.2, "aria-hidden": true })
          : createElement(LoaderCircle, {
              className: "prompt-submit-spinner",
              size: 17,
              strokeWidth: 2.2,
              "aria-hidden": true,
            }),
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
      return "发送任务";
  }
}
