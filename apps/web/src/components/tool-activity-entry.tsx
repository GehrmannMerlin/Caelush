import {
  ChevronDown,
  CircleStop,
  FileSearch,
  FileText,
  GitBranch,
  GitCompareArrows,
  FolderOpen,
  Pencil,
  Search,
  SquareTerminal,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  toolPresentationCategory,
  type ToolPresentationCategory,
  type ToolPresentationEffect,
  type ToolPresentationPhase,
  type TurnPresentationItemStatus,
} from "@caelush/protocol";
import type { LiveActivityKind, LiveActivityStatus } from "@caelush/client";

interface ToolPresentationFact {
  readonly key: string;
  readonly value: string;
}

export interface ToolActivityEntryProps {
  readonly id: string;
  readonly toolName: string;
  readonly category?: ToolPresentationCategory | undefined;
  readonly status: TurnPresentationItemStatus;
  readonly phase?: ToolPresentationPhase | undefined;
  readonly title: string;
  readonly summary: string;
  readonly invocation?: string | undefined;
  readonly facts: readonly ToolPresentationFact[];
  readonly effects: readonly ToolPresentationEffect[];
  readonly preview?: string | undefined;
  readonly toolInvocationId?: string | undefined;
  readonly conversationTurnId?: string | undefined;
  readonly live?: boolean | undefined;
}

const TOOL_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  read_file: FileText,
  list_directory: FolderOpen,
  find_files: FileSearch,
  search_text: Search,
  apply_patch: Pencil,
  exec_command: SquareTerminal,
  write_stdin: Terminal,
  stop_process: CircleStop,
  git_status: GitBranch,
  git_diff: GitCompareArrows,
});

const CATEGORY_ICONS: Readonly<Record<ToolPresentationCategory, LucideIcon>> = Object.freeze({
  READ: FileText,
  SEARCH: Search,
  EDIT: Pencil,
  COMMAND: SquareTerminal,
  PROCESS: Terminal,
  GIT: GitBranch,
  OTHER: Wrench,
});

export function ToolActivityEntry({
  id,
  toolName,
  category: providedCategory,
  status,
  phase,
  title,
  summary,
  invocation,
  facts,
  effects,
  preview,
  toolInvocationId,
  conversationTurnId,
  live = false,
}: ToolActivityEntryProps) {
  const category = providedCategory ?? toolPresentationCategory(toolName);
  const action = toolActionLabel(toolName, category, status, phase, title);
  const subject = actionSubject(toolName, invocation, effects);
  const Icon = TOOL_ICONS[toolName] ?? CATEGORY_ICONS[category];
  const safeFacts = facts.filter((fact) => fact.key !== "调用");
  const visibleEffects = effects.filter((effect) => effect.type === "FILE_CHANGE");
  const command = toolName === "exec_command";
  const effectTitle = formatEffectCollection(visibleEffects);

  return (
    <details
      className={`turn-presentation-tool-entry turn-presentation-tool-entry--${status.toLowerCase()}${live ? " turn-presentation-tool-entry--live" : ""}`}
      data-tool-category={category}
      data-tool-name={toolName}
      data-tool-invocation-id={toolInvocationId}
      data-conversation-turn-id={conversationTurnId}
      aria-label={`${action}${subject.length === 0 ? "" : ` ${subject}`}`}
      key={id}
    >
      <summary
        className="turn-presentation-tool-row"
        aria-label={`查看${action}详情`}
        title={subject}
      >
        <Icon className="turn-presentation-tool-icon" size={16} aria-hidden="true" />
        <span className="turn-presentation-tool-action">{action}</span>
        {subject.length === 0 ? null : (
          <span className="turn-presentation-tool-subject">{subject}</span>
        )}
        {effectTitle === undefined ? null : (
          <>
            {effectTitle.additions === undefined ? null : (
              <span className="turn-presentation-tool-edit-counts turn-presentation-tool-effect-additions">
                +{effectTitle.additions}
              </span>
            )}
            {effectTitle.deletions === undefined ? null : (
              <span className="turn-presentation-tool-edit-counts turn-presentation-tool-effect-deletions">
                -{effectTitle.deletions}
              </span>
            )}
          </>
        )}
        {status === "STREAMING" ? (
          <span className="turn-presentation-tool-active" aria-label="进行中" />
        ) : null}
        {status === "FAILED" ? <span className="turn-presentation-tool-state">失败</span> : null}
        {status === "CANCELLED" ? (
          <span className="turn-presentation-tool-state">已取消</span>
        ) : null}
        <ChevronDown className="turn-presentation-tool-chevron" size={15} aria-hidden="true" />
      </summary>
      <div className="turn-presentation-tool-details-content">
        {command ? (
          <section className="turn-presentation-command">
            <p className="turn-presentation-tool-detail-label">Shell</p>
            {invocation === undefined || invocation.length === 0 ? null : (
              <pre className="turn-presentation-tool-command">{invocation}</pre>
            )}
            {summary.length === 0 || summary === invocation ? null : (
              <p className="turn-presentation-tool-result">{summary}</p>
            )}
            {preview === undefined || preview.length === 0 ? null : (
              <>
                <p className="turn-presentation-tool-detail-label">输出</p>
                <pre className="turn-presentation-tool-output">{preview}</pre>
              </>
            )}
          </section>
        ) : (
          <>
            <p className="turn-presentation-tool-result">{summary}</p>
            {visibleEffects.length === 0 ? null : (
              <ul className="turn-presentation-tool-effects" aria-label="文件变化">
                {visibleEffects.map((effect, index) => (
                  <li key={`${id}:effect:${index}`} className="turn-presentation-tool-effect">
                    {renderToolEffect(effect)}
                  </li>
                ))}
              </ul>
            )}
            {preview === undefined || preview.length === 0 ? null : (
              <pre className="turn-presentation-preview">{preview}</pre>
            )}
          </>
        )}
        {effectTitle === undefined ? null : (
          <p className="turn-presentation-tool-change-summary">{effectTitle.detail}</p>
        )}
        {safeFacts.length === 0 ? null : (
          <dl className="turn-presentation-facts">
            {safeFacts.map((fact) => (
              <div key={`${id}:${fact.key}`}>
                <dt>{fact.key}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  );
}

export interface LiveOutputEntryProps {
  readonly id: string;
  readonly kind: Extract<LiveActivityKind, "TOOL_OUTPUT" | "SHELL_OUTPUT" | "PROCESS_OUTPUT">;
  readonly status: LiveActivityStatus;
  readonly text: string;
  readonly conversationTurnId?: string | undefined;
}

/** Terminal output is available on demand and never expands automatically. */
export function LiveOutputEntry({
  id,
  kind,
  status,
  text,
  conversationTurnId,
}: LiveOutputEntryProps) {
  const label =
    kind === "SHELL_OUTPUT" ? "命令输出" : kind === "PROCESS_OUTPUT" ? "进程输出" : "工具输出";
  const Icon =
    kind === "TOOL_OUTPUT" ? Wrench : kind === "PROCESS_OUTPUT" ? Terminal : SquareTerminal;

  return (
    <details
      className={`turn-presentation-tool-entry turn-presentation-output-entry turn-presentation-tool-entry--${status.toLowerCase()}`}
      data-output-kind={kind}
      data-conversation-turn-id={conversationTurnId}
      aria-label={`展开${label}`}
      key={id}
    >
      <summary className="turn-presentation-tool-row" aria-label={`展开${label}`} title={label}>
        <Icon className="turn-presentation-tool-icon" size={16} aria-hidden="true" />
        <span className="turn-presentation-tool-action">{label}</span>
        <span className="turn-presentation-tool-subject">{outputStatusLabel(status)}</span>
        {status === "FAILED" ? <span className="turn-presentation-tool-state">失败</span> : null}
        {status === "CANCELLED" ? (
          <span className="turn-presentation-tool-state">已取消</span>
        ) : null}
        {status === "ACTIVE" ? (
          <span className="turn-presentation-tool-active" aria-label="进行中" />
        ) : null}
        <ChevronDown className="turn-presentation-tool-chevron" size={15} aria-hidden="true" />
      </summary>
      <div className="turn-presentation-tool-details-content">
        <p className="turn-presentation-tool-detail-label">{label}</p>
        {text.length === 0 ? null : <pre className="turn-presentation-tool-output">{text}</pre>}
      </div>
    </details>
  );
}

function outputStatusLabel(status: LiveActivityStatus): string {
  switch (status) {
    case "ACTIVE":
      return "正在接收";
    case "COMPLETED":
      return "已接收";
    case "FAILED":
      return "接收失败";
    case "CANCELLED":
      return "已取消";
  }
}

function toolActionLabel(
  toolName: string,
  category: ToolPresentationCategory,
  status: TurnPresentationItemStatus,
  phase: ToolPresentationPhase | undefined,
  title: string,
): string {
  const currentPhase = phase ?? (status === "STREAMING" ? "RUNNING" : status);
  if (currentPhase === "WAITING_APPROVAL") return `等待批准：${title}`;
  if (currentPhase === "REQUESTED") return `正在调用${title}`;

  if (status === "FAILED") return `${toolVerb(toolName, category, title, "failed")}`;
  if (status === "CANCELLED") return `${toolVerb(toolName, category, title, "cancelled")}`;
  if (status === "STREAMING" || currentPhase === "RUNNING") {
    return toolVerb(toolName, category, title, "active");
  }
  return toolVerb(toolName, category, title, "completed");
}

function toolVerb(
  toolName: string,
  category: ToolPresentationCategory,
  title: string,
  state: "active" | "completed" | "failed" | "cancelled",
): string {
  const actions: Readonly<
    Record<string, Readonly<Record<"active" | "completed" | "failed" | "cancelled", string>>>
  > = {
    read_file: {
      active: "正在读取文件",
      completed: "已读取",
      failed: "读取失败",
      cancelled: "已取消读取",
    },
    list_directory: {
      active: "正在浏览目录",
      completed: "已浏览目录",
      failed: "浏览目录失败",
      cancelled: "已取消浏览目录",
    },
    find_files: {
      active: "正在查找文件",
      completed: "已查找文件",
      failed: "查找文件失败",
      cancelled: "已取消查找文件",
    },
    search_text: {
      active: "正在搜索",
      completed: "已搜索",
      failed: "搜索失败",
      cancelled: "已取消搜索",
    },
    apply_patch: {
      active: "正在编辑文件",
      completed: "已编辑",
      failed: "编辑失败",
      cancelled: "已取消编辑",
    },
    exec_command: {
      active: "正在运行命令",
      completed: "已运行",
      failed: "命令执行失败",
      cancelled: "已取消命令",
    },
    write_stdin: {
      active: "正在与进程交互",
      completed: "已与进程交互",
      failed: "进程交互失败",
      cancelled: "已取消进程交互",
    },
    stop_process: {
      active: "正在请求停止进程",
      completed: "已请求停止进程",
      failed: "停止进程失败",
      cancelled: "已取消停止请求",
    },
    git_status: {
      active: "正在查看 Git 状态",
      completed: "已查看 Git 状态",
      failed: "查看 Git 状态失败",
      cancelled: "已取消 Git 状态检查",
    },
    git_diff: {
      active: "正在查看 Git 差异",
      completed: "已查看 Git 差异",
      failed: "查看 Git 差异失败",
      cancelled: "已取消 Git 差异检查",
    },
  };
  const knownAction = actions[toolName]?.[state];
  if (knownAction !== undefined) return knownAction;
  if (state === "active") return `正在${title}`;
  if (state === "failed") return `${title}失败`;
  if (state === "cancelled") return `${title}已取消`;
  return category === "OTHER" ? `已${title}` : `${title}已完成`;
}

function actionSubject(
  toolName: string,
  invocation: string | undefined,
  effects: readonly ToolPresentationEffect[],
): string {
  if (toolName === "apply_patch") return formatEffectCollection(effects)?.subject ?? "";
  if (invocation === undefined) return "";
  switch (toolName) {
    case "read_file":
      return stripPrefix(invocation, "读取 ");
    case "list_directory":
      return stripPrefix(invocation, "浏览目录 ");
    case "find_files": {
      const match = /^在 (.+) 中查找文件$/u.exec(invocation);
      return match?.[1] ?? invocation;
    }
    case "search_text":
      return stripPrefix(invocation, "搜索 ");
    case "exec_command":
      return invocation;
    case "git_diff":
      return stripPrefix(invocation, "查看 Git 差异").replace(/^：/u, "");
    case "git_status":
    case "write_stdin":
    case "stop_process":
      return "";
    default:
      return invocation;
  }
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function formatEffectCollection(effects: readonly ToolPresentationEffect[]) {
  const changes = effects.flatMap((effect) => {
    if (effect.type !== "FILE_CHANGE") return [];
    const path =
      effect.changeType === "MOVED" && effect.fromPath !== undefined
        ? `${effect.fromPath} → ${effect.path}`
        : effect.path;
    const label =
      effect.changeType === "CREATED"
        ? "新建"
        : effect.changeType === "DELETED"
          ? "删除"
          : effect.changeType === "MOVED"
            ? "移动"
            : "修改";
    return [
      {
        path,
        label,
        ...(effect.additions === undefined || effect.additions === 0
          ? {}
          : { additions: effect.additions }),
        ...(effect.deletions === undefined || effect.deletions === 0
          ? {}
          : { deletions: effect.deletions }),
      },
    ];
  });
  if (changes.length === 0) return undefined;
  if (changes.length === 1) {
    const change = changes[0]!;
    const counts = [
      change.additions === undefined ? undefined : `+${change.additions}`,
      change.deletions === undefined ? undefined : `-${change.deletions}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    return {
      subject: change.path,
      additions: change.additions,
      deletions: change.deletions,
      detail: `${change.path} · ${change.label}${counts.length === 0 ? "" : ` · ${counts}`}`,
    };
  }
  const additions = changes.reduce((total, change) => total + (change.additions ?? 0), 0);
  const deletions = changes.reduce((total, change) => total + (change.deletions ?? 0), 0);
  const detailCounts = [
    additions === 0 ? undefined : `+${additions}`,
    deletions === 0 ? undefined : `-${deletions}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  return {
    subject: `${changes.length} 个文件`,
    ...(additions === 0 ? {} : { additions }),
    ...(deletions === 0 ? {} : { deletions }),
    detail: `${changes.map((change) => `${change.path} · ${change.label}`).join("；")}${detailCounts.length === 0 ? "" : ` · ${detailCounts}`}`,
  };
}

function renderToolEffect(effect: ToolPresentationEffect) {
  if (effect.type !== "FILE_CHANGE") return null;
  const path =
    effect.changeType === "MOVED" && effect.fromPath !== undefined
      ? `${effect.fromPath} → ${effect.path}`
      : effect.path;
  const label =
    effect.changeType === "CREATED"
      ? "新建"
      : effect.changeType === "DELETED"
        ? "删除"
        : effect.changeType === "MOVED"
          ? "移动"
          : "修改";
  return (
    <>
      <span>{path}</span>
      <span className="turn-presentation-tool-effect-kind">{label}</span>
      {effect.additions === undefined || effect.additions === 0 ? null : (
        <span className="turn-presentation-tool-effect-additions">+{effect.additions}</span>
      )}
      {effect.deletions === undefined || effect.deletions === 0 ? null : (
        <span className="turn-presentation-tool-effect-deletions">-{effect.deletions}</span>
      )}
    </>
  );
}
