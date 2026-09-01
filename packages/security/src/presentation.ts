import type { ToolInvocation } from "@caelush/protocol";
import type {
  ToolExecutionResult,
  ToolInvocationPresentation,
  ToolPresentationPort,
  ToolResultPresentation,
} from "@caelush/tools";
import { redactText } from "./secret-redaction.js";
import { classifySensitivePath, normalizeWorkspaceFactPath } from "./sensitive-path.js";
import { CaelushToolResultSanitizer } from "./tool-result-sanitizer.js";

const MAX_PRESENTATION_BYTES = 8 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024;
const REDACTED_PATH = "[sensitive path]";

export type TerminalOutputSanitizer = (value: string) => string;

export interface CaelushToolPresentationOptions {
  readonly terminalOutputSanitizer: TerminalOutputSanitizer;
}

const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  read_file: "Read file",
  list_directory: "List directory",
  find_files: "Find files",
  search_text: "Search text",
  apply_patch: "Edit files",
  exec_command: "Run command",
  write_stdin: "Interact with process",
  git_status: "Check Git status",
  git_diff: "Review Git diff",
});

export class CaelushToolPresentation implements ToolPresentationPort {
  private readonly resultSanitizer = new CaelushToolResultSanitizer();

  constructor(private readonly options: CaelushToolPresentationOptions) {}

  presentInvocation(input: { readonly invocation: ToolInvocation }): ToolInvocationPresentation {
    const { invocation } = input;
    const title = TOOL_LABELS[invocation.toolName] ?? "Use tool";
    try {
      return { title, summary: this.invocationSummary(invocation) };
    } catch {
      return { title, summary: "Tool requested" };
    }
  }

  presentResult(input: {
    readonly invocation: ToolInvocation;
    readonly result?: ToolExecutionResult;
  }): ToolResultPresentation {
    const title = TOOL_LABELS[input.invocation.toolName] ?? "Use tool";
    if (input.result === undefined) return { title, summary: "Tool finished" };
    try {
      const safe = this.resultSanitizer.sanitize({
        toolName: input.invocation.toolName,
        invocation: input.invocation,
        result: input.result,
      });
      const summary = this.resultSummary(input.invocation, safe);
      if (
        input.invocation.toolName === "read_file" ||
        input.invocation.toolName === "apply_patch"
      ) {
        return {
          title,
          summary,
          output: {
            stream: "stdout",
            chunk:
              input.invocation.toolName === "read_file"
                ? "File content omitted from timeline."
                : "Patch details omitted from timeline.",
          },
        };
      }
      const chunk = boundTerminal(
        redactText(safe.content),
        MAX_PRESENTATION_BYTES,
        this.options.terminalOutputSanitizer,
      );
      return {
        title,
        summary,
        ...(chunk.length === 0 ? {} : { output: { stream: "stdout" as const, chunk } }),
      };
    } catch {
      return { title, summary: "Tool result available" };
    }
  }

  presentShellCommand(input: { readonly invocation: ToolInvocation }): string {
    if (input.invocation.toolName !== "exec_command") return "Run command";
    try {
      const command = input.invocation.args.cmd;
      if (typeof command !== "string" || command.length === 0) return "Run command";
      return (
        boundTerminal(
          redactText(command),
          MAX_COMMAND_BYTES,
          this.options.terminalOutputSanitizer,
        ) || "Run command"
      );
    } catch {
      return "Run command";
    }
  }

  private invocationSummary(invocation: ToolInvocation): string {
    const args = invocation.args;
    switch (invocation.toolName) {
      case "read_file":
        return `Read ${safePath(args.path)}`;
      case "list_directory":
        return `List ${safePath(args.path)}`;
      case "find_files":
        return `Find files in ${safePath(args.path)}`;
      case "search_text":
        return `Search ${safePath(args.path)}`;
      case "apply_patch":
        return "Apply a verified workspace patch";
      case "exec_command":
        return this.presentShellCommand({ invocation });
      case "write_stdin":
        return "Interact with a managed process";
      case "git_status":
        return "Inspect workspace Git status";
      case "git_diff":
        return `Review Git diff${args.path === undefined ? "" : ` for ${safePath(args.path)}`}`;
      default:
        return "Tool requested";
    }
  }

  private resultSummary(invocation: ToolInvocation, result: ToolExecutionResult): string {
    const args = invocation.args;
    if (invocation.toolName === "read_file") {
      const path = safePath(args.path);
      const lines =
        typeof result.details.linesReturned === "number" ? result.details.linesReturned : undefined;
      return lines === undefined ? `Read file ${path}` : `Read file ${path} (${lines} lines)`;
    }
    if (invocation.toolName === "apply_patch") {
      const changes = Array.isArray(result.details.changes)
        ? result.details.changes.length
        : undefined;
      return changes === undefined ? "Patch applied" : `Patch applied (${changes} file changes)`;
    }
    if (result.isError) return "Tool reported a recoverable error";
    if (invocation.toolName === "exec_command" || invocation.toolName === "write_stdin") {
      const status = result.details.status;
      return typeof status === "string" ? `Process ${status.toLowerCase()}` : "Process result";
    }
    return `${TOOL_LABELS[invocation.toolName] ?? "Tool"} completed`;
  }
}

function safePath(value: unknown): string {
  if (typeof value !== "string") return "workspace";
  const normalized = normalizeWorkspaceFactPath(value);
  if (normalized === undefined) return REDACTED_PATH;
  return classifySensitivePath(normalized) === undefined ? normalized : REDACTED_PATH;
}

function boundTerminal(value: string, maxBytes: number, sanitize: TerminalOutputSanitizer): string {
  const sanitized = sanitize(value);
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.byteLength <= maxBytes) return sanitized;
  const marker = "\n… output truncated …\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBytes = Math.max(0, Math.floor((maxBytes - markerBytes) / 2));
  const tailBytes = Math.max(0, maxBytes - markerBytes - headBytes);
  return `${bytes.subarray(0, headBytes).toString("utf8")}${marker}${bytes
    .subarray(bytes.byteLength - tailBytes)
    .toString("utf8")}`;
}
