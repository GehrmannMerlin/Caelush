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

/** Cache budget: how many distinct settled answers keep their parsed element alive. */
const MARKDOWN_CACHE_LIMIT = 64;
/** Answers above this size are parsed on demand instead of cached, to bound retained text. */
const MARKDOWN_CACHE_MAX_CHARS = 32_000;

/**
 * Parsed Markdown elements, keyed by exact source text.
 *
 * The conversation re-renders whenever any snapshot changes. Without this cache, every settled
 * assistant message is re-parsed by `react-markdown` on every one of those renders — which is what
 * made a long session re-parse hundreds of kilobytes of Markdown per streamed frame.
 *
 * A React element is an immutable descriptor, so returning the same one lets React skip the whole
 * subtree. The cache is a plain LRU: a hit is re-inserted so the least recently used answer is the
 * one evicted.
 */
const markdownCache = new Map<string, ReactElement>();

function createMarkdown(text: string): ReactElement {
  return createElement(
    "div",
    { className: "assistant-markdown" },
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeLocalPreviewLinks], components },
      text,
    ),
  );
}

function cachedMarkdown(text: string): ReactElement {
  const hit = markdownCache.get(text);
  if (hit !== undefined) {
    markdownCache.delete(text);
    markdownCache.set(text, hit);
    return hit;
  }
  const element = createMarkdown(text);
  if (text.length <= MARKDOWN_CACHE_MAX_CHARS) {
    markdownCache.set(text, element);
    if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
      const oldest = markdownCache.keys().next().value;
      if (oldest !== undefined) markdownCache.delete(oldest);
    }
  }
  return element;
}

/**
 * Render assistant Markdown without raw HTML or implicit remote image requests.
 *
 * `cache: false` is for in-flight text: every delta is a new string, so caching it would only evict
 * settled answers without ever producing a hit.
 */
export function AssistantMarkdown({
  children = "",
  cache = true,
}: {
  readonly children?: string;
  readonly cache?: boolean;
}): ReactElement {
  return cache ? cachedMarkdown(children) : createMarkdown(children);
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
