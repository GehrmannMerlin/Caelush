import type { ApiId } from "../ids/api-id.js";
import type { AIMessage } from "../messages/message.js";
import type { AIToolChoice } from "./tool-choice.js";
import type { AIToolSpec } from "../tools/tool-spec.js";
import type { CacheResolution } from "../cache/cache-resolution.js";
import type { ModelDescriptor } from "../models/model-descriptor.js";
import type { ReasoningResolution } from "../reasoning/reasoning-resolution.js";

/**
 * The observable outcome of AI preflight.
 *
 * It states which API dialect will be used, how reasoning and caching were
 * settled, and the effective output ceiling. It carries no endpoint, no
 * credential, and no header or query secret — those live only in the resolved
 * provider connection, which never leaves the adapter boundary.
 */
export interface AIInvocationResolution {
  readonly api: ApiId;
  readonly reasoning: ReasoningResolution;
  readonly cache: CacheResolution;
  readonly maxOutputTokens?: number;
}

/**
 * A fully resolved request, ready for an adapter.
 *
 * The model ref has been replaced by its authoritative descriptor and the
 * settings have been replaced by their resolutions, so the adapter never has to
 * consult a catalog, a provider registry or a resolver.
 */
export interface ResolvedAIModelRequest {
  readonly model: ModelDescriptor;
  readonly messages: readonly AIMessage[];
  readonly tools?: readonly AIToolSpec[];
  readonly toolChoice?: AIToolChoice;
  readonly settings: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
    readonly reasoning: ReasoningResolution;
    readonly cache: CacheResolution;
  };
}
