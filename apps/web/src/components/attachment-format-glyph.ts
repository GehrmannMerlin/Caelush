import { createElement, type ReactElement } from "react";
import type { AttachmentFormat } from "../application/attachment-format.js";

/** A shared format glyph used in both composer and transcript attachment cards. */
export function AttachmentFormatGlyph(props: {
  readonly format: AttachmentFormat;
  readonly size: number;
}): ReactElement {
  const Icon = props.format.icon;
  return createElement(
    "span",
    { className: "attachment-format-glyph", "aria-hidden": true },
    createElement(Icon, { size: props.size, strokeWidth: 2.1 }),
    createElement("span", { className: "attachment-format-mark" }, props.format.mark),
  );
}
