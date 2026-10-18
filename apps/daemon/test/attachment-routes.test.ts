import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type AgentSession,
  type WorkspaceRecord,
} from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createAttachmentService } from "../src/attachments/attachment-service.js";
import { buildDaemonApp } from "../src/index.js";

let storage: CaelushStorage | undefined;
let directory: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function setup() {
  directory = await mkdtemp(join(tmpdir(), "caelush-attachment-route-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const timestamp = createTimestampMs(Date.now());
  const workspace: WorkspaceRecord = {
    id: createWorkspaceId(),
    canonicalPath: "C:/attachment-route-fixture",
    displayName: "attachment-route-fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
  };
  await storage.workspaces.insert(workspace);
  const session: AgentSession = {
    id: createSessionId(),
    workspaceId: workspace.id,
    defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
  await storage.sessions.insert(session, { expectedWorkspace: workspace });
  const attachmentService = createAttachmentService({
    attachments: storage.attachments,
    sessions: storage.sessions,
    workspaces: storage.workspaces,
    rootDirectory: join(directory, "attachments"),
  });
  const app = buildDaemonApp({
    attachments: storage.attachments,
    sessions: storage.sessions,
    runs: storage.runs,
    workspaces: storage.workspaces,
    attachmentService,
    eventHub: { watch: async function* () {} } as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
  } as never);
  return { app, session, attachmentService };
}

const requestHeaders = (sessionId: string) => ({
  host: "127.0.0.1",
  "content-type": "application/octet-stream",
  "x-caelush-owner-kind": "SESSION",
  "x-caelush-owner-id": sessionId,
  "x-caelush-filename": "notes.txt",
  "x-caelush-media-type": "text/plain",
});

describe("daemon attachment routes", () => {
  it("streams raw uploads and returns only the validated attachment descriptor", async () => {
    const { app, session } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: requestHeaders(session.id),
      payload: Buffer.from("streamed route contents"),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "notes.txt",
      mediaType: "text/plain",
      byteLength: 23,
      status: "READY",
    });
    expect(response.body).not.toContain("streamed route contents");

    const descriptor = response.json();
    const download = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${descriptor.artifactId}?ownerKind=SESSION&ownerId=${session.id}`,
      headers: { host: "127.0.0.1" },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("streamed route contents");
    await app.close();
  });

  it("loads and revision-checks strict owner drafts", async () => {
    const { app, session } = await setup();
    const owner = { kind: "SESSION", sessionId: session.id };
    const initial = await app.inject({
      method: "GET",
      url: `/api/v1/attachment-drafts?ownerKind=SESSION&ownerId=${session.id}`,
      headers: { host: "127.0.0.1" },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ draft: null });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/attachment-drafts",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { owner, expectedRevision: 0, text: "recover this", artifactIds: [] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ draft: { owner, revision: 1, text: "recover this" } });

    const stale = await app.inject({
      method: "PUT",
      url: "/api/v1/attachment-drafts",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { owner, expectedRevision: 0, text: "overwrite", artifactIds: [] },
    });
    expect(stale.statusCode).toBe(409);
    await app.close();
  });

  it("validates owner and filename headers before accepting the stream", async () => {
    const { app, session } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { ...requestHeaders(session.id), "x-caelush-filename": "../secret.txt" },
      payload: Buffer.from("no"),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    await app.close();
  });
});
