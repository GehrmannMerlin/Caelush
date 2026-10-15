import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown } from "../src/components/assistant-markdown.js";

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(AssistantMarkdown, null, markdown));
}

describe("assistant Markdown links", () => {
  it.each([
    ["http://localhost:5173", "），验证后我已关闭该进程，工作区没有遗留后台进程。"],
    ["http://127.0.0.1:3000/", "，服务保持运行。"],
    ["http://[::1]:8080/login?next=%2F#form", "；可以继续预览。"],
    ["http://localhost:5173/login", "。打开登录页。"],
  ])("separates the local preview %s from trailing Chinese prose", (url, suffix) => {
    const html = render(`预览：${url}${suffix}`);

    expect(html).toContain(`href="${url}" target="_blank" rel="noopener noreferrer"`);
    expect(html).toContain(`>${url}</a>${suffix}`);
    expect(html).not.toContain("%EF%BC");
  });

  it("preserves an explicit link's label and Chinese path", () => {
    const html = render("[打开预览](http://localhost:5173/页面（演示）)");

    expect(html).toContain('target="_blank"');
    expect(html).toContain(
      'href="http://localhost:5173/%E9%A1%B5%E9%9D%A2%EF%BC%88%E6%BC%94%E7%A4%BA%EF%BC%89"',
    );
    expect(html).toContain(">打开预览</a>");
  });

  it("preserves a remote autolink containing a local URL in its query", () => {
    const html = render("http://example.com/?next=http://localhost:5173，说明");

    expect(html).toContain('href="http://example.com/?next=http://localhost:5173');
    expect(html).not.toContain('href="http://localhost:5173');
    expect(html).toContain(">http://example.com/?next=http://localhost:5173，说明</a>");
  });

  it.each([
    "http://localhost:5173",
    "http://localhost:5173/login",
    "http://localhost",
    "http://127.0.0.1",
    "http://[::1]",
  ])("keeps surrounding ASCII parentheses outside the local link: %s", (url) => {
    const html = render(`(${url})，然后继续。`);

    expect(html).toContain(`href="${url}" target="_blank"`);
    expect(html).toContain(`>${url}</a>)，然后继续。`);
  });

  it("preserves balanced parentheses inside a local URL's path", () => {
    const html = render("http://localhost:5173/login(demo)，然后继续。");

    expect(html).toContain('href="http://localhost:5173/login(demo)"');
    expect(html).toContain(">http://localhost:5173/login(demo)</a>，然后继续。");
  });

  it.each([
    "[错误端口](http://localhost:70000/)",
    "[错误地址](http://localhost:5173，错误地址)",
    "[不安全地址](javascript:alert%281%29)",
    "[相对路径](./README.md)",
  ])("does not make an invalid or unsupported destination navigable: %s", (markdown) => {
    const html = render(markdown);

    expect(html).not.toContain("<a");
    expect(html).not.toContain("href=");
  });

  it("keeps code literal and preserves explicit web and same-page links", () => {
    const html = render(
      "`http://localhost:5173，说明`\n\n[文档](https://example.com/docs) [镜像](//example.com/docs) [章节](#section)",
    );

    expect(html).toContain("<code>http://localhost:5173，说明</code>");
    expect(html).toContain('href="https://example.com/docs" target="_blank"');
    expect(html).toContain('href="//example.com/docs" target="_blank"');
    expect(html).toContain('<a href="#section">章节</a>');
  });
});
