import { describe, expect, it } from "vitest";
import {
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  acceptSandboxReady,
  createSandboxHello,
  decodeSandboxControlMessage,
  encodeSandboxControlMessage,
} from "../src/index.js";

describe("sandbox control protocol", () => {
  it("requires a versioned nonce-bound READY on the separate control channel", () => {
    const hello = createSandboxHello({
      nonce: "nonce-control-1",
      providerId: "fake-restricted",
      boundaryFingerprint: "boundary-fingerprint-1",
    });
    const ready = {
      type: "READY" as const,
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      nonce: hello.nonce,
      providerId: hello.providerId,
      boundaryFingerprint: hello.boundaryFingerprint,
      enforcement: "HARD" as const,
    };
    const decoded = decodeSandboxControlMessage(encodeSandboxControlMessage(ready));
    expect(acceptSandboxReady(decoded, hello)).toMatchObject({ type: "READY" });
    expect(() => acceptSandboxReady({ ...ready, nonce: "nonce-control-2" }, hello)).toThrow(
      /nonce/i,
    );
    expect(() => acceptSandboxReady({ ...ready, protocolVersion: 99 as never }, hello)).toThrow(
      /version/i,
    );
  });

  it("rejects oversized or malformed control messages before they become READY", () => {
    expect(() => decodeSandboxControlMessage("READY\n")).toThrow(/protocol/i);
    expect(() => decodeSandboxControlMessage("x".repeat(70_000))).toThrow(/size/i);
  });

  it("decodes a nonce-bound ERROR without requiring READY-only fields", () => {
    const decoded = decodeSandboxControlMessage(
      JSON.stringify({
        type: "ERROR",
        protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
        nonce: "nonce-control-error-1",
        code: "WINDOWS_RESTRICTED_TOKEN_BACKEND_UNAVAILABLE",
      }),
    );

    expect(decoded).toEqual({
      type: "ERROR",
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      nonce: "nonce-control-error-1",
      code: "WINDOWS_RESTRICTED_TOKEN_BACKEND_UNAVAILABLE",
    });
  });
});
