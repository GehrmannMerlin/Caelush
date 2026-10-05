import type { ToolInvocation } from "@caelush/protocol";
import type {
  AgentToolExecutionResult,
  ToolInvocationPresentation,
  ToolPresentationPort,
  ToolResultPresentation,
} from "@caelush/agent";
import { redactText } from "./secret-redaction.js";
import { classifySensitivePath, normalizeWorkspaceFactPath } from "./sensitive-path.js";
import { CaelushToolResultSanitizer } from "./tool-result-sanitizer.js";

const MAX_PRESENTATION_BYTES = 8 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024;
const REDACTED_PATH = "[敏感路径]";

export type TerminalOutputSanitizer = (value: string) => string;

export interface CaelushToolPresentationOptions {
  readonly terminalOutputSanitizer: TerminalOutputSanitizer;
}

const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  read_file: "读取文件",
  list_directory: "浏览目录",
  find_files: "查找文件",
  search_text: "搜索文本",
  apply_patch: "编辑文件",
  exec_command: "执行命令",
  write_stdin: "与进程交互",
  stop_process: "停止进程",
  git_status: "查看 Git 状态",
  git_diff: "查看 Git 差异",
});

export class CaelushToolPresentation implements ToolPresentationPort {
  private readonly resultSanitizer = new CaelushToolResultSanitizer();

  constructor(private readonly options: CaelushToolPresentationOptions) {}

  presentInvocation(input: { readonly invocation: ToolInvocation }): ToolInvocationPresentation {
    const { invocation } = input;
    const title = TOOL_LABELS[invocation.toolName] ?? "使用工具";
    try {
      return { title, summary: this.invocationSummary(invocation) };
    } catch {
      return { title, summary: "请求使用工具" };
    }
  }

  presentResult(input: {
    readonly invocation: ToolInvocation;
    readonly result?: AgentToolExecutionResult;
  }): ToolResultPresentation {
    const title = TOOL_LABELS[input.invocation.toolName] ?? "使用工具";
    if (input.result === undefined) {
      return {
        title,
        summary: failureSummary(input.invocation) ?? "工具已完成",
      };
    }
    try {
      const sanitized = this.resultSanitizer.sanitize({
        toolName: input.invocation.toolName,
        invocation: input.invocation,
        result: input.result,
      });
      if (sanitized.kind === "REFUSED") {
        return {
          title,
          summary: failureSummary(input.invocation, input.result.isError) ?? "工具输出无法安全使用",
        };
      }
      const safe = sanitized.result;
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
                ? "文件内容已从过程视图中省略。"
                : "补丁详情已从过程视图中省略。",
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
      return { title, summary: "工具结果可用" };
    }
  }

  presentShellCommand(input: { readonly invocation: ToolInvocation }): string {
    if (input.invocation.toolName !== "exec_command") return "执行命令";
    try {
      const command = input.invocation.args.cmd;
      if (typeof command !== "string" || command.length === 0) return "执行命令";
      return (
        boundTerminal(
          redactText(command),
          MAX_COMMAND_BYTES,
          this.options.terminalOutputSanitizer,
        ) || "执行命令"
      );
    } catch {
      return "执行命令";
    }
  }

  private invocationSummary(invocation: ToolInvocation): string {
    const args = invocation.args;
    switch (invocation.toolName) {
      case "read_file":
        return `读取 ${safePath(args.path)}`;
      case "list_directory":
        return `浏览目录 ${safePath(args.path)}`;
      case "find_files":
        return `在 ${safePath(args.path)} 中查找文件`;
      case "search_text":
        return `搜索 ${safePath(args.path)}`;
      case "apply_patch":
        return "应用已验证的工作区补丁";
      case "exec_command":
        return this.presentShellCommand({ invocation });
      case "write_stdin":
        return "与受控进程交互";
      case "stop_process":
        return "停止受控进程会话";
      case "git_status":
        return "查看工作区 Git 状态";
      case "git_diff":
        return `查看 Git 差异${args.path === undefined ? "" : `：${safePath(args.path)}`}`;
      default:
        return "请求使用工具";
    }
  }

  private resultSummary(invocation: ToolInvocation, result: AgentToolExecutionResult): string {
    const failure = failureSummary(invocation, result.isError);
    if (failure !== undefined) return failure;

    const args = invocation.args;
    if (invocation.toolName === "read_file") {
      const path = safePath(args.path);
      const lines =
        typeof result.details.linesReturned === "number" ? result.details.linesReturned : undefined;
      return lines === undefined ? `读取文件 ${path}` : `读取文件 ${path}（${lines} 行）`;
    }
    if (invocation.toolName === "apply_patch") {
      const changes = Array.isArray(result.details.changes)
        ? result.details.changes.length
        : undefined;
      return changes === undefined ? "补丁已应用" : `补丁已应用（修改 ${changes} 个文件）`;
    }
    if (
      invocation.toolName === "exec_command" ||
      invocation.toolName === "write_stdin" ||
      invocation.toolName === "stop_process"
    ) {
      const status = result.details.status;
      if (typeof status !== "string") return "进程结果";
      const summary = `进程${translateProcessStatus(status)}`;
      const exitCode = result.details.exitCode;
      return status === "EXITED" && typeof exitCode === "number" && Number.isInteger(exitCode)
        ? `${summary}（退出码 ${exitCode}）`
        : summary;
    }
    return `${TOOL_LABELS[invocation.toolName] ?? "工具"}已完成`;
  }
}

function failureSummary(invocation: ToolInvocation, resultIsError = false): string | undefined {
  const error = invocation.error;
  if (
    error?.code === "TOOL_OUTCOME_UNKNOWN" ||
    error?.details?.executionDisposition === "UNCERTAIN_SIDE_EFFECT"
  ) {
    return "工具结果未知，请勿自动重试";
  }

  let summary: string | undefined;
  if (error?.code === "TOOL_OUTPUT_ERROR") summary = "工具输出无法安全使用";
  else if (error !== undefined || resultIsError) summary = "工具执行失败";
  if (summary === undefined) return undefined;
  return error?.retryable === true ? `${summary}（可重试）` : summary;
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
  const marker = "\n… 输出过长，已截断 …\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBytes = Math.max(0, Math.floor((maxBytes - markerBytes) / 2));
  const tailBytes = Math.max(0, maxBytes - markerBytes - headBytes);
  return `${bytes.subarray(0, headBytes).toString("utf8")}${marker}${bytes
    .subarray(bytes.byteLength - tailBytes)
    .toString("utf8")}`;
}

function translateProcessStatus(status: string): string {
  switch (status) {
    case "REQUESTED":
      return "已请求";
    case "WAITING_APPROVAL":
      return "等待批准";
    case "WAITING_RESOURCE":
      return "等待资源";
    case "RUNNING":
      return "运行中";
    case "EXITED":
      return "已退出";
    case "COMPLETED":
      return "已完成";
    case "FAILED":
      return "失败";
    case "CANCELLED":
      return "已取消";
    default:
      return "状态未知";
  }
}
