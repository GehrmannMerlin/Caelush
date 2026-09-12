import { randomUUID } from "node:crypto";

/**
 * The host-side model wire diagnostic.
 *
 * It is a transparent decorator over the frozen `AIGateway`: the AI gateway contract
 * gains no diagnostic callback, and the decorator observes only the public event
 * stream. It records safe structural facts and never an endpoint, a credential, a
 * header, a query parameter, a prompt, a tool argument or a raw provider response.
 */
export interface ModelWireDiagnosticRequest {
  readonly phase: "REQUEST";
  readonly callId: string;
  readonly providerId: string;
  readonly model: string;
  readonly messageRoles: readonly string[];
  readonly toolNames: readonly string[];
  readonly modelSettings: Readonly<Record<string, string | number>>;
}

export interface ModelWireDiagnosticResponse {
  readonly phase: "RESPONSE";
  readonly callId: string;
  readonly providerId: string;
  readonly model: string;
  readonly finishReason: string;
  readonly toolNames: readonly string[];
  readonly durationMs: number;
}

export type ModelWireDiagnosticEvent = ModelWireDiagnosticRequest | ModelWireDiagnosticResponse;

export interface ModelWireDiagnostic {
  record(event: ModelWireDiagnosticEvent): void;
}

export interface ModelWireDiagnosticOptions {
  readonly writer?: (event: ModelWireDiagnosticEvent) => void;
}

/**
 * Create the diagnostic writer.
 *
 * Enabled by `CAELUSH_DEBUG_MODEL_WIRE`, the same switch the legacy diagnostic used,
 * so no second debug environment variable exists.
 */
export function createSafeModelWireDiagnostic(
  options: ModelWireDiagnosticOptions = {},
): ModelWireDiagnostic | undefined {
  if (options.writer === undefined && process.env["CAELUSH_DEBUG_MODEL_WIRE"] !== "1") {
    return undefined;
  }
  return createModelWireDiagnostic(options);
}

/** Create the diagnostic writer unconditionally, for tests and explicit wiring. */
export function createModelWireDiagnostic(
  options: ModelWireDiagnosticOptions = {},
): ModelWireDiagnostic {
  const writer =
    options.writer ??
    ((event: ModelWireDiagnosticEvent): void => {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    });

  return { record: (event) => writer(event) };
}

/** A stable identity for a diagnostic run, when the caller has no call id yet. */
export function createModelWireDiagnosticId(): string {
  return `wire_${randomUUID()}`;
}
