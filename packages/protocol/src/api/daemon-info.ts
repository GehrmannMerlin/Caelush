import { z } from "zod";
import { ApprovalPolicySchema, PermissionProfileSchema } from "../policy.js";
import { RunLimitsSchema } from "../limits.js";
import { RunResourcePolicySchema } from "../resource-policy.js";
import { RuntimeRefSchema } from "../runtime.js";
import { ClientModelSelectionSchema } from "./model-selection.js";

export const DefaultRunConfigurationSchema = z
  .object({
    runtime: RuntimeRefSchema,
    permissionProfile: PermissionProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    limits: RunLimitsSchema.optional(),
    resourcePolicy: RunResourcePolicySchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.limits === undefined) !== (value.resourcePolicy === undefined),
    "exactly one of limits or resourcePolicy is required",
  );
export type DefaultRunConfiguration = z.infer<typeof DefaultRunConfigurationSchema>;

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
    defaultRunConfiguration: DefaultRunConfigurationSchema,
  })
  .strict();
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;
export type DaemonCapabilities = z.infer<typeof DaemonCapabilitiesSchema>;
