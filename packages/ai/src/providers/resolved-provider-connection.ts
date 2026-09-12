import type { JsonObject } from "../json/json-value.js";
import type { ProviderId } from "../ids/provider-id.js";
import type { AIProviderTransportOverride } from "./provider-binding.js";
import type { ProviderCredentials } from "./credentials.js";

/**
 * One resolved provider connection, ready for an adapter.
 *
 * This object carries the endpoint and the credential material. It is
 * host-internal for the duration of one attempt, and it must **never** enter a
 * public event, an error serialization, a durable event or a client DTO. The
 * gateway is the only producer, and the adapter is the only consumer.
 */
export interface ResolvedProviderConnection {
  readonly providerId: ProviderId;
  readonly endpoint: string;
  readonly credentials: ProviderCredentials;
  readonly headers: Readonly<Record<string, string>>;
  readonly queryParams: Readonly<Record<string, string>>;
  readonly compatibility?: JsonObject;
  readonly transport?: AIProviderTransportOverride;
}
