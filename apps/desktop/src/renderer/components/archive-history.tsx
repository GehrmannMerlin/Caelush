import type { ReactElement } from "react";
import type { TranscriptEntry } from "@caelush/protocol";
import { ArrowLeft } from "lucide-react";
import { ArchiveHistorySkeleton } from "./account-page-skeletons.js";
export function ArchiveHistory(props: {
  readonly title: string;
  readonly entries: readonly TranscriptEntry[];
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <section className="archive-history" aria-label="只读会话历史">
      <button className="archive-back" onClick={props.onBack}>
        <ArrowLeft size={16} />
        返回已归档
      </button>
      <h1 tabIndex={-1}>{props.title}</h1>
      <p className="archive-muted">已归档 · 只读</p>
      <div className="archive-transcript" aria-busy={props.loading}>
        {props.entries.map((entry) => (
          <article
            className={`archive-message archive-message--${entry.kind.toLowerCase()}`}
            key={entry.id}
          >
            <h2>
              {entry.kind === "USER"
                ? "你"
                : entry.kind === "ASSISTANT"
                  ? "Caelush"
                  : entry.kind === "TOOL_RESULT"
                    ? entry.toolName
                    : entry.kind === "CUSTOM"
                      ? entry.label
                      : "运行状态"}
            </h2>
            <p>{entry.text}</p>
            {entry.kind === "USER" &&
              entry.attachments?.map((attachment, index) => (
                <small key={index}>{attachment.label ?? attachment.mediaType ?? "附件"}</small>
              ))}
          </article>
        ))}
        {props.loading && <ArchiveHistorySkeleton />}
      </div>
      {props.loading && (
        <span className="visually-hidden" role="status">
          正在加载历史
        </span>
      )}
      {!props.loading && props.entries.length === 0 ? (
        <p className="archive-empty">暂无可展示的历史记录</p>
      ) : null}
      {props.hasMore && (
        <button className="archive-secondary" disabled={props.loading} onClick={props.onLoadMore}>
          加载更多历史
        </button>
      )}
    </section>
  );
}
