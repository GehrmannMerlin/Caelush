export function archiveErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const messages: Record<string, string> = {
    ACTIVE_RUN_CONFLICT: "请先结束任务，再归档。",
    OBJECT_ARCHIVED: "该会话已归档，请在归档页恢复后操作。",
    WORKSPACE_ARCHIVED: "该工作区已归档，请在归档页恢复。",
    PARENT_WORKSPACE_ARCHIVED: "请先恢复所属工作区，再恢复会话。",
    WORKSPACE_UNAVAILABLE: "原工作区不可用，暂时无法恢复。",
    ARCHIVE_LIST_CHANGED: "归档列表已变化，请刷新后重试。",
    ARCHIVE_SELECTION_CHANGED: "删除范围已变化，请重新确认。",
    ARCHIVE_CONFIRMATION_EXPIRED: "删除确认已过期，请重新预览。",
    DATA_OWNERSHIP_CONFLICT: "关联数据的归属存在冲突，未删除任何记录。",
    ARCHIVE_MANAGEMENT_UNAVAILABLE: "当前本地服务版本不支持归档管理，请更新客户端后重试。",
    ARCHIVE_SCOPE_CHANGED: "当前账号或本地服务已切换，请刷新归档页并检查最新状态。",
    DESKTOP_ACCOUNT_UNAUTHORIZED: "当前桌面账号尚未完成授权，请先登录并授权后再管理归档。",
    NOT_FOUND: "记录已不存在，请刷新列表。",
  };
  return messages[code] ?? "归档操作未完成，请稍后重试。";
}
