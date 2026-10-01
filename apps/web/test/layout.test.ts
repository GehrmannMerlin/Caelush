import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/app.ts"), "utf8");
const sessionWorkspaceSource = readFileSync(
  resolve(process.cwd(), "apps/web/src/components/session-workspace.ts"),
  "utf8",
);

function lastCssRule(selector: string): string {
  const marker = `${selector} {`;
  const start = styles.lastIndexOf(marker);
  if (start < 0) return "";
  const end = styles.indexOf("}", start);
  return end < 0 ? styles.slice(start) : styles.slice(start, end + 1);
}

describe("responsive workspace layout", () => {
  it("does not render a desktop top navigation bar outside the two-panel shell", () => {
    expect(appSource).not.toContain('className: "web-topbar"');
    expect(appSource).toContain('className: "workspace-frame"');
    expect(appSource).toContain('className: "sidebar-toggle-button"');
  });

  it("locks the app shell to the viewport and gives each panel its intended scroll boundary", () => {
    expect(lastCssRule(".web-app-shell")).toMatch(/height:\s*100dvh/);
    expect(lastCssRule(".web-app-shell")).toContain("overflow: hidden");
    expect(lastCssRule(".workspace-sidebar")).toContain("position: fixed");
    expect(lastCssRule(".workspace-sidebar")).toContain("overflow-y: auto");
    expect(lastCssRule(".workspace-column")).toContain("overflow-y: auto");
    expect(lastCssRule(".session-scroll")).toContain("overflow: visible");
  });

  it("puts the primary conversation scrollbar on the workspace edge", () => {
    const viewportOverrides = styles.slice(styles.lastIndexOf("/* Final viewport split overrides"));

    expect(viewportOverrides).toMatch(
      /\.workspace-column\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;[\s\S]*?scrollbar-gutter:\s*stable;/,
    );
    expect(viewportOverrides).toMatch(
      /\.session-scroll\s*\{[\s\S]*?overflow-x:\s*visible;[\s\S]*?overflow-y:\s*visible;/,
    );
    expect(viewportOverrides).toMatch(
      /\.prompt-composer\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*0;/,
    );
    const mobileSessionScrollRule =
      [...viewportOverrides.matchAll(/(?:^|\n)\s*\.session-scroll\s*\{[\s\S]*?\n\s*\}/g)].at(
        -1,
      )?.[0] ?? "";
    expect(mobileSessionScrollRule).not.toContain("overflow-y: auto");
  });

  it("locks the viewport rail for pristine sessions without removing the rail for active content", () => {
    const viewportOverrides = styles.slice(styles.lastIndexOf("/* Final viewport split overrides"));

    expect(appSource).toContain("workspace-column workspace-column--static");
    expect(viewportOverrides).toMatch(
      /\.workspace-column--static\s*\{[\s\S]*?overflow-y:\s*hidden;[\s\S]*?scrollbar-gutter:\s*auto;/,
    );
    expect(viewportOverrides).toContain(".workspace-notices:empty");
    expect(viewportOverrides).toMatch(/\.workspace-notices:empty\s*\{[\s\S]*?display:\s*none;/);
  });

  it("keeps the composer anchored to the viewport after content grows", () => {
    const viewportOverrides = styles.slice(styles.lastIndexOf("/* Final viewport split overrides"));

    expect(viewportOverrides).toMatch(
      /\.prompt-composer\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*0;[\s\S]*?margin-top:\s*auto;/,
    );
  });

  it("renders the execution feed inline and leaves the page as its scroll owner", () => {
    const inlineFeedOverrides = styles.slice(styles.lastIndexOf("/* Inline execution feed"));

    expect(inlineFeedOverrides).toMatch(
      /\.turn-presentation-process\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(inlineFeedOverrides).toMatch(
      /\.turn-presentation-body\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/,
    );
  });

  it("keeps sidebar labels high-contrast and makes the add-workspace action full width", () => {
    expect(lastCssRule(".workspace-sidebar")).toContain("color: #111827");
    expect(lastCssRule(".workspace-add-button")).toContain("width: 100%");
    expect(lastCssRule(".workspace-add-button")).toContain("justify-content: center");
    expect(lastCssRule(".workspace-add-button")).toContain("text-align: center");
    expect(lastCssRule(".workspace-add-button")).toContain("color: #111827");
    expect(lastCssRule(".workspace-list-button")).toContain("color: #111827");
    expect(lastCssRule(".workspace-session-item")).toContain("color: #111827");
  });

  it("renders a compact left-aligned session title without the kicker", () => {
    expect(sessionWorkspaceSource).not.toContain('className: "workspace-kicker"');

    const titleOverride = styles.slice(styles.lastIndexOf("/* Keep the current session title"));
    expect(titleOverride).toContain("text-align: left");
    expect(titleOverride).toContain("margin: 0 0 0 48px");
    expect(titleOverride).toContain("font-size: 0.95rem");
    expect(titleOverride).toContain("font-weight: 700");
  });

  it("aligns user message bubbles with the full-width report edge", () => {
    const conversationOverride = styles.slice(
      styles.lastIndexOf("/* Align user requests with the report edge"),
    );

    expect(conversationOverride).toContain(".conversation-entry--user {");
    expect(conversationOverride).toContain("width: 100%");
    expect(conversationOverride).toContain("max-width: 100%");
    expect(conversationOverride).toContain("display: flex");
    expect(conversationOverride).toContain("justify-content: flex-end");
    expect(conversationOverride).toContain(".conversation-bubble--user {");
    expect(conversationOverride).toContain("margin-left: auto");
  });

  it("keeps the sidebar brand logo centered, contained, and on the sidebar surface", () => {
    const brandOverride = styles.slice(
      styles.lastIndexOf("/* Use the provided Caelush brand lockup"),
    );

    expect(brandOverride).toContain(".workspace-sidebar-brand {");
    expect(brandOverride).toContain("justify-content: center");
    expect(brandOverride).toContain("background: var(--web-sidebar-bg)");
    expect(brandOverride).toContain(".workspace-sidebar-logo {");
    expect(brandOverride).toContain("max-width: 100%");
    expect(brandOverride).toContain("object-fit: contain");
  });

  it("keeps approval prompts centered, layered, blue-white, and removes the accent rail", () => {
    const approvalOverride = styles.slice(styles.lastIndexOf("/* Fixed approval overlay"));
    const inlineFeedOverride = styles.slice(styles.lastIndexOf("/* Inline execution feed"));

    expect(approvalOverride).toMatch(
      /\.approval-overlay\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?z-index:/,
    );
    expect(approvalOverride).toMatch(
      /\.approval-stack\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;/,
    );
    expect(approvalOverride).toMatch(
      /\.approval-overlay \.approval-card\s*\{[\s\S]*?background:\s*#fff;/,
    );
    expect(approvalOverride).toMatch(
      /\.approval-overlay \.approval-card\s*\{[\s\S]*?border-left:\s*0;/,
    );
    expect(approvalOverride).toContain(".approval-action--reject");
    expect(inlineFeedOverride).toMatch(
      /\.turn-presentation-logo\s*\{[\s\S]*?width:\s*auto;[\s\S]*?height:\s*1\.75rem;/,
    );
  });
});
