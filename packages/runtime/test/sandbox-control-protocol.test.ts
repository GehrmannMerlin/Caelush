import { describe, expect, it } from "vitest";
import {
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  acceptSandboxReady,
  acceptSandboxWorkspacePrepared,
  acceptSandboxWorkspaceStatus,
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

  it("rejects an ERROR frame whose nonce does not match the request", () => {
    const hello = createSandboxHello({
      nonce: "nonce-workspace-error-1",
      providerId: "fake-restricted",
      boundaryFingerprint: "workspace-error-boundary-1",
    });
    const error = decodeSandboxControlMessage(
      JSON.stringify({
        type: "ERROR",
        protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
        nonce: "nonce-workspace-error-2",
        code: "WINDOWS_ACL_APPLY_FAILED",
      }),
    );

    expect(() => acceptSandboxWorkspacePrepared(error, hello)).toThrow(/nonce/i);
  });

  it("preserves the bounded Runner reason when workspace preparation fails", () => {
    const hello = createSandboxHello({
      nonce: "nonce-workspace-error-3",
      providerId: "fake-restricted",
      boundaryFingerprint: "workspace-error-boundary-2",
    });
    const error = decodeSandboxControlMessage(
      JSON.stringify({
        type: "ERROR",
        protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
        nonce: hello.nonce,
        code: "WINDOWS_ACL_APPLY_FAILED",
      }),
    );

    expect(() => acceptSandboxWorkspacePrepared(error, hello)).toThrow(/WINDOWS_ACL_APPLY_FAILED/);
  });

  it("accepts workspace status and preparation results with the same boundary tuple", () => {
    const hello = createSandboxHello({
      nonce: "nonce-workspace-control-1",
      providerId: "fake-restricted",
      boundaryFingerprint: "workspace-boundary-fingerprint-1",
    });
    const status = decodeSandboxControlMessage(
      JSON.stringify({
        type: "WORKSPACE_STATUS",
        protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
        nonce: hello.nonce,
        providerId: hello.providerId,
        boundaryFingerprint: hello.boundaryFingerprint,
        status: "MISSING",
      }),
    );
    const prepared = decodeSandboxControlMessage(
      JSON.stringify({
        type: "WORKSPACE_PREPARED",
        protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
        nonce: hello.nonce,
        providerId: hello.providerId,
        boundaryFingerprint: hello.boundaryFingerprint,
        change: "ADDED",
      }),
    );

    expect(acceptSandboxWorkspaceStatus(status, hello)).toMatchObject({ status: "MISSING" });
    expect(acceptSandboxWorkspacePrepared(prepared, hello)).toMatchObject({ change: "ADDED" });
    expect(() =>
      acceptSandboxWorkspaceStatus(
        {
          type: "WORKSPACE_STATUS",
          protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
          nonce: hello.nonce,
          providerId: hello.providerId,
          boundaryFingerprint: "wrong",
          status: "MISSING",
        },
        hello,
      ),
    ).toThrow(/boundary/i);
  });
});
