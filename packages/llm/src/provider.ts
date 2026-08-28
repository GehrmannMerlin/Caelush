import type { ModelRef } from "@caelush/protocol";
import type { LLMCallId } from "@caelush/protocol";
import { z } from "zod";
import type { LLMCapabilities } from "./capabilities.js";
import type { LLMRequest } from "./request.js";
import type { LLMStreamEvent } from "./events.js";

export const ProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export type LLMProviderRequest = LLMRequest;

export interface LLMProviderCallContext {
  readonly callId: LLMCallId;
  readonly signal: AbortSignal;
}

export interface LLMProvider {
  readonly id: ProviderId;
  supportsModel(model: ModelRef): boolean;
  getCapabilities(model: ModelRef): LLMCapabilities;
  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent>;
}
