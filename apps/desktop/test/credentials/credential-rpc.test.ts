import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  MainCredentialRpcServer,
  type MainCredentialVaultPort,
} from "../../src/main/credentials/credential-rpc.js";

const generationId = "d63b1110-b529-484b-a085-b4604cae4b7f";
const requestId = "b224fcb7-f36a-457b-a71e-e72416b24a59";
const userId = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
const profileId = `u_${"a".repeat(64)}`;
const status = {
  providerId: "deepseek",
  configured: true,
  source: "LOCAL" as const,
  writable: true,
  updatedAt: 1_800_000_000_000,
};

function createServer(
  options: {
    readonly isCurrentGeneration?: () => boolean;
    readonly credentials?: MainCredentialVaultPort;
    readonly operationTimeoutMs?: number;
    readonly maxConcurrentRequests?: number;
  } = {},
) {
  const sent: unknown[] = [];
  const credentials: MainCredentialVaultPort = options.credentials ?? {
    describe: vi.fn(async () => status),
    resolve: vi.fn(async () => "provider-key-fixture"),
    set: vi.fn(async () => status),
    unset: vi.fn(async () => undefined),
  };
  const server = new MainCredentialRpcServer({
    identity: { generationId, profileId, childPid: 42_000, cloudUserId: userId },
    isCurrentGeneration: options.isCurrentGeneration ?? (() => true),
    credentials,
    send: async (message) => sent.push(structuredClone(message)),
    ...(options.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(options.maxConcurrentRequests === undefined
      ? {}
      : { maxConcurrentRequests: options.maxConcurrentRequests }),
  });
  return { server, sent, credentials };
}

describe("MainCredentialRpcServer", () => {
  it("supports DESCRIBE, RESOLVE, SET, and UNSET with correlated safe responses", async () => {
    const { server, sent, credentials } = createServer();
    const common = { generationId, profileId, childPid: 42_000, providerId: "deepseek" };

    await server.handle({ type: "CREDENTIAL_DESCRIBE", requestId, ...common });
    await server.handle({
      type: "CREDENTIAL_RESOLVE",
      requestId: "315dd137-c7c8-4968-8b83-3b6cbd4bc65f",
      ...common,
    });
    await server.handle({
      type: "CREDENTIAL_SET",
      requestId: "ba41cd90-4ae7-4d07-b07e-a2a9bc8e58b9",
      ...common,
      secretValue: "candidate-key-fixture",
    });
    await server.handle({
      type: "CREDENTIAL_UNSET",
      requestId: "c4d11d03-5baf-41ab-a7dc-6f72e0311519",
      ...common,
    });

    expect(sent).toEqual([
      {
        type: "CREDENTIAL_RESPONSE",
        requestId,
        generationId,
        profileId,
        result: { kind: "STATUS", status },
      },
      {
        type: "CREDENTIAL_RESPONSE",
        requestId: "315dd137-c7c8-4968-8b83-3b6cbd4bc65f",
        generationId,
        profileId,
        result: { kind: "RESOLVE", secretValue: "provider-key-fixture" },
      },
      {
        type: "CREDENTIAL_RESPONSE",
        requestId: "ba41cd90-4ae7-4d07-b07e-a2a9bc8e58b9",
        generationId,
        profileId,
        result: { kind: "STATUS", status },
      },
      {
        type: "CREDENTIAL_RESPONSE",
        requestId: "c4d11d03-5baf-41ab-a7dc-6f72e0311519",
        generationId,
        profileId,
        result: { kind: "UNSET" },
      },
    ]);
    expect(credentials.describe).toHaveBeenCalledWith(userId, profileId, "deepseek");
    expect(credentials.resolve).toHaveBeenCalledWith(userId, profileId, "deepseek");
    expect(credentials.set).toHaveBeenCalledWith(
      userId,
      profileId,
      "deepseek",
      "candidate-key-fixture",
    );
    expect(credentials.unset).toHaveBeenCalledWith(userId, profileId, "deepseek");
    expect(JSON.stringify(sent.filter(isRecord))).not.toContain("candidate-key-fixture");
  });

  it("rejects wrong Profile, generation, and child PID without touching Vault", async () => {
    const { server, sent, credentials } = createServer();
    const common = { requestId, generationId, profileId, childPid: 42_000, providerId: "deepseek" };

    await server.handle({
      type: "CREDENTIAL_RESOLVE",
      ...common,
      profileId: `u_${"b".repeat(64)}`,
    });
    await server.handle({
      type: "CREDENTIAL_RESOLVE",
      ...common,
      generationId: "b8ebf006-43d9-4c53-8fe4-074c810fb24d",
    });
    await server.handle({ type: "CREDENTIAL_RESOLVE", ...common, childPid: 42_001 });

    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("rejects stale-generation messages after child replacement", async () => {
    let active = true;
    const { server, sent, credentials } = createServer({ isCurrentGeneration: () => active });
    active = false;

    await server.handle({
      type: "CREDENTIAL_RESOLVE",
      requestId,
      generationId,
      profileId,
      childPid: 42_000,
      providerId: "deepseek",
    });

    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("bounds concurrent requests and returns only safe error codes", async () => {
    let releaseResolve!: (value: string | undefined) => void;
    const credentials: MainCredentialVaultPort = {
      describe: vi.fn(async () => status),
      resolve: vi.fn(() => new Promise((resolve) => (releaseResolve = resolve))),
      set: vi.fn(async () => status),
      unset: vi.fn(async () => undefined),
    };
    const { server, sent } = createServer({ credentials, maxConcurrentRequests: 1 });
    const common = { generationId, profileId, childPid: 42_000, providerId: "deepseek" };
    const first = server.handle({ type: "CREDENTIAL_RESOLVE", requestId, ...common });
    const second = server.handle({
      type: "CREDENTIAL_DESCRIBE",
      requestId: "315dd137-c7c8-4968-8b83-3b6cbd4bc65f",
      ...common,
    });
    await second;
    releaseResolve("provider-key-fixture");
    await first;

    expect(sent).toContainEqual({
      type: "CREDENTIAL_RESPONSE",
      requestId: "315dd137-c7c8-4968-8b83-3b6cbd4bc65f",
      generationId,
      profileId,
      result: { kind: "ERROR", code: "TOO_MANY_REQUESTS" },
    });
  });

  it("times out Vault operations with a bounded response", async () => {
    const credentials: MainCredentialVaultPort = {
      describe: vi.fn(() => new Promise(() => undefined)),
      resolve: vi.fn(async () => undefined),
      set: vi.fn(async () => status),
      unset: vi.fn(async () => undefined),
    };
    const { server, sent } = createServer({ credentials, operationTimeoutMs: 10 });

    await server.handle({
      type: "CREDENTIAL_DESCRIBE",
      requestId,
      generationId,
      profileId,
      childPid: 42_000,
      providerId: "deepseek",
    });

    expect(sent).toEqual([
      {
        type: "CREDENTIAL_RESPONSE",
        requestId,
        generationId,
        profileId,
        result: { kind: "ERROR", code: "CREDENTIAL_TIMEOUT" },
      },
    ]);
  });

  it("drops malformed and oversized messages without exposing request values", async () => {
    const { server, sent, credentials } = createServer();

    await server.handle({
      type: "CREDENTIAL_RESOLVE",
      requestId,
      generationId,
      profileId,
      childPid: 42_000,
      providerId: "../../x",
    });
    await server.handle({
      type: "CREDENTIAL_SET",
      requestId,
      generationId,
      profileId,
      childPid: 42_000,
      providerId: "deepseek",
      secretValue: "x".repeat(16_385),
    });

    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(credentials.set).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class TestCredentialTransport extends EventEmitter {
  readonly pid = 42_000;
  connected = true;
  readonly sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(structuredClone(message));
    callback?.(null);
    return true;
  }
}

describe("Daemon Desktop credential RPC client", () => {
  it("correlates responses and maps all four operations through the runtime authority", async () => {
    const { createDesktopCredentialAuthority } =
      await import("../../../daemon/src/providers/desktop-credential-rpc.js");
    const transport = new TestCredentialTransport();
    const rpc = createDesktopCredentialAuthority({
      generationId,
      profileId,
      transport,
      timeoutMs: 100,
    });
    const respond = (request: unknown, result: unknown) => {
      if (!isRecord(request)) throw new Error("missing credential request");
      transport.emit("message", {
        type: "CREDENTIAL_RESPONSE",
        requestId: request.requestId,
        generationId,
        profileId,
        result,
      });
    };

    const describe = rpc.authority.describe("deepseek");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    respond(transport.sent[0], { kind: "STATUS", status });
    await expect(describe).resolves.toMatchObject({ configured: true, source: "LOCAL" });

    const set = rpc.authority.set("deepseek", "candidate-key-fixture");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    respond(transport.sent[1], { kind: "STATUS", status });
    await expect(set).resolves.toMatchObject({ configured: true, source: "LOCAL" });

    const resolve = rpc.authority.resolve("deepseek", new AbortController().signal);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(3));
    respond(transport.sent[2], { kind: "RESOLVE", secretValue: "provider-key-fixture" });
    await expect(resolve).resolves.toEqual({ apiKey: "provider-key-fixture" });

    const unset = rpc.authority.unset("deepseek");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(4));
    respond(transport.sent[3], { kind: "UNSET" });
    await expect(unset).resolves.toBeUndefined();
    expect(transport.sent.map((message) => isRecord(message) && message.type)).toEqual([
      "CREDENTIAL_DESCRIBE",
      "CREDENTIAL_SET",
      "CREDENTIAL_RESOLVE",
      "CREDENTIAL_UNSET",
    ]);
    expect(transport.sent[1]).toMatchObject({ childPid: 42_000, generationId, profileId });
    expect(JSON.stringify(transport.sent)).not.toContain("provider-key-fixture");
    rpc.dispose();
  });

  it("rejects mismatched responses, AbortSignal, timeout, and child exit", async () => {
    const { createDesktopCredentialAuthority } =
      await import("../../../daemon/src/providers/desktop-credential-rpc.js");

    const wrongIdentityTransport = new TestCredentialTransport();
    const wrongIdentity = createDesktopCredentialAuthority({
      generationId,
      profileId,
      transport: wrongIdentityTransport,
      timeoutMs: 100,
    });
    const mismatched = wrongIdentity.authority.describe("deepseek");
    await vi.waitFor(() => expect(wrongIdentityTransport.sent).toHaveLength(1));
    const request = wrongIdentityTransport.sent[0];
    if (!isRecord(request)) throw new Error("missing credential request");
    wrongIdentityTransport.emit("message", {
      type: "CREDENTIAL_RESPONSE",
      requestId: request.requestId,
      generationId: "b8ebf006-43d9-4c53-8fe4-074c810fb24d",
      profileId,
      result: { kind: "STATUS", status },
    });
    await expect(mismatched).rejects.toMatchObject({ code: "CREDENTIAL_RPC_INVALID" });
    wrongIdentity.dispose();

    const abortTransport = new TestCredentialTransport();
    const abortRpc = createDesktopCredentialAuthority({
      generationId,
      profileId,
      transport: abortTransport,
      timeoutMs: 100,
    });
    const abort = new AbortController();
    const aborted = abortRpc.authority.resolve("deepseek", abort.signal);
    await vi.waitFor(() => expect(abortTransport.sent).toHaveLength(1));
    abort.abort();
    await expect(aborted).rejects.toMatchObject({ code: "AI_ABORTED" });
    abortRpc.dispose();

    const timeoutTransport = new TestCredentialTransport();
    const timeoutRpc = createDesktopCredentialAuthority({
      generationId,
      profileId,
      transport: timeoutTransport,
      timeoutMs: 10,
    });
    const timedOut = timeoutRpc.authority.describe("deepseek");
    await expect(timedOut).rejects.toMatchObject({ code: "CREDENTIAL_RPC_TIMEOUT" });
    timeoutRpc.dispose();

    const exitTransport = new TestCredentialTransport();
    const exitRpc = createDesktopCredentialAuthority({
      generationId,
      profileId,
      transport: exitTransport,
      timeoutMs: 100,
    });
    const exited = exitRpc.authority.describe("deepseek");
    await vi.waitFor(() => expect(exitTransport.sent).toHaveLength(1));
    exitTransport.emit("exit", 1, null);
    await expect(exited).rejects.toMatchObject({ code: "CREDENTIAL_RPC_CLOSED" });
    exitRpc.dispose();
  });
});
