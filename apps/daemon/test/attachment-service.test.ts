import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  AttachmentIdSchema,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type AgentSession,
  type WorkspaceRecord,
} from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttachmentService } from "../src/attachments/attachment-service.js";

const filesystemState = vi.hoisted(() => ({ failBlobReads: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (filesystemState.failBlobReads && String(args[0]).endsWith(".blob")) {
        throw Object.assign(new Error("synthetic blob read failure"), { code: "EACCES" });
      }
      return actual.readFile(...args);
    },
  };
});

let storage: CaelushStorage | undefined;
let directory: string | undefined;

afterEach(async () => {
  filesystemState.failBlobReads = false;
  await storage?.close();
  storage = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function setup() {
  directory = await mkdtemp(join(tmpdir(), "caelush-attachment-service-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const timestamp = createTimestampMs(Date.now());
  const workspace: WorkspaceRecord = {
    id: createWorkspaceId(),
    canonicalPath: "C:/attachment-fixture",
    displayName: "attachment-fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
  };
  await storage.workspaces.insert(workspace);
  const makeSession = (): AgentSession => ({
    id: createSessionId(),
    workspaceId: workspace.id,
    defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  });
  const ownerSession = makeSession();
  const foreignSession = makeSession();
  await storage.sessions.insert(ownerSession, { expectedWorkspace: workspace });
  await storage.sessions.insert(foreignSession, { expectedWorkspace: workspace });
  const attachmentsRoot = join(directory, "attachments");
  const service = createAttachmentService({
    attachments: storage.attachments,
    sessions: storage.sessions,
    workspaces: storage.workspaces,
    rootDirectory: attachmentsRoot,
  });
  return { service, attachmentsRoot, ownerSession, foreignSession, workspace };
}

function owner(sessionId: string) {
  return { kind: "SESSION" as const, sessionId };
}

async function upload(
  service: ReturnType<typeof createAttachmentService>,
  sessionId: string,
  name: string,
  content: string,
) {
  return service.upload({
    owner: owner(sessionId),
    name,
    declaredMediaType: "text/plain",
    stream: Readable.from([Buffer.from(content)]),
  });
}

describe("daemon attachment service", () => {
  it("keeps same-name uploads in separate opaque blob files", async () => {
    const { service, attachmentsRoot, ownerSession } = await setup();
    const first = await upload(service, ownerSession.id, "notes.txt", "first document");
    const second = await upload(service, ownerSession.id, "notes.txt", "second document");

    expect(first.artifactId).not.toBe(second.artifactId);
    expect(await readdir(attachmentsRoot)).toHaveLength(2);
    await expect(
      service.download({ artifactId: first.artifactId, owner: owner(ownerSession.id) }),
    ).resolves.toEqual(Buffer.from("first document"));
    await expect(
      service.download({ artifactId: second.artifactId, owner: owner(ownerSession.id) }),
    ).resolves.toEqual(Buffer.from("second document"));
  });

  it("does not let a different session read or download an attachment", async () => {
    const { service, ownerSession, foreignSession } = await setup();
    const descriptor = await upload(service, ownerSession.id, "private.txt", "private contents");

    await expect(
      service.read({
        artifactId: descriptor.artifactId,
        owner: owner(foreignSession.id),
        range: { kind: "MANIFEST" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.download({ artifactId: descriptor.artifactId, owner: owner(foreignSession.id) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("accepts a workspace draft attachment for a session in that same workspace", async () => {
    const { service, ownerSession, foreignSession, workspace } = await setup();
    const descriptor = await service.upload({
      owner: { kind: "WORKSPACE", workspaceId: workspace.id },
      name: "new-chat.txt",
      declaredMediaType: "text/plain",
      stream: Readable.from([Buffer.from("workspace draft")]),
    });

    await expect(service.getReadyForRun([descriptor.artifactId], ownerSession.id)).resolves.toEqual(
      [descriptor],
    );

    const privateDescriptor = await upload(
      service,
      ownerSession.id,
      "session-only.txt",
      "private to one session",
    );
    await expect(
      service.getReadyForRun([privateDescriptor.artifactId], foreignSession.id),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("deletes an attachment only after its durable draft and message references are gone", async () => {
    const { service, ownerSession, attachmentsRoot } = await setup();
    const descriptor = await upload(service, ownerSession.id, "draft.txt", "keep until sent");
    const attachmentOwner = owner(ownerSession.id);
    await storage!.attachments.saveDraft(attachmentOwner, 0, {
      text: "draft",
      artifactIds: [descriptor.artifactId],
    });

    await expect(service.cleanupUnreferenced(Date.now() + 1)).resolves.toEqual([]);
    await expect(
      service.download({ artifactId: descriptor.artifactId, owner: attachmentOwner }),
    ).resolves.toEqual(Buffer.from("keep until sent"));

    await storage!.attachments.removeDraftReference(attachmentOwner, descriptor.artifactId);
    await expect(service.cleanupUnreferenced(Date.now() + 1)).resolves.toEqual([
      descriptor.artifactId,
    ]);
    await expect(
      readFile(join(attachmentsRoot, `${descriptor.artifactId}.blob`)),
    ).rejects.toThrow();
    await expect(storage!.attachments.listForRecovery()).resolves.toEqual([]);
  });

  it("provides a verified, session-scoped snapshot for attachment context reads", async () => {
    const { service, ownerSession, foreignSession, workspace } = await setup();
    const descriptor = await service.upload({
      owner: { kind: "WORKSPACE", workspaceId: workspace.id },
      name: "context.txt",
      declaredMediaType: "text/plain",
      stream: Readable.from([Buffer.from("first line\nsecond line")]),
    });
    const signal = new AbortController().signal;
    const snapshot = await service.readSnapshot({
      artifactId: descriptor.artifactId,
      owner: owner(ownerSession.id),
      signal,
    });

    expect(snapshot.descriptor).toEqual(descriptor);
    expect(snapshot.manifest.sha256).toBe(descriptor.sha256);
    const result = await snapshot.contentReference.read({
      range: { kind: "TEXT_LINES", startLine: 1, lineCount: 2 },
      signal,
    });
    expect(result.items).toContainEqual(
      expect.objectContaining({ type: "TEXT", text: "first line\nsecond line" }),
    );

    const privateDescriptor = await upload(
      service,
      ownerSession.id,
      "private.txt",
      "session contents",
    );
    await expect(
      service.readSnapshot({
        artifactId: privateDescriptor.artifactId,
        owner: owner(foreignSession.id),
        signal,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("counts actual stream bytes even when the advisory upload length is falsified", async () => {
    const { service, ownerSession } = await setup();
    const content = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    await expect(
      service.upload({
        owner: owner(ownerSession.id),
        name: "too-large.txt",
        declaredMediaType: "text/plain",
        declaredByteLength: 1,
        stream: Readable.from([content]),
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  }, 20_000);

  it("marks an interrupted upload failed and removes its temporary file", async () => {
    const { service, attachmentsRoot, ownerSession } = await setup();
    const stream = Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("synthetic disconnect");
      })(),
    );

    await expect(
      service.upload({
        owner: owner(ownerSession.id),
        name: "interrupted.txt",
        declaredMediaType: "text/plain",
        stream,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });
    await expect(readdir(attachmentsRoot)).resolves.toEqual([]);
  });

  it("marks database attachments unavailable when startup recovery finds a missing blob", async () => {
    const { service, attachmentsRoot, ownerSession } = await setup();
    const descriptor = await upload(service, ownerSession.id, "lost.txt", "recover me");
    await rm(join(attachmentsRoot, `${descriptor.artifactId}.blob`));

    await service.recover();
    expect(
      await storage?.attachments.getAuthorized(descriptor.artifactId, owner(ownerSession.id)),
    ).toBeNull();
    await expect(
      readFile(join(attachmentsRoot, `${descriptor.artifactId}.blob`)),
    ).rejects.toThrow();
  });

  it("removes orphaned blobs that have no attachment metadata during recovery", async () => {
    const { service, attachmentsRoot } = await setup();
    const orphanId = AttachmentIdSchema.parse("att_01j8x2v8q7p3k6s9d4m5n0c1ab");
    await mkdir(attachmentsRoot, { recursive: true });
    const orphanPath = join(attachmentsRoot, `${orphanId}.blob`);
    await writeFile(orphanPath, "orphaned bytes");

    await service.recover();

    await expect(readFile(orphanPath)).rejects.toThrow();
  });

  it("marks a blob unavailable and continues recovery when integrity reads fail", async () => {
    const { service, ownerSession } = await setup();
    const descriptor = await upload(service, ownerSession.id, "unreadable.txt", "recover me");
    filesystemState.failBlobReads = true;

    await expect(service.recover()).resolves.toBeUndefined();
    filesystemState.failBlobReads = false;
    await expect(
      storage?.attachments.getAuthorized(descriptor.artifactId, owner(ownerSession.id)),
    ).resolves.toBeNull();
  });

  it("rejects a list larger than the message attachment limit before reading metadata", async () => {
    const { service, ownerSession } = await setup();
    const ids = Array.from({ length: 11 }, (_, index) =>
      AttachmentIdSchema.parse(`att_${String(index).padStart(12, "0")}`),
    );

    await expect(service.getReadyForOwner(ids, owner(ownerSession.id))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});
