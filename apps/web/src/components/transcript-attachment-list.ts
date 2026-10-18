import { createElement, useEffect, useState, type ReactElement } from "react";
import { Download, FileText, Image as ImageIcon } from "lucide-react";
import {
  AttachmentIdSchema,
  type AttachmentId,
  type AttachmentOwner,
  type TranscriptAttachmentRef,
} from "@caelush/protocol";

export interface TranscriptAttachmentListProps {
  readonly attachments: readonly TranscriptAttachmentRef[];
  readonly owner?: AttachmentOwner | undefined;
  readonly onLoad?: ((id: AttachmentId, owner: AttachmentOwner) => Promise<Blob>) | undefined;
  readonly onDownload?: ((id: AttachmentId, owner: AttachmentOwner) => Promise<Blob>) | undefined;
}

export function TranscriptAttachmentList(
  props: TranscriptAttachmentListProps,
): ReactElement | null {
  if (props.attachments.length === 0) return null;
  return createElement(
    "div",
    { className: "transcript-attachment-list", "aria-label": "消息附件" },
    ...props.attachments.map((attachment, index) => {
      const id = AttachmentIdSchema.safeParse(attachment.artifactId);
      const owner = props.owner;
      return createElement(TranscriptAttachmentCard, {
        key: `${attachment.artifactId}:${index}`,
        attachment,
        ...(id.success ? { artifactId: id.data } : {}),
        ...(owner === undefined ? {} : { owner }),
        onLoad: props.onLoad,
        onDownload: props.onDownload,
      });
    }),
  );
}

function TranscriptAttachmentCard(props: {
  readonly attachment: TranscriptAttachmentRef;
  readonly artifactId?: AttachmentId | undefined;
  readonly owner?: AttachmentOwner | undefined;
  readonly onLoad?: TranscriptAttachmentListProps["onLoad"];
  readonly onDownload?: TranscriptAttachmentListProps["onDownload"];
}): ReactElement {
  const { attachment, artifactId, owner } = props;
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const canPreview =
    attachment.previewAvailable === true && artifactId !== undefined && owner !== undefined;

  useEffect(() => {
    if (
      !canPreview ||
      props.onLoad === undefined ||
      artifactId === undefined ||
      owner === undefined
    ) {
      setPreviewUrl(undefined);
      return undefined;
    }
    let active = true;
    let objectUrl: string | undefined;
    void props
      .onLoad(artifactId, owner)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setPreviewUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {
        if (active) setPreviewUrl(undefined);
      });
    return () => {
      active = false;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, canPreview, owner, props.onLoad]);

  const download = async () => {
    if (artifactId === undefined || owner === undefined || props.onDownload === undefined) return;
    setDownloadBusy(true);
    setDownloadError(false);
    let objectUrl: string | undefined;
    try {
      const blob = await props.onDownload(artifactId, owner);
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = attachment.name ?? "attachment";
      link.click();
    } catch {
      setDownloadError(true);
    } finally {
      setDownloadBusy(false);
      if (objectUrl !== undefined) window.setTimeout(() => URL.revokeObjectURL(objectUrl!), 0);
    }
  };

  const name = attachment.name ?? attachment.label ?? "附件";
  const isImage = attachment.mediaType?.startsWith("image/") === true;
  return createElement(
    "article",
    { className: "transcript-attachment-card" },
    previewUrl !== undefined
      ? createElement("img", {
          className: "transcript-attachment-preview",
          src: previewUrl,
          alt: name,
        })
      : createElement(
          "span",
          { className: "transcript-attachment-icon", "aria-hidden": true },
          isImage ? createElement(ImageIcon, { size: 18 }) : createElement(FileText, { size: 18 }),
        ),
    createElement(
      "span",
      { className: "transcript-attachment-copy" },
      createElement("span", { className: "transcript-attachment-name", title: name }, name),
      createElement(
        "span",
        { className: "transcript-attachment-meta" },
        [
          attachment.mediaType,
          attachment.byteLength === undefined ? undefined : formatBytes(attachment.byteLength),
        ]
          .filter((value): value is string => value !== undefined)
          .join(" · "),
      ),
    ),
    attachment.downloadAvailable === true && artifactId !== undefined && owner !== undefined
      ? createElement(
          "button",
          {
            type: "button",
            className: "transcript-attachment-download",
            onClick: () => void download(),
            disabled: downloadBusy,
            "aria-label": `下载附件 ${name}`,
            title: downloadBusy ? "正在下载" : "下载原件",
          },
          createElement(Download, { size: 15, "aria-hidden": true }),
        )
      : null,
    downloadError
      ? createElement(
          "span",
          { className: "transcript-attachment-error", role: "status" },
          "下载失败",
        )
      : null,
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
