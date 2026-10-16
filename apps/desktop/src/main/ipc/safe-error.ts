import { AccountOperationError } from "../account/controller.js";
import { CloudClientError } from "../cloud/client.js";
import { DesktopDaemonSupervisorError } from "../daemon/supervisor.js";
import { ProfileBackupError } from "../backup/profile-backup.js";
import { DesktopLegacyDataImportError } from "../migration/legacy-data-import.js";
import { ProviderCredentialMigrationError } from "../migration/provider-credential-migration.js";
import { DesktopWorkspaceError } from "../workspace/file-service.js";
import { DesktopTerminalError } from "../terminal/user-terminal-manager.js";
import { BrowserGuestError } from "../browser/url-policy.js";
import { DesktopEditorError } from "../ide/editor-resolver.js";
import { DesktopUpdateError } from "../update/error.js";
import { CaelushClientHttpError } from "@caelush/client";
import { DesktopArchiveError } from "../archive/controller.js";

export interface SafeIpcError {
  readonly code: string;
  readonly message: string;
}

export function safeErrorForIpc(error: unknown): SafeIpcError {
  if (error instanceof DesktopArchiveError) return { code: error.code, message: error.message };
  if (error instanceof CaelushClientHttpError) {
    const messages: Partial<Record<typeof error.code, string>> = {
      INVALID_REQUEST: "归档请求无效，请重新操作。",
      NOT_FOUND: "记录已不存在，请刷新列表。",
      ACTIVE_RUN_CONFLICT: "请先结束任务，再归档。",
      OBJECT_ARCHIVED: "该会话已归档，请先恢复。",
      WORKSPACE_ARCHIVED: "该工作区已归档，请先恢复。",
      PARENT_WORKSPACE_ARCHIVED: "请先恢复所属工作区。",
      WORKSPACE_UNAVAILABLE: "原工作区不可用，暂时无法恢复。",
      ARCHIVE_LIST_CHANGED: "归档列表已变化，请刷新。",
      ARCHIVE_SELECTION_CHANGED: "删除范围已变化，请重新预览确认。",
      ARCHIVE_CONFIRMATION_EXPIRED: "删除确认已过期，请重新预览。",
      DATA_OWNERSHIP_CONFLICT: "关联数据归属存在冲突，未删除任何记录。",
    };
    const message = messages[error.code];
    if (message !== undefined) return { code: error.code, message };
  }
  if (error instanceof DesktopUpdateError) return { code: error.code, message: error.message };
  if (error instanceof AccountOperationError || error instanceof CloudClientError) {
    return { code: error.code.slice(0, 64), message: error.message.slice(0, 512) };
  }
  if (error instanceof DesktopDaemonSupervisorError) {
    return { code: error.failureKind, message: error.message.slice(0, 512) };
  }
  if (
    error instanceof ProfileBackupError ||
    error instanceof DesktopLegacyDataImportError ||
    error instanceof ProviderCredentialMigrationError
  ) {
    return { code: error.code, message: error.message.slice(0, 512) };
  }
  if (
    error instanceof DesktopWorkspaceError ||
    error instanceof DesktopTerminalError ||
    error instanceof BrowserGuestError ||
    error instanceof DesktopEditorError
  ) {
    return { code: error.code, message: error.message.slice(0, 512) };
  }
  return { code: "REQUEST_FAILED", message: "The desktop request could not be completed." };
}
