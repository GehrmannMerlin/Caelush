import { Check, ChevronDown, Copy } from "lucide-react";
import { createElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const useLayoutEffectWhenRendered = typeof window === "undefined" ? useEffect : useLayoutEffect;

export const USER_MESSAGE_COLLAPSED_CONTENT_HEIGHT_PX = 456;
export const USER_MESSAGE_COPY_FEEDBACK_DURATION_MS = 2000;
const USER_MESSAGE_EXPANDED_ACTION_SPACE_PX = 34;

type ClipboardWriter = Pick<Clipboard, "writeText">;

export async function copyUserMessageText(
  text: string,
  clipboard: ClipboardWriter | undefined,
  legacyCopy: (text: string) => boolean,
): Promise<void> {
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Clipboard permissions can be unavailable in embedded and non-secure web hosts.
    }
  }

  try {
    if (legacyCopy(text)) return;
  } catch {
    // Report one stable failure to the component if both browser paths are unavailable.
  }

  throw new Error("Unable to copy user message");
}

function copyWithExecCommand(text: string): boolean {
  if (typeof document === "undefined" || document.body === null) return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-10000px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export function isUserMessageContentOverflowing(scrollHeight: number): boolean {
  return scrollHeight > USER_MESSAGE_COLLAPSED_CONTENT_HEIGHT_PX;
}

export function UserMessageBubble(props: { readonly text: string }) {
  const bubbleId = useId();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLParagraphElement>(null);
  const copyLockedRef = useRef(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"COPIED" | "FAILED" | undefined>();

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current !== undefined) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );

  useLayoutEffectWhenRendered(() => {
    const measureOverflow = () => {
      const content = contentRef.current;
      if (content === null) return;
      const contentHeight =
        content.scrollHeight - (isExpanded ? USER_MESSAGE_EXPANDED_ACTION_SPACE_PX : 0);
      const overflowing = isUserMessageContentOverflowing(contentHeight);
      setIsOverflowing(overflowing);
      if (!overflowing) setIsExpanded(false);
    };

    measureOverflow();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measureOverflow);
    if (observer !== undefined) {
      if (bubbleRef.current !== null) observer.observe(bubbleRef.current);
    } else {
      window.addEventListener("resize", measureOverflow);
    }
    return () => {
      observer?.disconnect();
      if (observer === undefined) window.removeEventListener("resize", measureOverflow);
    };
  }, [isExpanded, props.text]);

  const collapsed = isOverflowing && !isExpanded;
  const bubbleClassName = [
    "turn-presentation-user-bubble",
    collapsed ? "turn-presentation-user-bubble--collapsed" : "",
    isOverflowing && isExpanded ? "turn-presentation-user-bubble--expanded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const copyMessage = async () => {
    if (copyLockedRef.current) return;
    copyLockedRef.current = true;
    setCopyStatus(undefined);

    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      await copyUserMessageText(props.text, clipboard, copyWithExecCommand);
      setCopyStatus("COPIED");
      copyFeedbackTimerRef.current = setTimeout(() => {
        copyLockedRef.current = false;
        copyFeedbackTimerRef.current = undefined;
        setCopyStatus(undefined);
      }, USER_MESSAGE_COPY_FEEDBACK_DURATION_MS);
    } catch {
      copyLockedRef.current = false;
      setCopyStatus("FAILED");
    }
  };

  return createElement(
    "div",
    { className: "turn-presentation-user-message" },
    createElement(
      "div",
      {
        ref: bubbleRef,
        className: bubbleClassName,
        "data-user-message-bubble": true,
        "data-collapsed": collapsed,
        "data-expanded": isOverflowing && isExpanded,
      },
      createElement(
        "p",
        {
          ref: contentRef,
          id: bubbleId,
          className: [
            "turn-presentation-user-bubble-content",
            collapsed ? "turn-presentation-user-bubble-content--collapsed" : "",
          ]
            .filter(Boolean)
            .join(" "),
          style: collapsed
            ? { maxHeight: `${String(USER_MESSAGE_COLLAPSED_CONTENT_HEIGHT_PX)}px` }
            : isOverflowing && isExpanded
              ? { paddingBottom: `${String(USER_MESSAGE_EXPANDED_ACTION_SPACE_PX)}px` }
              : undefined,
        },
        props.text,
      ),
      isOverflowing
        ? createElement(
            "button",
            {
              type: "button",
              className: "turn-presentation-user-expand",
              "aria-controls": bubbleId,
              "aria-expanded": isExpanded,
              onClick: () => setIsExpanded((expanded) => !expanded),
            },
            isExpanded ? "收起" : "显示更多",
            createElement(ChevronDown, {
              size: 14,
              "aria-hidden": true,
              className: isExpanded ? "turn-presentation-user-expand-icon--expanded" : undefined,
            }),
          )
        : null,
    ),
    createElement(
      "div",
      { className: "turn-presentation-user-actions" },
      createElement(
        "button",
        {
          type: "button",
          className: [
            "turn-presentation-user-copy",
            copyStatus === "COPIED" ? "turn-presentation-user-copy--copied" : "",
          ]
            .filter(Boolean)
            .join(" "),
          "aria-label":
            copyStatus === "COPIED"
              ? "用户消息已复制"
              : copyStatus === "FAILED"
                ? "复制失败，请重试"
                : "复制用户消息",
          disabled: copyStatus === "COPIED",
          onClick: () => void copyMessage(),
        },
        createElement(
          "span",
          { className: "turn-presentation-user-copy-icons", "aria-hidden": true },
          createElement(Copy, {
            size: 15,
            className:
              copyStatus === "COPIED"
                ? "turn-presentation-user-copy-icon"
                : "turn-presentation-user-copy-icon turn-presentation-user-copy-icon--visible",
          }),
          createElement(Check, {
            size: 15,
            className:
              copyStatus === "COPIED"
                ? "turn-presentation-user-copy-icon turn-presentation-user-copy-icon--visible"
                : "turn-presentation-user-copy-icon",
          }),
        ),
      ),
    ),
    createElement(
      "span",
      { className: "visually-hidden", "aria-live": "polite", role: "status" },
      copyStatus === "COPIED" ? "已复制用户消息" : copyStatus === "FAILED" ? "复制失败" : "",
    ),
  );
}
