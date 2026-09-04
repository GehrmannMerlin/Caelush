import type { LLMRequest } from "./request.js";
import type { FinishReason } from "./tool-call.js";

export interface LLMWireDiagnosticRequest {
  readonly phase: "REQUEST";
  readonly callId: string;
  readonly providerId: string;
  readonly model: string;
  readonly messageRoles: readonly string[];
  readonly toolNames: readonly string[];
}

export interface LLMWireDiagnosticResponse {
  readonly phase: "RESPONSE";
  readonly callId: string;
  readonly providerId: string;
  readonly model: string;
  readonly finishReason: FinishReason;
  readonly toolNames: readonly string[];
  readonly durationMs: number;
}

export type LLMWireDiagnosticEvent = LLMWireDiagnosticRequest | LLMWireDiagnosticResponse;

export interface LLMWireDiagnostic {
  record(event: LLMWireDiagnosticEvent): void;
}

export interface LLMWireDiagnosticOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sink?: (event: LLMWireDiagnosticEvent) => void;
}

function summarizeRequest(request: LLMRequest, callId: string): LLMWireDiagnosticRequest {
  return {
    phase: "REQUEST",
    callId,
    providerId: request.model.provider,
    model: request.model.model,
    messageRoles: request.messages.map((message) => message.role),
    toolNames: (request.tools ?? []).map((tool) => tool.name),
  };
}

export function createSafeLLMWireDiagnostic(
  options: LLMWireDiagnosticOptions = {},
): LLMWireDiagnostic | undefined {
  const env = options.env ?? (typeof process === "undefined" ? {} : process.env);
  if (env.CAELUSH_DEBUG_MODEL_WIRE !== "1") return undefined;
  const sink = options.sink ?? (() => undefined);
  return Object.freeze({
    record(event: LLMWireDiagnosticEvent): void {
      sink(
        Object.freeze({
          ...event,
          messageRoles: "messageRoles" in event ? Object.freeze([...event.messageRoles]) : undefined,
          toolNames: Object.freeze([...event.toolNames]),
        }) as LLMWireDiagnosticEvent,
      );
    },
  });
}

export function summarizeLLMWireRequest(request: LLMRequest, callId: string) {
  return summarizeRequest(request, callId);
}
