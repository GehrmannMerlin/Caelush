import {
  createElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { LoaderCircle, Pause, Send } from "lucide-react";
import type { WebSessionError, WebSubmissionState } from "../application/session-manager.js";
import type { ContextUsageProjection } from "@caelush/protocol";
import { ContextUsageRing } from "./context-usage-ring.js";

export interface PromptComposerProps {
  readonly disabled: boolean;
  readonly submission: WebSubmissionState;
  readonly error?: WebSessionError | undefined;
  readonly contextUsage?: ContextUsageProjection | null;
  readonly modelReady?: boolean | undefined;
  readonly modelPicker?: ReactElement;
  readonly permissionSelector?: ReactElement;
  readonly onCancel?: (() => Promise<boolean> | void) | undefined;
  readonly cancelling?: boolean | undefined;
  readonly onSubmit: (prompt: string) => Promise<boolean>;
}

export interface PromptSubmitButtonProps {
  readonly disabled: boolean;
  readonly submission: WebSubmissionState;
  readonly modelReady?: boolean | undefined;
  readonly onCancel?: (() => Promise<boolean> | void) | undefined;
  readonly cancelling?: boolean | undefined;
}

export function PromptSubmitButton(props: PromptSubmitButtonProps): ReactElement {
  const canCancel = props.onCancel !== undefined;
  const actionLabel = canCancel
    ? props.cancelling === true
      ? "正在取消任务"
      : "停止任务"
    : submissionLabel(props.submission);

  return createElement(
    "button",
    {
      type: canCancel ? "button" : "submit",
      className: "prompt-submit-button prompt-submit-button--icon",
      onClick: canCancel && props.cancelling !== true ? props.onCancel : undefined,
      disabled: canCancel
        ? props.cancelling === true
        : props.disabled || props.modelReady === false,
      "aria-label": actionLabel,
      title: actionLabel,
    },
    canCancel && props.cancelling !== true
      ? createElement(Pause, { size: 17, strokeWidth: 2.2, "aria-hidden": true })
      : props.submission === "IDLE" && props.cancelling !== true
        ? createElement(Send, { size: 17, strokeWidth: 2.2, "aria-hidden": true })
        : createElement(LoaderCircle, {
            className: "prompt-submit-spinner",
            size: 17,
            strokeWidth: 2.2,
            "aria-hidden": true,
          }),
  );
}

export function shouldSubmitPrompt(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && event.isComposing !== true;
}

export interface PromptTextareaSizing {
  readonly height: number;
  readonly overflowY: "hidden" | "auto";
}

export function getPromptTextareaSizing(
  scrollHeight: number,
  minHeight: number,
  maxHeight: number,
): PromptTextareaSizing {
  const normalizedMinHeight = Number.isFinite(minHeight) ? Math.max(0, minHeight) : 0;
  const normalizedMaxHeight = Number.isFinite(maxHeight)
    ? Math.max(normalizedMinHeight, maxHeight)
    : normalizedMinHeight;
  const contentHeight = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : 0;
  const height = Math.min(normalizedMaxHeight, Math.max(normalizedMinHeight, contentHeight));

  return {
    height,
    overflowY: contentHeight > normalizedMaxHeight ? "auto" : "hidden",
  };
}

export function PromptComposer(props: PromptComposerProps): ReactElement {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;

    textarea.style.height = "auto";
    textarea.style.overflowY = "hidden";
    const computedStyle = window.getComputedStyle(textarea);
    const minHeight = Number.parseFloat(computedStyle.minHeight) || 0;
    const parsedMaxHeight = Number.parseFloat(computedStyle.maxHeight);
    const maxHeight = Number.isFinite(parsedMaxHeight)
      ? parsedMaxHeight
      : Math.max(minHeight, window.innerHeight * 0.42);
    const borderHeight =
      (Number.parseFloat(computedStyle.borderTopWidth) || 0) +
      (Number.parseFloat(computedStyle.borderBottomWidth) || 0);
    const sizing = getPromptTextareaSizing(
      textarea.scrollHeight + borderHeight,
      minHeight,
      maxHeight,
    );

    textarea.style.height = `${sizing.height}px`;
    textarea.style.overflowY = sizing.overflowY;
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, value]);
  useLayoutEffect(() => {
    window.addEventListener("resize", resizeTextarea);
    return () => window.removeEventListener("resize", resizeTextarea);
  }, [resizeTextarea]);
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
      ref: textareaRef,
      className: "prompt-input",
      value,
      onChange: (event) => setValue((event.currentTarget as HTMLTextAreaElement).value),
      onKeyDown,
      disabled: props.disabled,
      placeholder: "输入任务……",
      "aria-label": "任务输入",
      rows: 1,
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
      createElement(PromptSubmitButton, {
        disabled: props.disabled,
        modelReady: props.modelReady,
        submission: props.submission,
        onCancel: props.onCancel,
        cancelling: props.cancelling,
      }),
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
