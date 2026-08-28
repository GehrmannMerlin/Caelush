import { z } from "zod";
import { JsonObjectSchema } from "../primitives/json.js";

export const ApiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_EVENT_CURSOR",
  "NOT_FOUND",
  "CONFLICT",
  "STORAGE_ERROR",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: JsonObjectSchema.optional(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = z
  .object({
    error: ApiErrorSchema,
  })
  .strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
