import type { AccountState, SafeDevice } from "../main/account/state.js";
import type {
  AcceptedResponse,
  DeviceRevocationResponse,
  OperationSucceededResponse,
} from "../main/cloud/schemas.js";
import type {
  LegacyDataImportResult,
  LegacyDataImportSummary,
  LegacyImportProgress,
} from "../shared/legacy-data-contract.js";
import type {
  DesktopWorkspaceDirectoryPage,
  DesktopWorkspaceTextPreview,
} from "../main/workspace/file-service.js";
import type {
  DesktopTerminalOutput,
  DesktopTerminalSession,
} from "../main/terminal/user-terminal-manager.js";
import type { BrowserGuestBounds, BrowserGuestState } from "../main/browser/guest-manager.js";
import type { DesktopEditorDescriptor, DesktopEditorId } from "../main/ide/editor-resolver.js";

export interface DesktopApi {
  readonly account: {
    getState(): Promise<AccountState>;
    subscribeState(listener: (state: AccountState) => void): () => void;
    register(input: {
      readonly email: string;
      readonly password: string;
    }): Promise<AcceptedResponse>;
    login(input: {
      readonly email: string;
      readonly password: string;
    }): Promise<{ readonly connected: true }>;
    logout(): Promise<{ readonly serverRevoked: boolean }>;
    resendVerification(input: { readonly email: string }): Promise<AcceptedResponse>;
    verifyEmail(input: { readonly verificationToken: string }): Promise<OperationSucceededResponse>;
    forgotPassword(input: { readonly email: string }): Promise<AcceptedResponse>;
    resetPassword(input: {
      readonly resetToken: string;
      readonly newPassword: string;
    }): Promise<OperationSucceededResponse>;
    changePassword(input: {
      readonly currentPassword: string;
      readonly newPassword: string;
    }): Promise<OperationSucceededResponse>;
    refreshNow(): Promise<AccountState>;
    listDevices(): Promise<readonly SafeDevice[]>;
    revokeDevice(input: { readonly deviceId: string }): Promise<DeviceRevocationResponse>;
  };
  readonly window: {
    minimize(): Promise<{ readonly minimized: true }>;
    maximizeOrRestore(): Promise<{ readonly maximized: boolean }>;
    close(): Promise<{ readonly closed: true }>;
    getPlatform(): Promise<{
      readonly platform: string;
      readonly arch: string;
      readonly version: string;
    }>;
  };
  readonly workspace: {
    getAvailability(): Promise<
      | {
          readonly available: true;
        }
      | {
          readonly available: false;
          readonly reason: "ACCOUNT_NOT_AUTHORIZED" | "DAEMON_STARTING";
        }
    >;
    subscribeAvailability(listener: (available: boolean) => void): () => void;
    activate(input: { readonly workspaceId: string | null }): Promise<{ readonly selected: true }>;
    listEntries(input: {
      readonly workspaceId: string;
      readonly relativePath: string;
      readonly offset?: number;
      readonly limit?: number;
    }): Promise<DesktopWorkspaceDirectoryPage>;
    previewText(input: {
      readonly workspaceId: string;
      readonly relativePath: string;
    }): Promise<DesktopWorkspaceTextPreview>;
    listEditors(input: {
      readonly workspaceId: string;
    }): Promise<readonly DesktopEditorDescriptor[]>;
    openInEditor(input: {
      readonly editorId: DesktopEditorId;
      readonly workspaceId: string;
      readonly relativeFilePath?: string;
    }): Promise<{ readonly opened: true; readonly editorId: DesktopEditorId }>;
    readonly terminal: {
      create(input: {
        readonly workspaceId: string;
        readonly cols: number;
        readonly rows: number;
      }): Promise<DesktopTerminalSession>;
      write(input: {
        readonly terminalId: string;
        readonly data: string;
      }): Promise<{ readonly accepted: true }>;
      resize(input: {
        readonly terminalId: string;
        readonly cols: number;
        readonly rows: number;
      }): Promise<{ readonly accepted: true }>;
      close(input: { readonly terminalId: string }): Promise<{ readonly closed: true }>;
      subscribeOutput(
        terminalId: string,
        listener: (output: DesktopTerminalOutput) => void,
      ): Promise<() => void>;
      acknowledgeOutput(input: {
        readonly terminalId: string;
        readonly bytes: number;
      }): Promise<{ readonly acknowledged: true }>;
    };
  };
  readonly browser: {
    getAvailability(): Promise<
      | {
          readonly available: true;
        }
      | {
          readonly available: false;
          readonly reason: "ACCOUNT_NOT_AUTHORIZED" | "DAEMON_STARTING";
        }
    >;
    createLease(input: { readonly bounds: BrowserGuestBounds }): Promise<BrowserGuestState>;
    navigate(input: { readonly leaseId: string; readonly url: string }): Promise<BrowserGuestState>;
    goBack(input: { readonly leaseId: string }): Promise<BrowserGuestState>;
    goForward(input: { readonly leaseId: string }): Promise<BrowserGuestState>;
    reload(input: { readonly leaseId: string }): Promise<BrowserGuestState>;
    setBounds(input: {
      readonly leaseId: string;
      readonly bounds: BrowserGuestBounds | null;
    }): Promise<{ readonly updated: true }>;
    closeLease(input: { readonly leaseId: string }): Promise<{ readonly closed: true }>;
    subscribeState(listener: (state: BrowserGuestState) => void): () => void;
  };
  readonly update: {
    getAvailability(): Promise<{
      readonly available: false;
      readonly reason: "D6_UPDATER_PENDING";
    }>;
  };
  readonly legacyData: {
    inspect(): Promise<LegacyDataImportSummary>;
    import(input: {
      readonly candidateId: string;
      readonly confirmed: true;
    }): Promise<LegacyDataImportResult>;
    resume(): Promise<LegacyDataImportResult>;
    subscribeProgress(listener: (progress: LegacyImportProgress) => void): () => void;
  };
}

export interface DesktopApiErrorShape {
  readonly code: string;
  readonly message: string;
}
