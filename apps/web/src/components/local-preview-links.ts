interface HtmlNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
  position?: { start: { offset?: number } };
}

const LOCAL_PREVIEW_URL =
  /http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/?#\s),.;!，。；：！？、（）【】《》“”‘’]|$)[^\s<>"`，。；：！？、（）【】《》“”‘’]*/giu;

/** Split bare local URLs at prose punctuation without rewriting code or explicit Markdown links. */
export function rehypeLocalPreviewLinks() {
  return (tree: HtmlNode, file: { toString(): string }): void => {
    const source = file.toString();

    function visit(parent: HtmlNode): void {
      if (parent.children === undefined) return;
      const children: HtmlNode[] = [];
      for (const node of parent.children) {
        const previous = children.at(-1);
        if (node.type === "text" && previous?.type === "text") {
          previous.value = (previous.value ?? "") + (node.value ?? "");
        } else children.push(node);
      }
      parent.children = children.flatMap((node) => {
        let text = node.type === "text" ? node.value : undefined;
        const start = node.position?.start.offset;
        if (
          node.tagName === "a" &&
          node.children?.length === 1 &&
          node.children[0]?.type === "text" &&
          start !== undefined &&
          source.slice(start, start + 7).toLowerCase() === "http://"
        )
          text = node.children[0].value;
        if (text !== undefined) return splitLocalUrls(text, node.tagName === "a") ?? [node];
        if (!["a", "code", "pre"].includes(node.tagName ?? "")) visit(node);
        return [node];
      });
    }

    visit(tree);
  };
}

function splitLocalUrls(text: string, isAutolink: boolean): HtmlNode[] | undefined {
  const nodes: HtmlNode[] = [];
  const matches = [...text.matchAll(LOCAL_PREVIEW_URL)];
  if (isAutolink && matches[0]?.index !== 0) return undefined;
  let offset = 0;
  for (const match of matches) {
    const value = trimTrailingPunctuation(match[0]);
    try {
      const url = new URL(value);
      if (
        url.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()) ||
        url.username !== "" ||
        url.password !== "" ||
        url.port === "0"
      )
        continue;
    } catch {
      continue;
    }
    if (match.index > offset) nodes.push({ type: "text", value: text.slice(offset, match.index) });
    nodes.push({
      type: "element",
      tagName: "a",
      properties: { href: value },
      children: [{ type: "text", value }],
    });
    offset = match.index + value.length;
  }
  if (nodes.length === 0) return undefined;
  if (offset < text.length) nodes.push({ type: "text", value: text.slice(offset) });
  return nodes;
}

function trimTrailingPunctuation(value: string): string {
  let result = value.replace(/[.,;:!?]+$/u, "");
  const open = (result.match(/\(/gu) ?? []).length;
  let close = (result.match(/\)/gu) ?? []).length;
  while (result.endsWith(")") && close > open) {
    result = result.slice(0, -1);
    close -= 1;
  }
  return result;
}
