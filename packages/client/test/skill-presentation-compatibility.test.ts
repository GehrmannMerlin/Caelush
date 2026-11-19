import { createSessionId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushClient } from "../src/client.js";

const sessionId = createSessionId();

type CompatiblePresentationReader = (
  sessionId: ReturnType<typeof createSessionId>,
  query?: unknown,
) => Promise<{ readonly capabilityVersion: number }>;

function compatibleReader(client: CaelushClient): CompatiblePresentationReader | undefined {
  return (
    client as unknown as {
      getSessionTurnPresentationCompatible?: CompatiblePresentationReader;
    }
  ).getSessionTurnPresentationCompatible;
}

describe("Skill presentation client compatibility", () => {
  it("falls back to V3 only when the Skill capability route is missing", async () => {
    const requests: string[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/api/v1/skills/capabilities")) return apiError(404);
        return json({ capabilityVersion: 3, turns: [] });
      },
    });
    const read = compatibleReader(client);
    expect(read).toBeTypeOf("function");
    if (read === undefined) return;

    await expect(read.call(client, sessionId, { limit: 10 })).resolves.toMatchObject({
      capabilityVersion: 3,
    });
    expect(requests.map((url) => new URL(url).pathname)).toEqual([
      "/api/v1/skills/capabilities",
      `/api/v1/sessions/${sessionId}/presentation`,
    ]);
  });

  it("uses strict V4 when advertised and does not hide non-404 capability errors", async () => {
    const requests: string[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/api/v1/skills/capabilities")) {
          return json({
            schemaVersion: 1,
            enabled: true,
            catalog: true,
            invocation: false,
            scriptExecution: false,
            presentationVersion: 4,
          });
        }
        return json({ capabilityVersion: 4, turns: [] });
      },
    });
    const read = compatibleReader(client);
    expect(read).toBeTypeOf("function");
    if (read === undefined) return;

    await expect(read.call(client, sessionId, { limit: 10 })).resolves.toMatchObject({
      capabilityVersion: 4,
    });
    expect(new URL(requests[1]!).pathname).toBe(`/api/v1/sessions/${sessionId}/presentation-v4`);

    const unauthorized = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () => apiError(401),
    });
    const unauthorizedRead = compatibleReader(unauthorized);
    expect(unauthorizedRead).toBeTypeOf("function");
    await expect(unauthorizedRead!.call(unauthorized, sessionId)).rejects.toMatchObject({
      name: "CaelushClientHttpError",
      status: 401,
    });
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number): Response {
  return json(
    {
      error: {
        code: status === 401 ? "UNAUTHORIZED" : "NOT_FOUND",
        message: "safe error",
        requestId: "req_skill_presentation",
      },
    },
    status,
  );
}
