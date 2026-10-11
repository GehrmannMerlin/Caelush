import { z } from "zod";
export const UpdateStateSchema = z
  .object({
    status: z.enum([
      "IDLE",
      "CHECKING",
      "NO_POLICY",
      "UP_TO_DATE",
      "UPDATE_AVAILABLE",
      "DOWNLOADING",
      "VERIFYING",
      "READY_TO_INSTALL",
      "WAITING_FOR_SAFE_SHUTDOWN",
      "INSTALLING",
      "INSTALL_DEFERRED",
      "COMPLETED",
      "ERROR",
    ]),
    currentVersion: z.string().max(256),
    latestVersion: z.string().max(256).nullable(),
    releaseNotes: z.string().max(16384),
    artifactSize: z.number().int().nonnegative().safe(),
    downloadedBytes: z.number().int().nonnegative().safe(),
    mandatory: z.boolean(),
    graceDeadline: z.string().max(64).nullable(),
    errorCode: z.string().max(64).nullable(),
    message: z.string().max(512),
  })
  .strict();
export type DesktopUpdateState = z.infer<typeof UpdateStateSchema>;
