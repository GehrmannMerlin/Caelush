import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type DragEvent,
  type ClipboardEvent,
  type ReactElement,
} from "react";
import { CornerDownLeft, LoaderCircle, Pause, Plus, Send } from "lucide-react";
import type { WebSessionError, WebSubmissionState } from "../application/session-manager.js";
import {
  resolvePromptPrimaryAction,
  type PromptPrimaryAction,
} from "../application/composer-state.js";
import type { ContextUsageProjection, AttachmentId, AttachmentOwner } from "@caelush/protocol";
import { ContextUsageRing } from "./context-usage-ring.js";
import type { AttachmentQueueItem } from "../application/attachment-manager.js";
import type { WebRunInputItem } from "../application/run-input-state.js";
import { AttachmentList } from "./attachment-list.js";
import { AttachmentMenu } from "./attachment-menu.js";

export interface PromptComposerProps {
  readonly disabled: boolean;
  readonly submission: WebSubmissionState;
  readonly error?: WebSessionError | undefined;
  readonly contextUsage?: ContextUsageProjection | null;
  readonly modelReady?: boolean | undefined;
  readonly placeholder?: string | undefined;
  readonly modelPicker?: ReactElement;
  readonly permissionSelector?: ReactElement;
  readonly draftText?: string | undefined;
  readonly draftLoading?: boolean | undefined;
  readonly attachments?: readonly AttachmentQueueItem[] | undefined;
  readonly attachmentSubmitBlockedReason?: string | undefined;
  readonly onDraftChange?: ((text: string) => void) | undefined;
  readonly onAddFiles?: ((files: readonly File[]) => void) | undefined;
  readonly onRemoveAttachment?: ((id: string) => void) | undefined;
  readonly onRetryAttachment?: ((id: string) => void) | undefined;
  readonly onLoadAttachmentPreview?:
    ((artifactId: AttachmentId, owner: AttachmentOwner) => Promise<Blob>) | undefined;
  readonly onCancel?: (() => Promise<boolean> | void) | undefined;
  readonly cancelling?: boolean | undefined;
  readonly onSubmit: (prompt: string) => Promise<boolean>;
  /**
   * Whether the composer may be typed into.
   *
   * Editing is independent of every action below it: an active Run, a pending approval and a retry
   * backoff all still allow the user to compose the correction they are about to send.
   */
  readonly editable?: boolean | undefined;
  /** Send the current text into the Run already in progress, when that Run supports it. */
  readonly onSteer?: ((text: string) => Promise<boolean>) | undefined;
  readonly steeringAvailable?: boolean | undefined;
  /** Whether the *new task* action is currently allowed (an active Run blocks it, editing does not). */
  readonly submitDisabled?: boolean | undefined;
  /** Accepted corrections still waiting to be applied, shown above the input. */
  readonly runInputs?: readonly WebRunInputItem[] | undefined;
}

export interface PromptSubmitButtonProps {
  readonly action?: PromptPrimaryAction | undefined;
  readonly disabled: boolean;
  readonly submission: WebSubmissionState;
  readonly modelReady?: boolean | undefined;
  readonly onSteer?: (() => Promise<boolean> | void) | undefined;
  readonly onCancel?: (() => Promise<boolean> | void) | undefined;
  readonly cancelling?: boolean | undefined;
}

export function PromptSubmitButton(props: PromptSubmitButtonProps): ReactElement {
  const action = props.action ?? (props.onCancel === undefined ? "SEND" : "PAUSE");
  const actionLabel =
    action === "STEER"
      ? "发送补充"
      : action === "PAUSE"
        ? props.cancelling === true
          ? "正在取消任务"
          : "停止任务"
        : submissionLabel(props.submission);

  return createElement(
    "button",
    {
      type: action === "SEND" ? "submit" : "button",
      className: "prompt-submit-button prompt-submit-button--icon",
      onClick:
        action === "STEER"
          ? props.onSteer
          : action === "PAUSE" && props.cancelling !== true
            ? props.onCancel
            : undefined,
      disabled:
        action === "PAUSE"
          ? props.onCancel === undefined || props.cancelling === true
          : props.disabled ||
            (action === "STEER" ? props.onSteer === undefined : props.modelReady === false),
      "aria-label": actionLabel,
      title: action === "STEER" ? "发送补充（Enter）" : actionLabel,
    },
    action === "STEER"
      ? createElement(CornerDownLeft, {
          size: 17,
          strokeWidth: 2.2,
          "aria-hidden": true,
        })
      : action === "PAUSE" && props.cancelling !== true
        ? createElement(Pause, { size: 17, strokeWidth: 2.2, "aria-hidden": true })
        : action === "SEND" && props.submission === "IDLE"
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
  const [localValue, setLocalValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuScopeRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controlled = props.draftText !== undefined;
  const value = controlled ? props.draftText! : localValue;
  // The latest text, read after an await so a submission never clears characters the user typed
  // while the request was in flight.
  const latestValue = useRef(value);
  latestValue.current = value;
  const setValue = useCallback(
    (next: string) => {
      if (!controlled) setLocalValue(next);
      props.onDraftChange?.(next);
    },
    [controlled, props.onDraftChange],
  );
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
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        menuScopeRef.current?.contains(target) === true ||
        menuRef.current?.contains(target) === true
      ) {
        return;
      }
      setMenuOpen(false);
      plusButtonRef.current?.focus();
    };
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      plusButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [menuOpen]);
  const steer = props.steeringAvailable === true && props.onSteer !== undefined;
  const submitBlocked = props.submitDisabled === true;
  const primaryAction = resolvePromptPrimaryAction({
    steeringAvailable: steer && props.cancelling !== true,
    hasText: value.trim().length > 0,
    canCancel: props.onCancel !== undefined,
  });
  const submitNewTask = useCallback(async () => {
    if (
      props.disabled ||
      props.draftLoading === true ||
      steer ||
      submitBlocked
    ) {
      return;
    }
    const submitted = value;
    const accepted = await props.onSubmit(submitted);
    // Only the version that was actually accepted is cleared. Text typed during the request — and
    // an attachment draft stays exactly as it is.
    if (accepted && latestValue.current === submitted) setValue("");
  }, [
    props.disabled,
    props.draftLoading,
    props.onSubmit,
    setValue,
    steer,
    submitBlocked,
    value,
  ]);
  const submitRunInput = useCallback(async () => {
    if (
      props.disabled ||
      props.draftLoading === true ||
      props.cancelling === true ||
      !steer ||
      value.trim().length === 0
    ) {
      return;
    }
    const submitted = value;
    const accepted = await props.onSteer!(submitted);
    // A newer draft typed while the request was in flight must remain available for the next steer.
    if (accepted && latestValue.current === submitted) setValue("");
  }, [props.disabled, props.draftLoading, props.cancelling, props.onSteer, setValue, steer, value]);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitNewTask();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitPrompt(event)) return;
    event.preventDefault();
    if (primaryAction === "STEER") void submitRunInput();
    else if (primaryAction === "SEND") void submitNewTask();
  };
  const addFiles = (files: readonly File[]) => {
    if (
      props.disabled !== true &&
      props.draftLoading !== true &&
      // A Run in progress accepts text only; adding a file here would create a draft this path
      // cannot send and cannot honestly promise.
      steer !== true &&
      files.length > 0
    ) {
      props.onAddFiles?.(files);
    }
  };
  const onDragEnter = (event: DragEvent<HTMLFormElement>) => {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDraggingFiles(true);
  };
  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingFiles(false);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDraggingFiles(false);
    addFiles(Array.from(event.dataTransfer.files));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length === 0) return;
    event.preventDefault();
    addFiles(imageFiles);
  };
  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) queueMicrotask(() => plusButtonRef.current?.focus());
  };
  const openFilePicker = () => {
    closeMenu(true);
    fileInputRef.current?.click();
  };
  const fileInput = createElement("input", {
    ref: fileInputRef,
    className: "prompt-attachment-file-input",
    type: "file",
    multiple: true,
    accept:
      ".txt,.md,.markdown,.rst,.log,.csv,.tsv,.json,.jsonl,.xml,.svg,.yaml,.yml,.toml,.ini,.conf,.config,.env,.html,.htm,.css,.scss,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.py,.pyi,.go,.rs,.java,.kt,.kts,.c,.h,.cc,.cpp,.hpp,.cs,.fs,.fsx,.php,.rb,.rake,.swift,.sh,.bash,.zsh,.ps1,.sql,.graphql,.gql,.proto,.dockerfile,.makefile,.gradle,.properties,.bat,.cmd,.vue,.svelte,.astro,.lock,.png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.xlsx",
    onChange: (event: { currentTarget: HTMLInputElement }) => {
      addFiles(Array.from(event.currentTarget.files ?? []));
      event.currentTarget.value = "";
      closeMenu(true);
    },
    tabIndex: -1,
    "aria-hidden": true,
  });
  return createElement(
    "form",
    {
      className: `prompt-composer${draggingFiles ? " prompt-composer--dragging" : ""}`,
      onSubmit,
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop,
    },
    createElement(RunInputPendingList, {
      items: props.runInputs ?? [],
    }),
    createElement(AttachmentList, {
      items: props.attachments ?? [],
      onRemove: (id) => props.onRemoveAttachment?.(id),
      onRetry: props.onRetryAttachment,
      onLoadPreview: props.onLoadAttachmentPreview,
    }),
    createElement("textarea", {
      ref: textareaRef,
      className: "prompt-input",
      value,
      onChange: (event) => setValue((event.currentTarget as HTMLTextAreaElement).value),
      onKeyDown,
      onPaste,
      disabled: props.disabled || props.draftLoading === true || props.editable === false,
      placeholder:
        props.placeholder ??
        (steer ? "补充或纠正本轮任务，Enter 发送，Shift+Enter 换行" : "输入任务……"),
      "aria-label": "任务输入",
      rows: 1,
    }),
    createElement(
      "div",
      { className: "prompt-composer-footer" },
      createElement(
        "div",
        { className: "prompt-composer-left-controls" },
        createElement(
          "div",
          { className: "prompt-composer-attachment-trigger", ref: menuScopeRef },
          createElement(
            "button",
            {
              type: "button",
              ref: plusButtonRef,
              className: "prompt-attachment-button",
              disabled:
                props.disabled ||
                props.draftLoading === true ||
                steer === true ||
                props.onAddFiles === undefined,
              onClick: () => setMenuOpen((open) => !open),
              "aria-label": "添加附件",
              "aria-expanded": menuOpen,
              "aria-haspopup": "menu",
              "aria-controls": "prompt-attachment-menu",
              title: "添加附件",
            },
            createElement(Plus, { size: 18, strokeWidth: 2, "aria-hidden": true }),
          ),
        ),
        props.permissionSelector ?? null,
      ),
      createElement(ContextUsageRing, { usage: props.contextUsage ?? null }),
      createElement(
        "div",
        { className: "prompt-composer-right-controls" },
        props.modelPicker ?? null,
        createElement(PromptSubmitButton, {
          action: primaryAction,
          disabled:
            props.disabled ||
            props.draftLoading === true ||
            (primaryAction === "SEND" &&
              (submitBlocked || props.attachmentSubmitBlockedReason !== undefined)),
          modelReady: props.modelReady,
          submission: props.submission,
          onSteer: primaryAction === "STEER" ? () => void submitRunInput() : undefined,
          onCancel: primaryAction === "PAUSE" ? props.onCancel : undefined,
          cancelling: props.cancelling,
        }),
      ),
    ),
    menuOpen
      ? createElement(AttachmentMenu, {
          onChooseFiles: openFilePicker,
          containerRef: menuRef,
        })
      : null,
    fileInput,
    steer && (props.attachments ?? []).length > 0
      ? createElement(
          "p",
          { className: "attachment-submit-warning", role: "status" },
          "本轮补充仅支持文字；附件仍保留在草稿中。",
        )
      : null,
    props.attachmentSubmitBlockedReason === undefined
      ? null
      : createElement(
          "p",
          { className: "attachment-submit-warning", role: "status" },
          props.attachmentSubmitBlockedReason,
        ),
    props.draftLoading === true
      ? createElement(
          "span",
          { className: "prompt-draft-loading", role: "status" },
          "正在恢复草稿…",
        )
      : null,
    props.error === undefined
      ? null
      : createElement("p", { className: "web-error", role: "alert" }, props.error.message),
  );
}

function containsFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
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

/**
 * Keep only corrections still in flight or queued for a boundary above the composer.
 *
 * Rejected text remains in the editable draft/error path; recorded or assigned text belongs to the
 * canonical Transcript and is removed here to avoid presenting it twice.
 */
function RunInputPendingList(props: {
  readonly items: readonly WebRunInputItem[];
}): ReactElement | null {
  const visible = props.items.filter(
    (item) => item.stage === "SENDING" || item.stage === "PENDING",
  );
  if (visible.length === 0) return null;
  return createElement(
    "section",
    { className: "run-input-pending", role: "region", "aria-label": "待应用的补充" },
    visible.map((item) =>
      createElement(
        "p",
        {
          key: item.inputId,
          className: `run-input-pending-item run-input-pending-item--${item.stage.toLowerCase()}`,
        },
        item.text,
      ),
    ),
  );
}
