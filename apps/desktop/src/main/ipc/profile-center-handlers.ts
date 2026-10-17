import { z } from "zod";
import {
  AccountCenterQuerySchema,
  AccountCenterSnapshotSchema,
  DesktopModelSettingsSnapshotSchema,
  DesktopProviderSettingsConnectInputSchema,
  DesktopProviderSettingsConnectionResultSchema,
  DesktopProviderSettingsDisconnectInputSchema,
} from "../profile-center/contract.js";
import type { DesktopProfileCenterController } from "../profile-center/controller.js";
import type { DesktopArchiveIpcRegistrar } from "./archive-handlers.js";

export const PROFILE_CENTER_IPC_CHANNELS = Object.freeze({
  getSnapshot: "caelush:profile-center:get-snapshot",
  getModelSettings: "caelush:profile-center:get-model-settings",
  connectProvider: "caelush:profile-center:connect-provider",
  disconnectProvider: "caelush:profile-center:disconnect-provider",
});

const authorized = new Set(["AUTHENTICATED_ONLINE", "AUTHORIZED_OFFLINE"]);

export function registerProfileCenterHandlers(
  register: DesktopArchiveIpcRegistrar,
  controller: DesktopProfileCenterController,
): void {
  register(
    PROFILE_CENTER_IPC_CHANNELS.getSnapshot,
    AccountCenterQuerySchema,
    AccountCenterSnapshotSchema,
    (input, signal) => controller.getSnapshot(input, signal),
    authorized,
  );
  register(
    PROFILE_CENTER_IPC_CHANNELS.getModelSettings,
    z.undefined(),
    DesktopModelSettingsSnapshotSchema,
    (_input, signal) => controller.getModelSettings(signal),
    authorized,
  );
  register(
    PROFILE_CENTER_IPC_CHANNELS.connectProvider,
    DesktopProviderSettingsConnectInputSchema,
    DesktopProviderSettingsConnectionResultSchema,
    (input, signal) => controller.connectProvider(input, signal),
    authorized,
  );
  register(
    PROFILE_CENTER_IPC_CHANNELS.disconnectProvider,
    DesktopProviderSettingsDisconnectInputSchema,
    z.boolean(),
    (input, signal) => controller.disconnectProvider(input, signal),
    authorized,
  );
}
