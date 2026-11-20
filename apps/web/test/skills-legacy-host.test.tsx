import { createSessionId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushClient } from "@caelush/client";
import { canOpenSkillManager } from "../src/application/skill-workbench-availability.js";

describe("Phase 08 older daemon compatibility in the Web host", () => {
  it("hides Skill controls against an older daemon and keeps the V3 transcript path", async () => {
    const requests: string[] = [];
    const client = new CaelushClient({
      baseUrl: "http://legacy-daemon.test",
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        if (url.pathname === "/api/v1/skills/capabilities") return apiError(404);
        if (url.pathname.endsWith("/presentation")) {
          return json({ capabilityVersion: 3, turns: [] });
        }
        return apiError(404);
      },
    });

    const capabilities = await client.getSkillCapabilities();
    expect(capabilities).toBeNull();
    expect(canOpenSkillManager(capabilities ?? undefined, true)).toBe(false);

    await expect(
      client.getSessionTurnPresentationCompatible(createSessionId(), { limit: 10 }),
    ).resolves.toMatchObject({ capabilityVersion: 3, turns: [] });
    expect(requests).toEqual([
      "/api/v1/skills/capabilities",
      "/api/v1/skills/capabilities",
      expect.stringContaining("/presentation"),
    ]);
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
        code: "NOT_FOUND",
        message: "safe compatibility response",
        requestId: "phase08-legacy-host",
      },
    },
    status,
  );
}
