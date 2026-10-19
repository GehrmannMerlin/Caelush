import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceId, type AttachmentOwner } from "@caelush/protocol";
import type { AttachmentQueueItem } from "../src/application/attachment-manager.js";
import { AttachmentMenu } from "../src/components/attachment-menu.js";
import { AttachmentCard } from "../src/components/attachment-card.js";
import { PromptComposer } from "../src/components/prompt-composer.js";

describe("attachment composer", () => {
  it("renders an accessible plus button, multi-file picker and centered usage ring", () => {
    const html = renderToStaticMarkup(
      <PromptComposer
        disabled={false}
        submission="IDLE"
        onSubmit={async () => false}
        onAddFiles={vi.fn()}
      />,
    );
    const footerStart = html.indexOf('<div class="prompt-composer-footer">');
    const footerEnd = html.indexOf('<input class="prompt-attachment-file-input"', footerStart);
    const footer = footerStart === -1 || footerEnd === -1 ? "" : html.slice(footerStart, footerEnd);

    expect(html).toContain('aria-label="添加附件"');
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple=""');
    expect(html).toContain(".pdf");
    expect(footer).toContain("prompt-composer-left-controls");
    expect(footer).toContain("context-usage-control");
    expect(footer).toContain("prompt-composer-right-controls");
    expect(footer.indexOf("context-usage-control")).toBeGreaterThan(
      footer.indexOf("prompt-composer-left-controls"),
    );
    expect(footer.indexOf("context-usage-control")).toBeLessThan(
      footer.indexOf("prompt-composer-right-controls"),
    );
  });

  it("renders the upload-only menu action with a fixed popover above the composer", () => {
    const html = renderToStaticMarkup(<AttachmentMenu onChooseFiles={vi.fn()} />);
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(html).toContain('role="menu" aria-label="添加"');
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('class="attachment-menu-items"');
    expect(html).toContain("上传文件");
    expect(styles).toMatch(
      /\.attachment-menu\s*\{[^}]*position:\s*absolute;[^}]*inset-block-end:\s*calc\(100% \+ 12px\);[^}]*inset-inline:\s*0;[^}]*width:\s*100%;[^}]*height:\s*320px;[^}]*max-width:\s*none;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/s,
    );
    expect(styles).toMatch(
      /\.attachment-menu-items\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.prompt-composer-footer\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\);/s,
    );
    expect(styles).toMatch(
      /\.prompt-composer-footer\s*>\s*\.context-usage-control\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*center;/s,
    );
  });

  it("keeps file picker disabled when the composer is disabled", () => {
    const html = renderToStaticMarkup(
      <PromptComposer
        disabled
        submission="IDLE"
        onSubmit={async () => false}
        onAddFiles={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="添加附件"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('disabled=""');
  });

  it("shows an image attachment with a centered upload ring and hover remove control", () => {
    const owner: AttachmentOwner = { kind: "WORKSPACE", workspaceId: createWorkspaceId() };
    const item: AttachmentQueueItem = {
      id: "attachment-1",
      owner,
      name: "diagram.png",
      mediaType: "image/png",
      byteLength: 100,
      status: "UPLOADING",
      loadedBytes: 42,
      totalBytes: 100,
      file: Object.assign(new Blob(["image"]), { name: "diagram.png" }) as File,
    };
    const html = renderToStaticMarkup(<AttachmentCard item={item} onRemove={vi.fn()} />);
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(html).toContain('class="attachment-card attachment-card--image"');
    expect(html).toContain('class="attachment-card-progress-overlay" role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain("attachment-card-progress-ring");
    expect(html).toContain('aria-label="移除附件 diagram.png"');
    expect(styles).toMatch(/\.attachment-card--image\s*\{[^}]*width:\s*96px;[^}]*height:\s*96px;/s);
    expect(styles).toMatch(
      /\.attachment-card:hover\s+\.attachment-card-remove,\s*\.attachment-card:focus-within\s+\.attachment-card-remove\s*\{[^}]*opacity:\s*1;/s,
    );
    expect(styles).toMatch(
      /@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{[^}]*\.attachment-card-remove\s*\{[^}]*opacity:\s*1;/s,
    );
    expect(styles).toMatch(
      /@keyframes\s+attachment-card-ring-spin\s*\{\s*from\s*\{\s*transform:\s*rotate\(-90deg\);\s*\}\s*to\s*\{\s*transform:\s*rotate\(270deg\);/s,
    );
  });

  it("hides the progress ring after an attachment is ready", () => {
    const owner: AttachmentOwner = { kind: "WORKSPACE", workspaceId: createWorkspaceId() };
    const item: AttachmentQueueItem = {
      id: "attachment-ready",
      owner,
      name: "notes.txt",
      mediaType: "text/plain",
      byteLength: 5,
      status: "READY",
      loadedBytes: 5,
      totalBytes: 5,
      artifactId: "att_notesxxxxxxxx" as AttachmentQueueItem["artifactId"],
    };
    const html = renderToStaticMarkup(<AttachmentCard item={item} onRemove={vi.fn()} />);
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(html).toContain('class="attachment-card attachment-card--file"');
    expect(html).toContain("notes.txt");
    expect(html).toContain('data-format="text"');
    expect(html).toContain("TXT · 5 B");
    expect(html).not.toContain("text/plain");
    expect(html).not.toContain("attachment-card-progress-overlay");
    expect(styles).toMatch(/\.attachment-card\s*\{[^}]*width:\s*176px;[^}]*min-height:\s*88px;/s);
  });

  it("gives each file format its own accent hook and label", () => {
    const owner: AttachmentOwner = { kind: "WORKSPACE", workspaceId: createWorkspaceId() };
    const base = {
      id: "attachment-format",
      owner,
      status: "READY" as const,
      loadedBytes: 2048,
      totalBytes: 2048,
      artifactId: "att_formatformat1" as AttachmentQueueItem["artifactId"],
    };
    const pdf = renderToStaticMarkup(
      <AttachmentCard
        item={{
          ...base,
          name: "报告.pdf",
          mediaType: "application/pdf",
          byteLength: 2048,
        }}
        onRemove={vi.fn()}
      />,
    );
    const excel = renderToStaticMarkup(
      <AttachmentCard
        item={{
          ...base,
          name: "数据.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          byteLength: 2048,
        }}
        onRemove={vi.fn()}
      />,
    );
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(pdf).toContain('data-format="pdf"');
    expect(pdf).toContain("PDF · 2.0 KiB");
    expect(excel).toContain('data-format="excel"');
    expect(excel).toContain("XLSX · 2.0 KiB");
    expect(styles).toMatch(
      /\.attachment-card-icon\[data-format\],\s*\.transcript-attachment-icon\[data-format\]\s*\{[^}]*color:\s*var\(--attachment-format\);/s,
    );
  });

  it("uses an opaque white surface for attachment cards instead of a muted glass-like fill", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const cardRule = styles.match(/\.attachment-card\s*\{[^}]*\}/s)?.[0];

    expect(cardRule).toContain("background: var(--web-surface, #fff);");
    expect(cardRule).not.toContain("backdrop-filter");
  });
});
