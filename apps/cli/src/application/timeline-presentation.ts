import type { FileChangeSummary, ToolName } from "@caelush/protocol";

export const OUTPUT_TRUNCATION_MARKER = "… output truncated …";

const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  read_file: "Read file",
  list_directory: "List directory",
  find_files: "Find files",
  search_text: "Search text",
  apply_patch: "Edit files",
  exec_command: "Run command",
  write_stdin: "Interact with process",
  git_status: "Check Git status",
  git_diff: "Inspect Git diff",
});

export function formatToolLabel(toolName: ToolName | string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

export function formatFileChange(summary: FileChangeSummary): string {
  const marker =
    summary.changeType === "CREATED"
      ? "A"
      : summary.changeType === "MODIFIED"
        ? "M"
        : summary.changeType === "DELETED"
          ? "D"
          : "R";
  const counts = [
    summary.additions === undefined ? undefined : `+${summary.additions}`,
    summary.deletions === undefined ? undefined : `-${summary.deletions}`,
  ].filter((value): value is string => value !== undefined);
  const path = workspaceRelativePath(summary.path) ?? "(path omitted)";
  return `${marker} ${path}${counts.length === 0 ? "" : ` (${counts.join(", ")})`}`;
}

export function formatFileRead(path: string): string {
  const safePath = workspaceRelativePath(path);
  return safePath === undefined ? "Read file (path omitted)" : `Read file ${safePath}`;
}

export function formatFileMove(fromPath: string, toPath: string): string {
  const from = workspaceRelativePath(fromPath);
  const to = workspaceRelativePath(toPath);
  return `R ${from ?? "(path omitted)"} → ${to ?? "(path omitted)"}`;
}

export function workspaceRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

export function sanitizeTerminalText(value: string): string {
  let text = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index]!;
    if (character === "\u001b") {
      const end = terminalEscapeEnd(value, index);
      index = end === undefined ? value.length : end + 1;
      continue;
    }
    if (character === "\r") {
      if (value[index + 1] === "\n") index += 1;
      text += "\n";
    } else if (character === "\n" || character === "\t") {
      text += character;
    } else if (!isUnsafeControl(character)) {
      text += character;
    }
    index += 1;
  }
  return text;
}

export function truncateTimelineText(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8");
  if (markerBytes >= maxBytes) return prefixBytes(value, maxBytes);
  const contentBytes = maxBytes - markerBytes;
  const headBytes = Math.floor(contentBytes / 2);
  const tailBytes = contentBytes - headBytes;
  return `${prefixBytes(value, headBytes)}${OUTPUT_TRUNCATION_MARKER}${suffixBytes(value, tailBytes)}`;
}

function terminalEscapeEnd(value: string, start: number): number | undefined {
  if (start + 1 >= value.length) return undefined;
  const kind = value[start + 1];
  if (kind === "[") {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index;
    }
    return undefined;
  }
  if (kind === "]") {
    for (let index = start + 2; index < value.length; index += 1) {
      if (value[index] === "\u0007") return index;
      if (value[index] === "\u001b" && value[index + 1] === "\\") return index + 1;
    }
    return undefined;
  }
  return start + 1;
}

function isUnsafeControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 0 && code <= 8) ||
    code === 11 ||
    code === 12 ||
    (code >= 14 && code <= 31) ||
    code === 127
  );
}

function prefixBytes(value: string, maxBytes: number): string {
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

function suffixBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
