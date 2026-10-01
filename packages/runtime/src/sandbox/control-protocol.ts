import { RuntimeSandboxProtocolError } from "../runtime-errors.js";

export const SANDBOX_CONTROL_PROTOCOL_VERSION = 1 as const;
export const MAX_SANDBOX_CONTROL_MESSAGE_BYTES = 64 * 1024;

export interface SandboxHelloMessage {
  readonly type: "HELLO";
  readonly protocolVersion: typeof SANDBOX_CONTROL_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly providerId: string;
  readonly boundaryFingerprint: string;
}

export interface SandboxReadyMessage {
  readonly type: "READY";
  readonly protocolVersion: typeof SANDBOX_CONTROL_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly providerId: string;
  readonly boundaryFingerprint: string;
  readonly enforcement: "HARD" | "PARTIAL" | "NONE";
}

export interface SandboxErrorMessage {
  readonly type: "ERROR";
  readonly protocolVersion: typeof SANDBOX_CONTROL_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly code: string;
}

export type SandboxControlMessage = SandboxHelloMessage | SandboxReadyMessage | SandboxErrorMessage;

export function createSandboxHello(input: {
  readonly nonce: string;
  readonly providerId: string;
  readonly boundaryFingerprint: string;
}): SandboxHelloMessage {
  const message: SandboxHelloMessage = {
    type: "HELLO",
    protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    nonce: input.nonce,
    providerId: input.providerId,
    boundaryFingerprint: input.boundaryFingerprint,
  };
  validateSandboxControlMessage(message);
  return Object.freeze(message);
}

export function encodeSandboxControlMessage(message: SandboxControlMessage): string {
  validateSandboxControlMessage(message);
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SANDBOX_CONTROL_MESSAGE_BYTES) {
    throw new RuntimeSandboxProtocolError("Sandbox control message exceeds its size limit.");
  }
  return encoded;
}

export function decodeSandboxControlMessage(input: string | Uint8Array): SandboxControlMessage {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  if (Buffer.byteLength(text, "utf8") > MAX_SANDBOX_CONTROL_MESSAGE_BYTES) {
    throw new RuntimeSandboxProtocolError("Sandbox control message exceeds its size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RuntimeSandboxProtocolError("Sandbox control protocol message is not valid JSON.");
  }
  validateSandboxControlMessage(parsed);
  return parsed;
}

export function acceptSandboxReady(
  message: SandboxControlMessage,
  expected: SandboxHelloMessage,
): SandboxReadyMessage {
  validateSandboxControlMessage(message);
  if (message.type !== "READY") {
    throw new RuntimeSandboxProtocolError("Sandbox control protocol expected READY.");
  }
  if (message.protocolVersion !== expected.protocolVersion) {
    throw new RuntimeSandboxProtocolError("Sandbox control protocol version mismatch.");
  }
  if (message.nonce !== expected.nonce) {
    throw new RuntimeSandboxProtocolError("Sandbox control nonce mismatch.");
  }
  if (message.providerId !== expected.providerId) {
    throw new RuntimeSandboxProtocolError("Sandbox control provider mismatch.");
  }
  if (message.boundaryFingerprint !== expected.boundaryFingerprint) {
    throw new RuntimeSandboxProtocolError("Sandbox control boundary mismatch.");
  }
  return message;
}

export function validateSandboxControlMessage(
  input: unknown,
): asserts input is SandboxControlMessage {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RuntimeSandboxProtocolError("Sandbox control protocol message must be an object.");
  }
  const value = input as Record<string, unknown>;
  if (value.protocolVersion !== SANDBOX_CONTROL_PROTOCOL_VERSION) {
    throw new RuntimeSandboxProtocolError("Sandbox control protocol version is invalid.");
  }
  if (
    typeof value.nonce !== "string" ||
    value.nonce.length < 8 ||
    value.nonce.length > 256 ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0
  ) {
    throw new RuntimeSandboxProtocolError("Sandbox control protocol fields are invalid.");
  }
  if (value.type === "HELLO" || value.type === "READY") {
    if (typeof value.boundaryFingerprint !== "string" || value.boundaryFingerprint.length === 0) {
      throw new RuntimeSandboxProtocolError("Sandbox control boundary fingerprint is invalid.");
    }
  }
  if (value.type === "READY" && !["HARD", "PARTIAL", "NONE"].includes(String(value.enforcement))) {
    throw new RuntimeSandboxProtocolError("Sandbox control enforcement is invalid.");
  }
  if (value.type === "ERROR" && (typeof value.code !== "string" || value.code.length === 0)) {
    throw new RuntimeSandboxProtocolError("Sandbox control error code is invalid.");
  }
  if (!["HELLO", "READY", "ERROR"].includes(String(value.type))) {
    throw new RuntimeSandboxProtocolError("Sandbox control message type is invalid.");
  }
}
