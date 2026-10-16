import { describe, expect, it } from "vitest";
import { createSessionId, createWorkspaceId, type DaemonInfo } from "@caelush/protocol";
import {
  CaelushClient,
  CaelushProtocolCompatibilityError,
  requireArchiveManagement,
} from "../src/index.js";
describe("archive management client", () => {
  it("uses validated query encoding, token-only deletion and AbortSignal", async () => {
    const requests: Request[] = [];
    let reply: unknown;
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify(reply), { status: 200 });
      },
    });
    reply = {
      items: [],
      matchedCount: 0,
      totalCounts: { sessions: 0, workspaces: 0 },
      catalogRevision: 1,
    };
    const abort = new AbortController();
    await client.listArchivedSessions(
      { query: " 中文 %_ 空格 ", unassociated: true },
      { signal: abort.signal },
    );
    expect(new URL(requests[0]!.url).searchParams.get("query")).toBe("中文 %_ 空格");
    expect(new URL(requests[0]!.url).searchParams.get("unassociated")).toBe("true");
    expect(requests[0]!.signal.aborted).toBe(false);
    abort.abort();
    expect(requests[0]!.signal.aborted).toBe(true);
    await client.listArchivedWorkspaces();
    reply = { counts: { workspaces: 0, sessions: 1, runs: 2 }, catalogRevision: 2 };
    await client.permanentlyDeleteArchives({ confirmationToken: "opaque-confirmation" });
    expect(await requests.at(-1)!.json()).toEqual({ confirmationToken: "opaque-confirmation" });
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/v1/archives/sessions",
      "/api/v1/archives/workspaces",
      "/api/v1/archives/permanent-deletions",
    ]);
  });
  it("exposes archive, restore, preview, state and legacy import through strict DTOs", async () => {
    const requests: Request[] = [];
    const sessionId = createSessionId();
    const workspaceId = createWorkspaceId();
    const state = {
      target: { type: "SESSION", sessionId },
      archived: false,
      restoreDisposition: "NOT_ARCHIVED",
    };
    let reply: unknown = state;
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify(reply));
      },
    });
    await client.getArchiveState({ type: "SESSION", sessionId });
    reply = { state, changed: false, catalogRevision: 1 };
    await client.archiveSession(sessionId);
    await client.archiveWorkspace(workspaceId);
    await client.restoreSession(sessionId, { archiveId: "00000000-0000-4000-8000-000000000000" });
    await client.restoreWorkspace(workspaceId, {
      archiveId: "00000000-0000-4000-8000-000000000000",
    });
    reply = {
      counts: { workspaces: 0, sessions: 1, runs: 0 },
      samples: [],
      confirmationToken: "token",
      expiresAt: 100,
    };
    await client.previewArchiveDeletion({ type: "SESSION", sessionId });
    reply = {
      importedSessionIds: [sessionId],
      alreadyArchivedSessionIds: [],
      rejected: [],
      catalogRevision: 2,
    };
    await client.importLegacyArchives({ markers: [{ sessionId, archivedAt: null }] });
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/v1/archives/state",
      `/api/v1/sessions/${sessionId}/archive`,
      `/api/v1/workspaces/${workspaceId}/archive`,
      `/api/v1/sessions/${sessionId}/restore`,
      `/api/v1/workspaces/${workspaceId}/restore`,
      "/api/v1/archives/deletion-preview",
      "/api/v1/archives/legacy-import",
    ]);
    reply = { rawSql: "private" };
    await expect(client.listArchivedSessions()).rejects.toMatchObject({
      name: "CaelushClientProtocolError",
    });
  });
  it("preserves business conflicts and requires the explicit capability", async () => {
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "ARCHIVE_SELECTION_CHANGED",
              message: "Refresh scope.",
              requestId: "request",
            },
          }),
          { status: 409 },
        ),
    });
    await expect(
      client.permanentlyDeleteArchives({ confirmationToken: "token" }),
    ).rejects.toMatchObject({ code: "ARCHIVE_SELECTION_CHANGED", status: 409 });
    expect(new CaelushProtocolCompatibilityError().message).toBe(
      "Daemon protocol version is unsupported.",
    );
    expect(() => requireArchiveManagement({ capabilities: {} } as DaemonInfo)).toThrow(
      "Daemon archiveManagementV1 capability is required.",
    );
    expect(() =>
      requireArchiveManagement({ capabilities: { archiveManagementV1: true } } as DaemonInfo),
    ).not.toThrow();
  });
});
