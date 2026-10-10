import { AccountOperationError } from "../account/controller.js";
import { CloudClientError } from "../cloud/client.js";
import { DesktopDaemonSupervisorError } from "../daemon/supervisor.js";
import { ProfileBackupError } from "../backup/profile-backup.js";
import { DesktopLegacyDataImportError } from "../migration/legacy-data-import.js";
import { ProviderCredentialMigrationError } from "../migration/provider-credential-migration.js";

export interface SafeIpcError {
  readonly code: string;
  readonly message: string;
}

export function safeErrorForIpc(error: unknown): SafeIpcError {
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
  return { code: "REQUEST_FAILED", message: "The desktop request could not be completed." };
}
