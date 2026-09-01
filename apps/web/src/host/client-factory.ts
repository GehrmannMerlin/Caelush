import { CaelushClient, type CaelushClientOptions } from "@caelush/client";

export type WebClientFactoryOptions = Omit<CaelushClientOptions, "baseUrl"> & {
  readonly baseUrl?: string;
};

export function createWebCaelushClient(options: WebClientFactoryOptions = {}): CaelushClient {
  const baseUrl = options.baseUrl ?? globalThis.location?.origin;
  if (baseUrl === undefined) throw new Error("Browser location is unavailable.");
  return new CaelushClient({ ...options, baseUrl });
}
