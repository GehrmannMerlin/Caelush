import { createElement, useEffect, useState, type ReactElement } from "react";
import {
  AttachmentIdSchema,
  type AttachmentId,
  type AttachmentOwner,
  type TranscriptAttachmentRef,
} from "@caelush/protocol";
import { attachmentFormatOf } from "../application/attachment-format.js";
import { AttachmentFormatGlyph } from "./attachment-format-glyph.js";

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

/**
 * One attachment above its user bubble.
 *
 * The whole card is the download control: a separate download button made the row noisy and the
 * transcript read like a file manager. Images render as a fixed 38 px thumbnail so a 4000 px photo
 * never sets the size of the conversation.
 */
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

  const name = attachment.name ?? attachment.label ?? "附件";
  const format = attachmentFormatOf({ name, mediaType: attachment.mediaType });

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
      link.download = name;
      link.click();
    } catch {
      setDownloadError(true);
    } finally {
      setDownloadBusy(false);
      if (objectUrl !== undefined) window.setTimeout(() => URL.revokeObjectURL(objectUrl!), 0);
    }
  };

  const meta = [
    format.label,
    attachment.byteLength === undefined ? undefined : formatBytes(attachment.byteLength),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  const canDownload =
    attachment.downloadAvailable === true &&
    artifactId !== undefined &&
    owner !== undefined &&
    props.onDownload !== undefined;

  const content = [
    previewUrl !== undefined
      ? createElement("img", {
          className: "transcript-attachment-thumb",
          src: previewUrl,
          alt: "",
        })
      : createElement(
          "span",
          {
            className: "transcript-attachment-icon",
            "data-format": format.key,
            "aria-hidden": true,
          },
          createElement(AttachmentFormatGlyph, { format, size: 20 }),
        ),
    createElement(
      "span",
      { className: "transcript-attachment-copy" },
      createElement("span", { className: "transcript-attachment-name", title: name }, name),
      createElement("span", { className: "transcript-attachment-meta" }, meta),
    ),
    downloadError
      ? createElement(
          "span",
          { className: "transcript-attachment-error", role: "status" },
          "下载失败",
        )
      : null,
  ];

  if (!canDownload) {
    return createElement(
      "div",
      { className: "transcript-attachment-card", "data-format": format.key },
      ...content,
    );
  }
  return createElement(
    "button",
    {
      type: "button",
      className: "transcript-attachment-card",
      "data-format": format.key,
      onClick: () => void download(),
      disabled: downloadBusy,
      "aria-label": `下载附件 ${name}`,
      title: "点击下载原件",
    },
    ...content,
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
