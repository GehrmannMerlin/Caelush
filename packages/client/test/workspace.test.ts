import { createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushClient } from "../src/client.js";

describe("CaelushClient Workspace API", () => {
  it("requests a native folder picker and returns its selected directory", async () => {
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(JSON.stringify({ status: "SELECTED", path: "D:\\Develop\\Caelush" }), {
          status: 200,
        });
      },
    });

    await expect(client.pickWorkspaceDirectory()).resolves.toEqual({
      status: "SELECTED",
      path: "D:\\Develop\\Caelush",
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /api/v1/workspaces/pick"],
    );
  });

  it("uses the shared typed request path for Workspace CRUD", async () => {
    const workspaceId = createWorkspaceId();
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (request.method === "POST") {
          return new Response(
            JSON.stringify({
              id: workspaceId,
              canonicalPath: "D:/workspace",
              displayName: "workspace",
              createdAt: 1,
              updatedAt: 2,
              lastOpenedAt: 2,
            }),
            { status: 201 },
          );
        }
        const body = request.url.endsWith("/workspaces")
          ? {
              items: [
                {
                  id: workspaceId,
                  canonicalPath: "D:/workspace",
                  displayName: "workspace",
                  createdAt: 1,
                  updatedAt: 2,
                  lastOpenedAt: 2,
                },
              ],
            }
          : {
              id: workspaceId,
              canonicalPath: "D:/workspace",
              displayName: "workspace",
              createdAt: 1,
              updatedAt: 2,
              lastOpenedAt: 2,
            };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });

    await expect(client.listWorkspaces()).resolves.toMatchObject({ items: [{ id: workspaceId }] });
    await expect(client.createWorkspace({ path: "D:/workspace" })).resolves.toMatchObject({
      id: workspaceId,
    });
    await expect(client.getWorkspace(workspaceId)).resolves.toMatchObject({ id: workspaceId });
    await expect(client.deleteWorkspace(workspaceId)).resolves.toBeUndefined();

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "GET /api/v1/workspaces",
        "POST /api/v1/workspaces",
        `GET /api/v1/workspaces/${workspaceId}`,
        `DELETE /api/v1/workspaces/${workspaceId}`,
      ],
    );
  });
});
