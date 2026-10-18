import { createElement, type ReactElement } from "react";
import type { AttachmentId, AttachmentOwner } from "@caelush/protocol";
import type { AttachmentQueueItem } from "../application/attachment-manager.js";
import { AttachmentCard } from "./attachment-card.js";

export interface AttachmentListProps {
  readonly items: readonly AttachmentQueueItem[];
  readonly onRemove: (id: string) => void;
  readonly onRetry?: ((id: string) => void) | undefined;
  readonly onLoadPreview?:
    ((artifactId: AttachmentId, owner: AttachmentOwner) => Promise<Blob>) | undefined;
}

export function AttachmentList(props: AttachmentListProps): ReactElement | null {
  if (props.items.length === 0) return null;
  return createElement(
    "div",
    { className: "attachment-list", role: "list", "aria-label": "待发送附件" },
    ...props.items.map((item) =>
      createElement(
        "div",
        { className: "attachment-list-item", role: "listitem", key: item.id },
        createElement(AttachmentCard, {
          item,
          onRemove: props.onRemove,
          onRetry: props.onRetry,
          onLoadPreview: props.onLoadPreview,
        }),
      ),
    ),
  );
}
