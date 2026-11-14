import { createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushClient } from "../src/client.js";

const workspaceId = createWorkspaceId();
const skillId = "skill:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const capabilities = {
  schemaVersion: 1,
  enabled: true,
  catalog: true,
  invocation: false,
  scriptExecution: false,
  presentationVersion: null,
};

describe("CaelushClient Skill V1 compatibility", () => {
  it("treats only a missing capability route as unsupported", async () => {
    const client404 = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () => apiError(404),
    });
    await expect(client404.getSkillCapabilities()).resolves.toBeNull();

    for (const status of [401, 403, 500]) {
      const client = new CaelushClient({
        baseUrl: "http://daemon.test",
        fetch: async () => apiError(status),
      });
      await expect(client.getSkillCapabilities()).rejects.toMatchObject({
        name: "CaelushClientHttpError",
        status,
      });
    }
  });

  it("uses strict versioned Skill catalog, settings and multipart import APIs", async () => {
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/api/v1/skills/capabilities")) return json(capabilities);
        if (request.url.includes("/management")) {
          return json({
            schemaVersion: 1,
            catalogRevision: `sha256:${"b".repeat(64)}`,
            items: [],
            complete: true,
            diagnostics: [],
          });
        }
        if (request.method === "PATCH") {
          return json({
            schemaVersion: 1,
            catalogRevision: `sha256:${"c".repeat(64)}`,
            settings: { skillId, enabled: false, modelInvocable: false, version: 1 },
          });
        }
        if (request.method === "POST") {
          return json(
            {
              schemaVersion: 1,
              skillId,
              name: "imported-skill",
              target: "CURRENT_PROJECT",
              bundleRevision: `sha256:${"d".repeat(64)}`,
              replaced: false,
            },
            201,
          );
        }
        return json({
          schemaVersion: 1,
          catalogRevision: `sha256:${"b".repeat(64)}`,
          items: [],
          complete: true,
          diagnostics: [],
        });
      },
    });

    await expect(client.getSkillCapabilities()).resolves.toMatchObject({
      catalog: true,
      invocation: false,
    });
    await client.listSkills(workspaceId, { q: "writer", pageSize: 5 });
    await client.listManagedSkills(workspaceId, { pageSize: 10 });
    await client.updateSkillSettings(workspaceId, skillId, {
      enabled: false,
      expectedCatalogRevision: `sha256:${"b".repeat(64)}`,
    });
    const receipt = await client.importSkills(workspaceId, {
      target: "CURRENT_PROJECT",
      files: [
        { relativePath: "SKILL.md", file: new Blob(["---\nname: imported-skill\n---\nbody"]) },
      ],
    });

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/api/v1/skills/capabilities"],
      ["GET", `/api/v1/workspaces/${workspaceId}/skills`],
      ["GET", `/api/v1/workspaces/${workspaceId}/skills/management`],
      ["PATCH", `/api/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(skillId)}/settings`],
      ["POST", `/api/v1/workspaces/${workspaceId}/skills/import`],
    ]);
    expect(requests[0]?.headers.get("content-type")).toBeNull();
    expect(requests[4]?.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/u);
    const form = await requests[4]!.formData();
    expect(form.get("target")).toBe("CURRENT_PROJECT");
    expect(form.get("manifest")).toContain('"relativePath":"SKILL.md"');
    expect(form.get("file-0")).toBeInstanceOf(File);
    expect(receipt).toMatchObject({ target: "CURRENT_PROJECT", name: "imported-skill" });
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
        code:
          status === 401
            ? "UNAUTHORIZED"
            : status === 403
              ? "INVALID_REQUEST"
              : status === 404
                ? "NOT_FOUND"
                : "INTERNAL_ERROR",
        message: "safe error",
        requestId: "req_test",
      },
    },
    status,
  );
}
