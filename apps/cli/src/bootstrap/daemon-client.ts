import { CaelushClient, type CaelushClientOptions } from "@caelush/client";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:43120";

export function resolveDaemonUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment.CAELUSH_DAEMON_URL?.trim();
  return configured === undefined || configured.length === 0 ? DEFAULT_DAEMON_URL : configured;
}

export function createDaemonClient(
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly fetcher?: typeof globalThis.fetch;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): CaelushClient {
  const clientOptions: CaelushClientOptions = {
    baseUrl: resolveDaemonUrl(options.environment),
    ...(options.fetcher === undefined ? {} : { fetch: options.fetcher }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  };
  return new CaelushClient(clientOptions);
}
