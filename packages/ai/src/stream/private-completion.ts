import type { AIProviderOpaqueState } from "../messages/provider-state.js";
import type { ApiId } from "../ids/api-id.js";
import type { ModelRef } from "../models/model-ref.js";
import type { ProviderId } from "../ids/provider-id.js";
import type { LLMCallId } from "../ids/llm-call-id.js";

/** One adapter candidate. The Gateway promotes it only after the public turn settles normally. */
export type AIAdapterPrivateCompletionCandidate =
  | { readonly completeness: "COMPLETE"; readonly payload: Uint8Array }
  | { readonly completeness: "INCOMPLETE" };

/** The host-only completion sideband for one Gateway invocation. */
export type AIPrivateCompletion =
  | {
      readonly callId: LLMCallId;
      readonly providerId: ProviderId;
      readonly model: ModelRef;
      readonly api: ApiId;
      readonly completeness: "COMPLETE";
      readonly payload: Uint8Array;
    }
  | {
      readonly callId: LLMCallId;
      readonly providerId: ProviderId;
      readonly model: ModelRef;
      readonly api: ApiId;
      readonly completeness: "INCOMPLETE";
    };

/** Authorized host resolver. The OpenAI-compatible adapter only supplies selected message state. */
export interface AIPrivateReplayResolver {
  /** Context-selected Assistant IDs in the exact order they appear in the request. */
  readonly selectedAssistantMessageIds?: readonly string[];
  resolve(input: {
    readonly providerState: AIProviderOpaqueState;
    readonly providerId: ProviderId;
    readonly model: ModelRef;
    readonly api: ApiId;
  }): Promise<Uint8Array | undefined>;
}
