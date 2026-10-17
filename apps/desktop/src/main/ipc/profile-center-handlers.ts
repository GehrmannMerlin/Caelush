import { UsageSummaryQuerySchema } from "@caelush/protocol";
import { AccountCenterSnapshotSchema } from "../profile-center/contract.js";
import type { DesktopProfileCenterController } from "../profile-center/controller.js";
import type { DesktopArchiveIpcRegistrar } from "./archive-handlers.js";

export const PROFILE_CENTER_IPC_CHANNELS = Object.freeze({
  getSnapshot: "caelush:profile-center:get-snapshot",
});

const authorized = new Set(["AUTHENTICATED_ONLINE", "AUTHORIZED_OFFLINE"]);

export function registerProfileCenterHandlers(
  register: DesktopArchiveIpcRegistrar,
  controller: DesktopProfileCenterController,
): void {
  register(
    PROFILE_CENTER_IPC_CHANNELS.getSnapshot,
    UsageSummaryQuerySchema,
    AccountCenterSnapshotSchema,
    (input, signal) => controller.getSnapshot(input, signal),
    authorized,
  );
}
