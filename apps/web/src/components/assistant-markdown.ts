import { createElement, Fragment, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeLocalPreviewLinks } from "./local-preview-links.js";

const components: Components = {
  a: ({ href, children, node, ...props }) => {
    void node;
    const external = isExternalHttpUrl(href);
    if (!external && !href?.startsWith("#")) return createElement(Fragment, null, children);
    return createElement(
      "a",
      {
        ...props,
        href,
        ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}),
      },
      children,
    );
  },
  img: ({ alt }) =>
    createElement(
      "span",
      { className: "assistant-markdown-image-disabled" },
      alt === undefined || alt.length === 0 ? "[图片未加载]" : `[图片未加载：${alt}]`,
    ),
};

/** Render assistant Markdown without raw HTML or implicit remote image requests. */
export function AssistantMarkdown({ children }: { readonly children: string }): ReactElement {
  return createElement(
    "div",
    { className: "assistant-markdown" },
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeLocalPreviewLinks], components },
      children,
    ),
  );
}

function isExternalHttpUrl(href: string | undefined): boolean {
  if (href === undefined) return false;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.port !== "0"
    );
  } catch {
    return false;
  }
}
