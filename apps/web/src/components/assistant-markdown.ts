import { createElement, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children, node, ...props }) => {
    void node;
    const external = isExternalHttpUrl(href);
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
};

/** Render user-authored assistant Markdown without enabling raw HTML. */
export function AssistantMarkdown({ children }: { readonly children: string }): ReactElement {
  return createElement(
    "div",
    { className: "assistant-markdown" },
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, children),
  );
}

function isExternalHttpUrl(href: string | undefined): boolean {
  if (href === undefined) return false;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
