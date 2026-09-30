import { z } from "zod";
import {
  ClientModelSelectionWithReasoningSchema,
  ReasoningLevelSchema,
} from "./model-selection.js";

export const CredentialSourceSchema = z.enum(["NONE", "LOCAL", "ENVIRONMENT"]);
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;

export const ProviderDiscoveryStateSchema = z.enum(["NOT_CONFIGURED", "READY", "FAILED"]);
export type ProviderDiscoveryState = z.infer<typeof ProviderDiscoveryStateSchema>;

/** Secret-free provider state for control-plane responses. */
export const ProviderViewSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    credentialConfigured: z.boolean(),
    credentialSource: CredentialSourceSchema,
    credentialWritable: z.boolean(),
    discoveryState: ProviderDiscoveryStateSchema,
    discoveryError: z.string().min(1).optional(),
  })
  .strict();
export type ProviderView = z.infer<typeof ProviderViewSchema>;

export const ReasoningOptionViewSchema = z
  .object({
    level: ReasoningLevelSchema,
    displayName: z.string().min(1),
    description: z.string().min(1).optional(),
  })
  .strict();
export type ReasoningOptionView = z.infer<typeof ReasoningOptionViewSchema>;

export const ReasoningPresentationSchema = z
  .object({
    defaultLevel: ReasoningLevelSchema.optional(),
    options: z.array(ReasoningOptionViewSchema),
  })
  .strict();
export type ReasoningPresentation = z.infer<typeof ReasoningPresentationSchema>;

export const ModelAvailabilitySchema = z.enum(["AVAILABLE", "UNAVAILABLE"]);
export type ModelAvailability = z.infer<typeof ModelAvailabilitySchema>;

/** Secret-free model directory entry. Native adapter fields never cross this DTO. */
export const ModelViewSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    displayName: z.string().min(1),
    availability: ModelAvailabilitySchema,
    reasoning: ReasoningPresentationSchema.optional(),
  })
  .strict();
export type ModelView = z.infer<typeof ModelViewSchema>;

export const AIProvidersResponseSchema = z
  .object({ providers: z.array(ProviderViewSchema) })
  .strict();
export type AIProvidersResponse = z.infer<typeof AIProvidersResponseSchema>;

export const AIProviderConnectionResponseSchema = z
  .object({
    provider: ProviderViewSchema,
    directory: z
      .object({ models: z.array(ModelViewSchema), provider: z.string().min(1).optional() })
      .strict(),
  })
  .strict();
export type AIProviderConnectionResponse = z.infer<typeof AIProviderConnectionResponseSchema>;

export const AIModelDirectoryResponseSchema = z
  .object({
    provider: z.string().min(1).optional(),
    models: z.array(ModelViewSchema),
  })
  .strict();
export type AIModelDirectoryResponse = z.infer<typeof AIModelDirectoryResponseSchema>;

export const AIDefaultSelectionResponseSchema = z
  .object({ selection: ClientModelSelectionWithReasoningSchema.optional() })
  .strict();
export type AIDefaultSelectionResponse = z.infer<typeof AIDefaultSelectionResponseSchema>;

export const UpdateAISelectionRequestSchema = ClientModelSelectionWithReasoningSchema;
export type UpdateAISelectionRequest = z.infer<typeof UpdateAISelectionRequestSchema>;

export const ConnectProviderRequestSchema = z
  .object({ apiKey: z.string().min(1).max(16_384) })
  .strict();
export type ConnectProviderRequest = z.infer<typeof ConnectProviderRequestSchema>;
