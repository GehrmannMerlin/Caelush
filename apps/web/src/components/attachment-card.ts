import { createElement, useEffect, useState, type ReactElement } from "react";
import { RefreshCw, X } from "lucide-react";
import type { AttachmentId, AttachmentOwner } from "@caelush/protocol";
import type { AttachmentQueueItem } from "../application/attachment-manager.js";
import { attachmentFormatOf } from "../application/attachment-format.js";
import { AttachmentFormatGlyph } from "./attachment-format-glyph.js";

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
  const isBusy =
    item.status === "VALIDATING" || item.status === "UPLOADING" || item.status === "PREPROCESSING";
  const uploadProgress =
    item.status === "UPLOADING" && item.totalBytes > 0
      ? Math.max(0, Math.min(1, item.loadedBytes / item.totalBytes))
      : undefined;
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
  const format = attachmentFormatOf({ name: item.name, mediaType: item.mediaType });
  const progressCircumference = 2 * Math.PI * 16;
  const className = [
    "attachment-card",
    `attachment-card--${isImage ? "image" : "file"}`,
    ...(props.compact === true ? ["attachment-card--compact"] : []),
  ].join(" ");

  return createElement(
    "article",
    {
      className,
      "data-format": format.key,
      "data-attachment-status": item.status.toLowerCase(),
      "aria-label": `${item.name}, ${statusLabel}`,
    },
    isImage && previewUrl !== undefined
      ? createElement("img", { className: "attachment-card-preview", src: previewUrl, alt: "" })
      : createElement(
          "span",
          {
            className: "attachment-card-icon",
            "data-format": format.key,
            "aria-hidden": true,
          },
          createElement(AttachmentFormatGlyph, { format, size: 21 }),
        ),
    createElement(
      "div",
      { className: "attachment-card-body" },
      createElement("span", { className: "attachment-card-name", title: item.name }, item.name),
      createElement(
        "span",
        { className: "attachment-card-meta" },
        [
          format.label,
          formatBytes(item.byteLength),
          item.status === "READY" ? undefined : statusLabel,
        ]
          .filter((value): value is string => value !== undefined)
          .join(" · "),
      ),
      item.status === "FAILED" && item.error !== undefined
        ? createElement("span", { className: "attachment-card-error", role: "status" }, item.error)
        : null,
    ),
    isBusy
      ? createElement(
          "span",
          {
            className: `attachment-card-progress-overlay${uploadProgress === undefined ? " attachment-card-progress-overlay--indeterminate" : ""}`,
            role: "progressbar",
            "aria-label": item.status === "UPLOADING" ? `上传 ${item.name}` : `处理 ${item.name}`,
            ...(uploadProgress === undefined
              ? {}
              : {
                  "aria-valuemin": 0,
                  "aria-valuemax": 100,
                  "aria-valuenow": Math.round(uploadProgress * 100),
                }),
          },
          createElement(
            "svg",
            {
              className: `attachment-card-progress-ring${uploadProgress === undefined ? " attachment-card-progress-ring--indeterminate" : ""}`,
              viewBox: "0 0 40 40",
              "aria-hidden": true,
            },
            createElement("circle", {
              className: "attachment-card-progress-track",
              cx: 20,
              cy: 20,
              r: 16,
              fill: "none",
              strokeWidth: 3,
            }),
            createElement("circle", {
              className: "attachment-card-progress-value",
              cx: 20,
              cy: 20,
              r: 16,
              fill: "none",
              strokeWidth: 3,
              ...(uploadProgress === undefined
                ? {}
                : {
                    strokeDasharray: progressCircumference,
                    strokeDashoffset: progressCircumference * (1 - uploadProgress),
                  }),
            }),
          ),
        )
      : null,
    createElement(
      "div",
      { className: "attachment-card-actions" },
      retryable
        ? createElement(
            "button",
            {
              type: "button",
              className: "attachment-card-action attachment-card-action--retry",
              onClick: () => props.onRetry?.(item.id),
              "aria-label": `重试上传 ${item.name}`,
              title: "重试上传",
            },
            createElement(RefreshCw, { size: 15, "aria-hidden": true }),
          )
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
