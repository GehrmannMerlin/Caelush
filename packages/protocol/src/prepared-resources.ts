import { z } from "zod";
import { RunIdSchema, StepIdSchema, ToolInvocationIdSchema } from "./primitives/ids.js";

export const WorkflowArtifactRefSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u);
export type WorkflowArtifactRef = z.infer<typeof WorkflowArtifactRefSchema>;

const FingerprintSchema = z.string().min(1).max(256);
const RevisionSchema = z.string().min(1).max(256);
const RendererVersionSchema = z.string().min(1).max(128);
const SafeCountSchema = z.number().int().nonnegative().safe();
const OpaqueResourceIdSchema = z.string().min(1).max(256);

export const WorkflowCatalogSnapshotRefV1Schema = z
  .object({
    catalogRevision: RevisionSchema,
    artifactRef: WorkflowArtifactRefSchema,
    manifestFingerprint: FingerprintSchema,
  })
  .strict();
export type WorkflowCatalogSnapshotRefV1 = z.infer<typeof WorkflowCatalogSnapshotRefV1Schema>;

export const WorkflowResourceBindingDraftV1Schema = z
  .object({
    runId: RunIdSchema,
    resourceKind: z.literal("WORKFLOW_INSTRUCTION"),
    resourceId: OpaqueResourceIdSchema,
    resourceRevision: RevisionSchema,
    artifactRef: WorkflowArtifactRefSchema,
    sourceFingerprint: FingerprintSchema,
    utf8Bytes: SafeCountSchema,
    tokenEstimate: SafeCountSchema,
    sourceToolInvocationId: ToolInvocationIdSchema.optional(),
  })
  .strict();
export type WorkflowResourceBindingDraftV1 = z.infer<typeof WorkflowResourceBindingDraftV1Schema>;

export const WorkflowResourceBindingV1Schema = WorkflowResourceBindingDraftV1Schema.extend({
  bindingId: OpaqueResourceIdSchema,
  activationOrdinal: SafeCountSchema,
}).strict();
export type WorkflowResourceBindingV1 = z.infer<typeof WorkflowResourceBindingV1Schema>;

export const PreparedWorkflowResourceRefV1Schema = z
  .object({
    bindingId: OpaqueResourceIdSchema,
    artifactRef: WorkflowArtifactRefSchema,
    projectionFingerprint: FingerprintSchema,
    rendererVersion: RendererVersionSchema,
    utf8Bytes: SafeCountSchema,
    tokenEstimate: SafeCountSchema,
  })
  .strict();
export type PreparedWorkflowResourceRefV1 = z.infer<typeof PreparedWorkflowResourceRefV1Schema>;

export const PreparedInputResourceReceiptV1Schema = z
  .object({
    runId: RunIdSchema,
    stepId: StepIdSchema,
    bindingId: OpaqueResourceIdSchema,
    projectionFingerprint: FingerprintSchema,
    rendererVersion: RendererVersionSchema,
  })
  .strict();
export type PreparedInputResourceReceiptV1 = z.infer<typeof PreparedInputResourceReceiptV1Schema>;

export const RunWorkflowExecutionProfileV1Schema = z
  .object({
    runId: RunIdSchema,
    profileVersion: z.literal(1),
    toolCatalogFingerprint: FingerprintSchema.optional(),
    workflowRendererVersion: RendererVersionSchema,
    catalogSnapshotRef: WorkflowCatalogSnapshotRefV1Schema,
  })
  .strict();
export type RunWorkflowExecutionProfileV1 = z.infer<typeof RunWorkflowExecutionProfileV1Schema>;
