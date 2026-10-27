import { Check, ChevronDown, Copy } from "lucide-react";
import { createElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const useLayoutEffectWhenRendered = typeof window === "undefined" ? useEffect : useLayoutEffect;

export const USER_MESSAGE_COLLAPSED_CONTENT_HEIGHT_PX = 456;
const USER_MESSAGE_EXPANDED_ACTION_SPACE_PX = 34;

export function isUserMessageContentOverflowing(scrollHeight: number): boolean {
  return scrollHeight > USER_MESSAGE_COLLAPSED_CONTENT_HEIGHT_PX;
}

export function UserMessageBubble(props: { readonly text: string }) {
  const bubbleId = useId();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"COPIED" | "FAILED" | undefined>();

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
  const className = [
    "turn-presentation-user-bubble",
    collapsed ? "turn-presentation-user-bubble--collapsed" : "",
    isOverflowing && isExpanded ? "turn-presentation-user-bubble--expanded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopyStatus("COPIED");
    } catch {
      setCopyStatus("FAILED");
    }
  };

  return createElement(
    "div",
    {
      ref: bubbleRef,
      className,
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
          : isExpanded
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
    createElement(
      "button",
      {
        type: "button",
        className: "turn-presentation-user-copy",
        "aria-label":
          copyStatus === "COPIED"
            ? "用户消息已复制"
            : copyStatus === "FAILED"
              ? "复制失败，请重试"
              : "复制用户消息",
        onClick: () => void copyMessage(),
      },
      createElement(copyStatus === "COPIED" ? Check : Copy, {
        size: 15,
        "aria-hidden": true,
      }),
    ),
    createElement(
      "span",
      { className: "sr-only", "aria-live": "polite" },
      copyStatus === "COPIED" ? "已复制用户消息" : copyStatus === "FAILED" ? "复制失败" : "",
    ),
  );
}
