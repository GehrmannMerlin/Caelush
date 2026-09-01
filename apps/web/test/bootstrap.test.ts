import type { DaemonInfo, HealthResponse, WorkspaceRef } from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { CaelushClient, CaelushProtocolCompatibilityError } from "@caelush/client";
import {
  bootstrapWebHost,
  createInitialWebHostState,
  parseWebLaunchContext,
  toSafeWebError,
  type WebHostClient,
} from "../src/host/bootstrap.js";
import { createWebCaelushClient } from "../src/host/client-factory.js";

const workspace: WorkspaceRef = {
  id: "wsp_01953d89-7d91-7abc-8a14-1e8a6a2f4c10",
  path: "D:\\Develop\\Caelush",
};

const health: HealthResponse = {
  service: "caelush-daemon",
  status: "ready",
  apiVersion: "v1",
  protocolVersion: 1,
};

const info: DaemonInfo = {
  apiVersion: "v1",
  protocolVersion: 1,
  daemonVersion: "0.1.0",
  capabilities: {
    runExecution: true,
    runRecovery: true,
    cancellation: true,
    approvals: true,
    sseReplay: true,
  },
  runtimeKinds: ["local"],
  configuredProviders: [],
  defaultRunConfiguration: {
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  },
};

function clientWith(input: {
  readonly getHealth?: WebHostClient["getHealth"];
  readonly getInfo?: WebHostClient["getInfo"];
}): WebHostClient {
  return {
    getHealth: input.getHealth ?? (async () => health),
    getInfo: input.getInfo ?? (async () => info),
  };
}

describe("Web Host bootstrap model", () => {
  it("starts in a booting state without inventing daemon state", () => {
    expect(createInitialWebHostState()).toEqual({
      bootstrap: "BOOTING",
      connection: "CONNECTING",
    });
  });

  it("calls health before info and becomes ready with real daemon data", async () => {
    const calls: string[] = [];
    const state = await bootstrapWebHost({
      launchContext: { workspace },
      client: clientWith({
        getHealth: async () => {
          calls.push("health");
          return health;
        },
        getInfo: async () => {
          calls.push("info");
          return info;
        },
      }),
    });

    expect(calls).toEqual(["health", "info"]);
    expect(state).toMatchObject({
      bootstrap: "READY",
      connection: "CONNECTED",
      health,
      info,
      workspace,
    });
  });

  it("emits connection and protocol-checking states before ready", async () => {
    const transitions: string[] = [];
    await bootstrapWebHost({
      launchContext: { workspace },
      client: clientWith({}),
      onState: (state) => transitions.push(state.bootstrap),
    });

    expect(transitions).toEqual(["CONNECTING", "CHECKING_PROTOCOL", "READY"]);
  });

  it("fails as daemon unavailable without calling info when health fails", async () => {
    const getInfo = vi.fn(async () => info);
    const state = await bootstrapWebHost({
      launchContext: { workspace },
      client: clientWith({
        getHealth: async () => {
          throw new Error("secret provider detail");
        },
        getInfo,
      }),
    });

    expect(state).toMatchObject({
      bootstrap: "DAEMON_UNAVAILABLE",
      connection: "DISCONNECTED",
      error: { code: "DAEMON_UNAVAILABLE", message: "无法连接到本地 Caelush 服务。" },
    });
    expect(getInfo).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain("secret provider detail");
  });

  it("fails closed on protocol incompatibility", async () => {
    const state = await bootstrapWebHost({
      launchContext: { workspace },
      client: clientWith({
        getInfo: async () => {
          throw new CaelushProtocolCompatibilityError();
        },
      }),
    });

    expect(state).toMatchObject({
      bootstrap: "PROTOCOL_INCOMPATIBLE",
      connection: "INCOMPATIBLE",
      error: {
        code: "PROTOCOL_INCOMPATIBLE",
        message: "当前 Web 与 Caelush daemon 协议版本不兼容。",
      },
    });
  });

  it("rejects missing and malformed launch contexts before network access", async () => {
    const getHealth = vi.fn(async () => health);
    await expect(parseWebLaunchContext(undefined)).rejects.toMatchObject({
      code: "WORKSPACE_MISSING",
    });
    await expect(parseWebLaunchContext("not-json")).rejects.toMatchObject({
      code: "BOOTSTRAP_INVALID",
    });

    const state = await bootstrapWebHost({
      launchContext: undefined,
      client: clientWith({ getHealth }),
    });
    expect(state.bootstrap).toBe("WORKSPACE_MISSING");
    expect(getHealth).not.toHaveBeenCalled();
  });

  it("projects unknown errors to a fixed safe Web error", () => {
    const error = toSafeWebError(new Error("C:\\secret\\credential.json"));
    expect(error).toEqual({
      code: "DAEMON_UNAVAILABLE",
      message: "无法连接到本地 Caelush 服务。",
    });
    expect(JSON.stringify(error)).not.toContain("credential");
  });

  it("creates the browser client through the shared client implementation", async () => {
    const requests: string[] = [];
    const client = createWebCaelushClient({
      baseUrl: "http://127.0.0.1:43120",
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify(health), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(client).toBeInstanceOf(CaelushClient);
    await client.getHealth();
    expect(requests).toEqual(["http://127.0.0.1:43120/api/v1/health"]);
  });
});
