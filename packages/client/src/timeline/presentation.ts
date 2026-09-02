const TRUNCATION_MARKER = "… output truncated …";

export function truncateTimelineText(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (maxBytes <= 0) return "";
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const markerBytes = encoder.encode(TRUNCATION_MARKER).byteLength;
  const prefix = (budget: number): string => {
    let result = "";
    let used = 0;
    for (const point of value) {
      const bytes = encoder.encode(point).byteLength;
      if (used + bytes > budget) break;
      result += point;
      used += bytes;
    }
    return result;
  };
  if (maxBytes < markerBytes) return prefix(maxBytes);
  const budget = maxBytes - markerBytes;
  return prefix(budget) + TRUNCATION_MARKER;
}

export function sanitizeTerminalText(value: string): string {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  return value
    .replace(new RegExp(`${escape}\\][^${bell}]*(?:${bell}|$)`, "g"), "")
    .replace(
      new RegExp(
        `${escape}(?:\\[[0-?]*[ -/]*[@-~]|\\([^\\r\\n]*|[\\]PX^_].*?(?:${bell}|${escape}\\\\))`,
        "g",
      ),
      "",
    )
    .replace(/\r\n?/g, "\n")
    .split("")
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 8 && code !== 11 && code !== 12 && (code < 14 || code > 31) && code !== 127;
    })
    .join("");
}

export function workspaceRelativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized))
    return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) return undefined;
  return parts.filter(Boolean).join("/") || undefined;
}
export function formatToolLabel(toolName: string): string {
  return toolName.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
export function formatFileChange(path: string, action: string): string {
  return `${action}: ${path}`;
}
export function formatFileRead(path: string): string {
  return `Read ${path}`;
}
export function formatFileMove(source: string, destination: string): string {
  return `Move ${source} → ${destination}`;
}
