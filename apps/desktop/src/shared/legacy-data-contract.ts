export type LegacyDataSourceKind = "DEFAULT_HOME" | "CUSTOM_HOME";
export type LegacyImportProgress =
  | "BACKUP_VERIFIED"
  | "IMPORT_STAGED"
  | "DESTINATION_VERIFIED"
  | "CREDENTIALS_SECURED"
  | "COMMITTED"
  | "RECOVERY_REQUIRED";
export type LegacyImportBlockReason =
  "SOURCE_UNREADABLE" | "UNSUPPORTED_SCHEMA" | "TARGET_NOT_EMPTY" | "NO_IMPORTABLE_DATA";

export interface LegacyDataSourceSummary {
  readonly candidateId: string;
  readonly sourceLabel: string;
  readonly sourceKind: LegacyDataSourceKind;
  readonly importable: boolean;
  readonly reason?: LegacyImportBlockReason;
  readonly workspaces: number;
  readonly sessions: number;
  readonly runs: number;
  readonly messages: number;
  readonly durableEvents: number;
  readonly contextCheckpoints: number;
  readonly toolExecutions: number;
  readonly providerCredentials: number;
  readonly modelSelections: number;
  readonly privateReplayFiles: number;
  readonly estimatedBytes: number;
}

export interface LegacyDataImportSummary {
  readonly sources: readonly LegacyDataSourceSummary[];
  readonly pendingRecovery: boolean;
  readonly recoveryState?: "IMPORT_STAGED" | "DESTINATION_VERIFIED" | "RECOVERY_BLOCKED";
}

export interface LegacyDataImportResult {
  readonly state: "COMMITTED";
  readonly profileId: string;
  readonly backupId: string;
  readonly credentialCount: number;
  readonly imported: Omit<
    LegacyDataSourceSummary,
    "candidateId" | "sourceLabel" | "sourceKind" | "importable" | "reason"
  >;
}

export interface LegacyDataImportPreparedResult extends Omit<LegacyDataImportResult, "state"> {
  readonly state: "DESTINATION_VERIFIED";
}
