import { createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushClient } from "../src/client.js";

describe("CaelushClient Workspace Session API", () => {
  it("uses one workspace-scoped request for Session summaries", async () => {
    const workspaceId = createWorkspaceId();
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    });

    await expect(client.listWorkspaceSessions(workspaceId)).resolves.toEqual({ items: [] });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /api/v1/workspaces/${workspaceId}/sessions`,
    ]);
  });
});
