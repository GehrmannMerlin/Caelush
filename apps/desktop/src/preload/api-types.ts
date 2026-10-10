import type { AccountState, SafeDevice } from "../main/account/state.js";
import type {
  AcceptedResponse,
  DeviceRevocationResponse,
  OperationSucceededResponse,
} from "../main/cloud/schemas.js";

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
    getAvailability(): Promise<{
      readonly available: false;
      readonly reason: "D4_LOCAL_AGENT_PENDING";
    }>;
  };
  readonly browser: {
    getAvailability(): Promise<{
      readonly available: false;
      readonly reason: "D4_LOCAL_AGENT_PENDING";
    }>;
  };
  readonly update: {
    getAvailability(): Promise<{
      readonly available: false;
      readonly reason: "D6_UPDATER_PENDING";
    }>;
  };
}

export interface DesktopApiErrorShape {
  readonly code: string;
  readonly message: string;
}
