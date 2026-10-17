import { describe, expect, it, vi } from "vitest";
import { createSessionId } from "@caelush/protocol";
import type { DesktopDaemonProxyLease } from "../../src/main/protocol/local-proxy.js";
import { DesktopProfileCenterController } from "../../src/main/profile-center/controller.js";

function fixture() {
  const generation = { value: "generation-one", authorized: true };
  const released = vi.fn();
  const lease = {
    baseUrl: "http://127.0.0.1:43120",
    hostToken: Buffer.alloc(32, 7).toString("base64url"),
    userId: "user-one",
    profileId: "profile-one",
    get generationId() {
      return generation.value;
    },
    profile: {},
    signal: new AbortController().signal,
    release: released,
  } as DesktopDaemonProxyLease;
  const supervisor = {
    getActiveProfileIdentity: () =>
      generation.authorized
        ? {
            userId: lease.userId,
            profileId: lease.profileId,
            generationId: generation.value,
            profile: lease.profile,
          }
        : null,
    acquireProxyLease: vi.fn(() => (generation.authorized ? lease : null)),
  };
  return { generation, lease, released, supervisor };
}

describe("DesktopProfileCenterController", () => {
  it("returns the latest safe session labels with persisted usage and releases its owned lease", async () => {
    const test = fixture();
    const sessionId = createSessionId();
    const requests: Request[] = [];
    const controller = new DesktopProfileCenterController({
      supervisor: test.supervisor,
      getAuthorizedUserId: () => "user-one",
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/sessions?")) {
          return Response.json({
            items: [
              {
                id: sessionId,
                title: "  Fix session selection\n",
                createdAt: 10,
                updatedAt: 20,
                metadata: {},
              },
            ],
          });
        }
        return Response.json({
          allTime: { successfulRequests: 7, totalTokens: 4_200 },
          since: { successfulRequests: 2, totalTokens: 900 },
        });
      },
    });

    await expect(
      controller.getSnapshot({ sinceMs: 1_000 }, new AbortController().signal),
    ).resolves.toEqual({
      recentSessions: [{ id: sessionId, title: "Fix session selection", updatedAt: 20 }],
      usage: {
        allTime: { successfulRequests: 7, totalTokens: 4_200 },
        since: { successfulRequests: 2, totalTokens: 900 },
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/sessions",
      "/api/v1/usage/summary",
    ]);
    expect(requests[0]?.url).toContain("limit=20");
    expect(requests[1]?.url).toContain("sinceMs=1000");
    expect(
      requests.every(
        (request) =>
          request.headers.get("x-caelush-host-token") === test.lease.hostToken &&
          request.headers.get("origin") === test.lease.baseUrl,
      ),
    ).toBe(true);
    expect(test.released).toHaveBeenCalledTimes(1);
  });

  it("does not read a daemon for an unauthorized account", async () => {
    const test = fixture();
    test.generation.authorized = false;
    const fetcher = vi.fn();
    const controller = new DesktopProfileCenterController({
      supervisor: test.supervisor,
      getAuthorizedUserId: () => null,
      fetcher,
    });

    await expect(
      controller.getSnapshot({ sinceMs: 1_000 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "DESKTOP_ACCOUNT_UNAUTHORIZED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
