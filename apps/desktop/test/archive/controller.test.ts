import { describe, expect, it, vi } from "vitest";
import { DesktopArchiveController } from "../../src/main/archive/controller.js";
import type { DesktopDaemonProxyLease } from "../../src/main/protocol/local-proxy.js";
const info = {
  apiVersion: "v1",
  protocolVersion: 1,
  daemonVersion: "fixture",
  capabilities: {
    runExecution: true,
    runRecovery: true,
    cancellation: true,
    approvals: true,
    sseReplay: true,
    archiveManagementV1: true,
  },
  runtimeKinds: ["local"],
  configuredProviders: [],
  defaultRunConfiguration: {
    runtime: { id: "local", kind: "local" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ON_BOUNDARY",
    limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 1000 },
  },
};
function fixture() {
  let generationId = "generation-one";
  let authorized = true;
  const released = vi.fn();
  const signal = new AbortController();
  const lease = {
    baseUrl: "http://127.0.0.1:43120",
    hostToken: Buffer.alloc(32, 7).toString("base64url"),
    userId: "user-one",
    profileId: "profile-one",
    generationId,
    profile: {},
    signal: signal.signal,
    release: released,
  } as DesktopDaemonProxyLease;
  const supervisor = {
    getActiveProfileIdentity: () =>
      authorized
        ? { userId: lease.userId, profileId: lease.profileId, generationId, profile: lease.profile }
        : null,
    acquireProxyLease: vi.fn(() => (authorized ? lease : null)),
  };
  return {
    supervisor,
    lease,
    released,
    signal,
    setGeneration: () => {
      generationId = "generation-two";
    },
    deauthorize: () => {
      authorized = false;
    },
  };
}
describe("Desktop archive profile lease", () => {
  it("uses only the leased target and secret headers, forwards cancellation and releases", async () => {
    const test = fixture();
    const requests: Request[] = [];
    const controller = new DesktopArchiveController({
      supervisor: test.supervisor,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(
          JSON.stringify(
            request.url.endsWith("/info")
              ? info
              : {
                  items: [],
                  matchedCount: 0,
                  totalCounts: { sessions: 0, workspaces: 0 },
                  catalogRevision: 1,
                },
          ),
        );
      },
    });
    await controller.listSessions({}, test.signal.signal);
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (r) =>
          r.headers.get("x-caelush-host-token") === test.lease.hostToken &&
          r.headers.get("origin") === test.lease.baseUrl,
      ),
    ).toBe(true);
    expect(test.released).toHaveBeenCalledTimes(1);
    test.signal.abort();
    expect(requests.at(-1)!.signal.aborted).toBe(true);
  });
  it("rejects an old generation response and releases every lease", async () => {
    const test = fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const controller = new DesktopArchiveController({
      supervisor: test.supervisor,
      fetcher: async (input) => {
        if (String(input).endsWith("/info")) return new Response(JSON.stringify(info));
        entered();
        await gate;
        return new Response(
          JSON.stringify({
            items: [],
            matchedCount: 0,
            totalCounts: { sessions: 0, workspaces: 0 },
            catalogRevision: 1,
          }),
        );
      },
    });
    const result = controller.listSessions({}, test.signal.signal);
    await started;
    test.setGeneration();
    release();
    await expect(result).rejects.toMatchObject({ code: "ARCHIVE_SCOPE_CHANGED" });
    expect(test.released).toHaveBeenCalledTimes(1);
  });
  it("never contacts a daemon without an active identity or with a foreign target", async () => {
    const test = fixture();
    const fetcher = vi.fn();
    const controller = new DesktopArchiveController({ supervisor: test.supervisor, fetcher });
    test.deauthorize();
    await expect(controller.listSessions({}, test.signal.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const invalid = fixture();
    Object.assign(invalid.lease, { baseUrl: "https://evil.example" });
    const bad = new DesktopArchiveController({ supervisor: invalid.supervisor, fetcher });
    await expect(bad.listSessions({}, invalid.signal.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(invalid.released).toHaveBeenCalledTimes(1);
  });
});
