import type { AIAdapterEvent } from "./api-adapter-event.js";
import type { ApiId } from "../ids/api-id.js";
import type { ModelDescriptor } from "../models/model-descriptor.js";
import type { ResolvedAIModelRequest } from "../request/resolved-model-request.js";
import type { ResolvedProviderConnection } from "../providers/resolved-provider-connection.js";

/**
 * Everything an adapter needs for one provider turn.
 *
 * `signal` is the gateway-owned transport signal and must be forwarded unchanged;
 * an adapter never creates its own abort signal, never owns a timeout, and never
 * owns retry policy.
 *
 * `provider` carries credentials and therefore never leaves this boundary.
 */
export interface ApiAdapterStreamInput {
  readonly model: ModelDescriptor;
  readonly provider: ResolvedProviderConnection;
  readonly request: ResolvedAIModelRequest;
  readonly signal: AbortSignal;
}

/**
 * Translates one API dialect into {@link AIAdapterEvent}s.
 *
 * An adapter performs exactly one provider turn. It never executes a tool, never
 * generates a Caelush call id, and never emits a gateway envelope event. All
 * provider SDK usage is confined to adapter implementations.
 */
export interface ApiAdapter {
  readonly id: ApiId;
  stream(input: ApiAdapterStreamInput): AsyncIterable<AIAdapterEvent>;
}
