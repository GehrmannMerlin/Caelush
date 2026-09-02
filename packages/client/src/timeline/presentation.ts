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
  const head = prefix(Math.floor(budget / 2));
  let tail = "";
  let used = 0;
  for (const point of [...value].reverse()) {
    const bytes = encoder.encode(point).byteLength;
    if (used + bytes > budget - encoder.encode(head).byteLength) break;
    tail = point + tail;
    used += bytes;
  }
  return head + TRUNCATION_MARKER + tail;
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
  const labels: Record<string, string> = {
    read_file: "Read file",
    list_directory: "List directory",
    find_files: "Find files",
    search_text: "Search text",
    apply_patch: "Edit files",
    exec_command: "Run command",
    write_stdin: "Interact with process",
    git_status: "Check Git status",
    git_diff: "Inspect Git diff",
  };
  return labels[toolName] ?? toolName;
}
export function formatFileChange(summary: {
  readonly path: string;
  readonly changeType: string;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
}): string {
  const marker =
    summary.changeType === "CREATED"
      ? "A"
      : summary.changeType === "MODIFIED"
        ? "M"
        : summary.changeType === "DELETED"
          ? "D"
          : "R";
  const path = workspaceRelativePath(summary.path) ?? "(path omitted)";
  const counts = [
    summary.additions === undefined ? undefined : `+${summary.additions}`,
    summary.deletions === undefined ? undefined : `-${summary.deletions}`,
  ].filter((value): value is string => value !== undefined);
  return `${marker} ${path}${counts.length === 0 ? "" : ` (${counts.join(", ")})`}`;
}
export function formatFileRead(path: string): string {
  return `Read file ${workspaceRelativePath(path) ?? "(path omitted)"}`;
}
export function formatFileMove(source: string, destination: string): string {
  return `R ${workspaceRelativePath(source) ?? "(path omitted)"} → ${workspaceRelativePath(destination) ?? "(path omitted)"}`;
}
export function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    COMPLETED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
    TIMEOUT: "timeout",
    MAX_STEPS_REACHED: "max steps reached",
    BUDGET_EXCEEDED: "budget exceeded",
  };
  return labels[status] ?? status.toLowerCase();
}
export function formatRunTerminal(status: string): string {
  return `Run ended with status ${runStatusLabel(status)}.`;
}
