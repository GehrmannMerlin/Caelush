import { createElement, useEffect, useState, type ReactElement } from "react";
import { FileText, Image as ImageIcon, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { AttachmentId, AttachmentOwner } from "@caelush/protocol";
import type { AttachmentQueueItem } from "../application/attachment-manager.js";

export interface AttachmentCardProps {
  readonly item: AttachmentQueueItem;
  readonly onRemove: (id: string) => void;
  readonly onRetry?: ((id: string) => void) | undefined;
  readonly onLoadPreview?:
    ((artifactId: AttachmentId, owner: AttachmentOwner) => Promise<Blob>) | undefined;
  readonly compact?: boolean | undefined;
}

export function AttachmentCard(props: AttachmentCardProps): ReactElement {
  const { item } = props;
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const isImage = item.mediaType.startsWith("image/");
  const retryable =
    item.status === "FAILED" && item.file !== undefined && props.onRetry !== undefined;

  useEffect(() => {
    if (!isImage) {
      setPreviewUrl(undefined);
      return undefined;
    }
    let active = true;
    let objectUrl: string | undefined;
    const load = async () => {
      try {
        const blob =
          item.file ??
          (item.artifactId !== undefined && props.onLoadPreview !== undefined
            ? await props.onLoadPreview(item.artifactId, item.owner)
            : undefined);
        if (blob === undefined) return;
        objectUrl = URL.createObjectURL(blob);
        if (active) setPreviewUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      } catch {
        if (active) setPreviewUrl(undefined);
      }
    };
    void load();
    return () => {
      active = false;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [isImage, item.artifactId, item.file, item.owner, props.onLoadPreview]);

  const statusLabel = attachmentStatusLabel(item.status);
  return createElement(
    "article",
    {
      className: `attachment-card${props.compact === true ? " attachment-card--compact" : ""}`,
      "data-attachment-status": item.status.toLowerCase(),
      "aria-label": `${item.name}, ${statusLabel}`,
    },
    isImage && previewUrl !== undefined
      ? createElement("img", { className: "attachment-card-preview", src: previewUrl, alt: "" })
      : createElement(
          "span",
          { className: "attachment-card-icon", "aria-hidden": true },
          isImage ? createElement(ImageIcon, { size: 19 }) : createElement(FileText, { size: 19 }),
        ),
    createElement(
      "div",
      { className: "attachment-card-body" },
      createElement("span", { className: "attachment-card-name", title: item.name }, item.name),
      createElement(
        "span",
        { className: "attachment-card-meta" },
        `${item.mediaType} · ${formatBytes(item.byteLength)} · ${statusLabel}`,
      ),
      item.status === "UPLOADING" && item.totalBytes > 0
        ? createElement(
            "div",
            {
              className: "attachment-card-progress",
              role: "progressbar",
              "aria-label": `上传 ${item.name}`,
              "aria-valuemin": 0,
              "aria-valuemax": item.totalBytes,
              "aria-valuenow": item.loadedBytes,
            },
            createElement("span", {
              style: { width: `${Math.round((item.loadedBytes / item.totalBytes) * 100)}%` },
            }),
          )
        : null,
      item.status === "FAILED" && item.error !== undefined
        ? createElement("span", { className: "attachment-card-error", role: "status" }, item.error)
        : null,
    ),
    retryable
      ? createElement(
          "button",
          {
            type: "button",
            className: "attachment-card-action",
            onClick: () => props.onRetry?.(item.id),
            "aria-label": `重试上传 ${item.name}`,
            title: "重试上传",
          },
          createElement(RefreshCw, { size: 15, "aria-hidden": true }),
        )
      : item.status === "UPLOADING" || item.status === "PREPROCESSING"
        ? createElement(LoaderCircle, {
            className: "attachment-card-spinner",
            size: 16,
            "aria-label": statusLabel,
          })
        : null,
    createElement(
      "button",
      {
        type: "button",
        className: "attachment-card-action attachment-card-remove",
        onClick: () => props.onRemove(item.id),
        "aria-label": `移除附件 ${item.name}`,
        title: "移除附件",
      },
      createElement(X, { size: 15, "aria-hidden": true }),
    ),
  );
}

export function attachmentStatusLabel(status: AttachmentQueueItem["status"]): string {
  switch (status) {
    case "VALIDATING":
      return "校验中";
    case "UPLOADING":
      return "上传中";
    case "PREPROCESSING":
      return "解析中";
    case "READY":
      return "已就绪";
    case "FAILED":
      return "上传失败";
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
