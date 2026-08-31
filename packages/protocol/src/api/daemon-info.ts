import { z } from "zod";
import { ClientModelSelectionSchema } from "./model-selection.js";

const DaemonCapabilitiesSchema = z
  .object({
    runExecution: z.literal(true),
    runRecovery: z.literal(true),
    cancellation: z.literal(true),
    approvals: z.literal(true),
    sseReplay: z.literal(true),
  })
  .strict();

export const DaemonInfoSchema = z
  .object({
    apiVersion: z.literal("v1"),
    protocolVersion: z.literal(1),
    daemonVersion: z.string().min(1),
    capabilities: DaemonCapabilitiesSchema,
    runtimeKinds: z.tuple([z.literal("local")]),
    configuredProviders: z.array(z.string().min(1)),
    defaultModel: ClientModelSelectionSchema.optional(),
  })
  .strict();
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;
export type DaemonCapabilities = z.infer<typeof DaemonCapabilitiesSchema>;
