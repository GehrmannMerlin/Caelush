import { validate as validateUuid, v7, version as uuidVersion } from "uuid";
import { z } from "zod";

const uuidV7Pattern = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function createPrefixedIdSchema<const Prefix extends string, const Brand extends string>(
  prefix: Prefix,
) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}${uuidV7Pattern}$`))
    .refine((value) => {
      const uuid = value.slice(prefix.length);
      return validateUuid(uuid) && uuidVersion(uuid) === 7;
    }, "Identifier must contain a valid UUIDv7")
    .brand<Brand>();
}

const sessionId = createPrefixedIdSchema<"ses_", "SessionId">("ses_");
export const SessionIdSchema = sessionId;
export type SessionId = z.infer<typeof SessionIdSchema>;
export function createSessionId(): SessionId {
  return SessionIdSchema.parse(`ses_${v7()}`);
}

const runId = createPrefixedIdSchema<"run_", "RunId">("run_");
export const RunIdSchema = runId;
export type RunId = z.infer<typeof RunIdSchema>;
export function createRunId(): RunId {
  return RunIdSchema.parse(`run_${v7()}`);
}

const stepId = createPrefixedIdSchema<"stp_", "StepId">("stp_");
export const StepIdSchema = stepId;
export type StepId = z.infer<typeof StepIdSchema>;
export function createStepId(): StepId {
  return StepIdSchema.parse(`stp_${v7()}`);
}

const eventId = createPrefixedIdSchema<"evt_", "EventId">("evt_");
export const EventIdSchema = eventId;
export type EventId = z.infer<typeof EventIdSchema>;
export function createEventId(): EventId {
  return EventIdSchema.parse(`evt_${v7()}`);
}

const toolInvocationId = createPrefixedIdSchema<"tinv_", "ToolInvocationId">("tinv_");
export const ToolInvocationIdSchema = toolInvocationId;
export type ToolInvocationId = z.infer<typeof ToolInvocationIdSchema>;
export function createToolInvocationId(): ToolInvocationId {
  return ToolInvocationIdSchema.parse(`tinv_${v7()}`);
}

const observationId = createPrefixedIdSchema<"obs_", "ObservationId">("obs_");
export const ObservationIdSchema = observationId;
export type ObservationId = z.infer<typeof ObservationIdSchema>;
export function createObservationId(): ObservationId {
  return ObservationIdSchema.parse(`obs_${v7()}`);
}

const approvalRequestId = createPrefixedIdSchema<"apr_", "ApprovalRequestId">("apr_");
export const ApprovalRequestIdSchema = approvalRequestId;
export type ApprovalRequestId = z.infer<typeof ApprovalRequestIdSchema>;
export function createApprovalRequestId(): ApprovalRequestId {
  return ApprovalRequestIdSchema.parse(`apr_${v7()}`);
}

const verificationResultId = createPrefixedIdSchema<"ver_", "VerificationResultId">("ver_");
export const VerificationResultIdSchema = verificationResultId;
export type VerificationResultId = z.infer<typeof VerificationResultIdSchema>;
export function createVerificationResultId(): VerificationResultId {
  return VerificationResultIdSchema.parse(`ver_${v7()}`);
}

const planItemId = createPrefixedIdSchema<"plan_", "PlanItemId">("plan_");
export const PlanItemIdSchema = planItemId;
export type PlanItemId = z.infer<typeof PlanItemIdSchema>;
export function createPlanItemId(): PlanItemId {
  return PlanItemIdSchema.parse(`plan_${v7()}`);
}

const workspaceId = createPrefixedIdSchema<"wsp_", "WorkspaceId">("wsp_");
export const WorkspaceIdSchema = workspaceId;
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export function createWorkspaceId(): WorkspaceId {
  return WorkspaceIdSchema.parse(`wsp_${v7()}`);
}
