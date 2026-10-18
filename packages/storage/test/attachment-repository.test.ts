import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrateSync } from "drizzle-orm/sqlite-core/async/session";
import { agentMessageId, conversationTurnId, type AgentMessageRecordDraft } from "@caelush/agent";
import {
  AgentRunSchema,
  AttachmentIdSchema,
  SubmissionIdSchema,
  type SessionId,
  type WorkspaceId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { StorageConflictError } from "../src/errors.js";
import { finalizeRunSecurityPolicies } from "../src/security-policy-migration.js";
import {
  finalizeAgentMessages,
  migratePostMessageV2Storage,
} from "../src/messages/migration/finalize-agent-messages.js";
import { getCaelushMigrationsFolder, migrateCaelushDatabase } from "../src/migrate.js";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { makeRun, makeSession, makeState } from "./support/fixtures.js";

const storages: CaelushStorage[] = [];
afterEach(async () => {
  await Promise.all(storages.splice(0).map((storage) => storage.close()));
});

const attachmentId = AttachmentIdSchema.parse("att_01j8x2v8q7p3k6s9d4m5n0c1ab");
const submissionId = SubmissionIdSchema.parse("6f6cfeba-0bf8-4f88-a55d-f16e87d2671d");
const ownerSession = (sessionId: SessionId) => ({ kind: "SESSION" as const, sessionId });

async function fixture() {
  const storage = await openCaelushStorage({ path: ":memory:" });
  storages.push(storage);
  const timestamp = createTimestampMs(1_700_000_000_000);
  const workspace = {
    id: createWorkspaceId(),
    canonicalPath: "D:/attachment-workspace",
    displayName: "attachment-workspace",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
  };
  await storage.workspaces.insert(workspace);
  const session = makeSession({
    workspaceId: workspace.id,
    defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
  });
  await storage.sessions.insert(session);
  return {
    storage,
    workspace,
    session,
    workspaceRef: { id: workspace.id, path: workspace.canonicalPath },
  };
}

function pendingInput(workspaceId: WorkspaceId, sessionId: SessionId, id = attachmentId) {
  return {
    artifactId: AttachmentIdSchema.parse(id),
    workspaceId,
    owner: ownerSession(sessionId),
    name: "notes.txt",
    declaredMediaType: "text/plain",
    createdAt: createTimestampMs(1_700_000_000_000),
  };
}

function readyMetadata() {
  return {
    mediaType: "text/plain",
    byteLength: 42,
    sha256: "a".repeat(64),
    visualRequirement: "NOT_REQUIRED" as const,
    processorVersion: "text-v1",
  };
}

describe("SQLite conversation attachment repositories", () => {
  it("pendingAttachmentCannotRead", async () => {
    const { storage, workspace, session } = await fixture();
    await storage.attachments.createPending(pendingInput(workspace.id, session.id));

    expect(await storage.attachments.getAuthorized(attachmentId, ownerSession(session.id))).toBe(
      null,
    );
  });

  it("foreignOwnerCannotRead", async () => {
    const { storage, workspace, session } = await fixture();
    await storage.attachments.createPending(pendingInput(workspace.id, session.id));
    await storage.attachments.markReady(attachmentId, readyMetadata());

    expect(
      await storage.attachments.getAuthorized(attachmentId, {
        kind: "WORKSPACE",
        workspaceId: createWorkspaceId(),
      }),
    ).toBe(null);
  });

  it("readyMetadataIsImmutable", async () => {
    const { storage, workspace, session } = await fixture();
    await storage.attachments.createPending(pendingInput(workspace.id, session.id));
    await storage.attachments.markReady(attachmentId, readyMetadata());

    await expect(
      storage.attachments.markReady(attachmentId, {
        ...readyMetadata(),
        sha256: "b".repeat(64),
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("draftRevisionConflictDoesNotOverwrite", async () => {
    const { storage, workspace, session } = await fixture();
    await storage.attachments.createPending(pendingInput(workspace.id, session.id));
    await storage.attachments.markReady(attachmentId, readyMetadata());
    const owner = ownerSession(session.id);

    await storage.attachments.saveDraft(owner, 0, { text: "first", artifactIds: [attachmentId] });
    await expect(
      storage.attachments.saveDraft(owner, 0, { text: "stale", artifactIds: [] }),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await expect(storage.attachments.getDraft(owner)).resolves.toMatchObject({
      revision: 1,
      text: "first",
      artifactIds: [attachmentId],
    });
  });

  it("binds a workspace draft attachment to its first session user message", async () => {
    const { storage, workspace, session, workspaceRef } = await fixture();
    await storage.attachments.createPending({
      ...pendingInput(workspace.id, session.id),
      owner: { kind: "WORKSPACE", workspaceId: workspace.id },
    });
    await storage.attachments.markReady(attachmentId, readyMetadata());
    const pendingRun = makeRun(session.id, {
      workspace: workspaceRef,
      userText: "",
      attachmentIds: [attachmentId],
    });
    await storage.runs.insert(pendingRun);
    const runningRun = AgentRunSchema.parse({
      ...pendingRun,
      status: "RUNNING",
      startedAt: createTimestampMs(1_700_000_000_001),
    });
    const messageId = agentMessageId("amsg_0192f5b1-4d3a-7c2e-8a91-000000000098");
    const messageDraft: AgentMessageRecordDraft = {
      messageId,
      sessionId: session.id,
      conversationTurnId: conversationTurnId("cturn_0192f5b1-4d3a-7c2e-8a91-000000000098"),
      messageType: "USER",
      schemaVersion: 1,
      modelProjectionVersion: 2,
      createdAt: createTimestampMs(1_700_000_000_001),
      source: { kind: "USER", origin: "GOAL" },
      audience: { model: true, transcript: true, debug: true },
      data: {
        content: [
          { type: "TEXT", text: "" },
          { type: "ATTACHMENT_REF", artifactId: attachmentId },
        ],
      },
    };

    await storage.execution.commit({
      run: runningRun,
      state: makeState(runningRun, { status: "RUNNING" }),
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [],
      messagesToAppend: [{ draft: messageDraft, attachmentIds: [attachmentId] }],
      events: [],
    });

    await expect(
      storage.attachments.getAuthorized(attachmentId, ownerSession(session.id)),
    ).resolves.toMatchObject({ artifactId: attachmentId });
  });

  it("sentReferencePreventsDraftCleanup", async () => {
    const { storage, workspace, session, workspaceRef } = await fixture();
    await storage.attachments.createPending(pendingInput(workspace.id, session.id));
    await storage.attachments.markReady(attachmentId, readyMetadata());
    const owner = ownerSession(session.id);
    await storage.attachments.saveDraft(owner, 0, { text: "", artifactIds: [attachmentId] });
    const pendingRun = makeRun(session.id, { workspace: workspaceRef });
    await storage.runs.insert(pendingRun);
    const runningRun = AgentRunSchema.parse({
      ...pendingRun,
      status: "RUNNING",
      startedAt: createTimestampMs(1_700_000_000_001),
    });
    const messageId = agentMessageId("amsg_0192f5b1-4d3a-7c2e-8a91-000000000099");
    const messageDraft: AgentMessageRecordDraft = {
      messageId,
      sessionId: session.id,
      conversationTurnId: conversationTurnId("cturn_0192f5b1-4d3a-7c2e-8a91-000000000099"),
      messageType: "USER",
      schemaVersion: 1,
      modelProjectionVersion: 1,
      createdAt: createTimestampMs(1_700_000_000_001),
      source: { kind: "USER", origin: "GOAL" },
      audience: { model: true, transcript: true, debug: true },
      data: {
        content: [
          { type: "TEXT", text: "" },
          { type: "ATTACHMENT_REF", artifactId: attachmentId },
        ],
      },
    };
    await storage.execution.commit({
      run: runningRun,
      state: makeState(runningRun, { status: "RUNNING" }),
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [],
      messagesToAppend: [{ draft: messageDraft, attachmentIds: [attachmentId] }],
      events: [],
    });
    await storage.attachments.removeDraftReference(owner, attachmentId);

    await expect(storage.attachments.listUnreferenced(1_800_000_000_000)).resolves.not.toContain(
      attachmentId,
    );
  });

  it("can mark a READY blob unavailable after crash recovery detects it is missing", async () => {
    const { storage, workspace, session } = await fixture();
    await storage.attachments.createPending(pendingInput(workspace.id, session.id));
    await storage.attachments.markReady(attachmentId, readyMetadata());

    await storage.attachments.markUnavailable(attachmentId);

    expect(await storage.attachments.getAuthorized(attachmentId, ownerSession(session.id))).toBe(
      null,
    );
    await expect(storage.attachments.listForRecovery()).resolves.toEqual([
      expect.objectContaining({ artifactId: attachmentId, status: "UNAVAILABLE" }),
    ]);
  });

  it("duplicateSubmissionResolvesExistingRun", async () => {
    const { storage, workspace, workspaceRef } = await fixture();
    const payloadHash = "c".repeat(64);
    await storage.submissions.reserve(submissionId, payloadHash);
    const session = makeSession({
      workspaceId: workspace.id,
      defaultWorkspace: workspaceRef,
    });
    await storage.sessions.insert(session, { expectedWorkspace: workspace, submissionId });
    const run = makeRun(session.id, {
      workspace: workspaceRef,
      submissionId,
      attachmentIds: [attachmentId],
    });
    await storage.runs.insert(run);

    await expect(storage.submissions.reserve(submissionId, payloadHash)).resolves.toMatchObject({
      submissionId,
      sessionId: session.id,
      runId: run.id,
    });
  });

  it("differentPayloadForSameSubmissionConflicts", async () => {
    const { storage } = await fixture();
    await storage.submissions.reserve(submissionId, "c".repeat(64));

    await expect(storage.submissions.reserve(submissionId, "d".repeat(64))).rejects.toBeInstanceOf(
      StorageConflictError,
    );
  });

  it("oldDatabaseMigratesWithEmptyAttachments", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    const migrationsFolder = getCaelushMigrationsFolder();
    const migrations = readMigrationFiles({ migrationsFolder });
    migrateSync(
      migrations.filter(
        (migration) =>
          migration.name !== "20260924120000_message_system_v2_final" &&
          migration.name !== "20261018120000_conversation_attachments" &&
          migration.name !== "20261008120000_private_replay",
      ),
      database.drizzle._.session,
    );
    finalizeAgentMessages(database, migrationsFolder);
    migratePostMessageV2Storage(database, migrationsFolder);
    finalizeRunSecurityPolicies(database);
    const oldSessionRepository = new SqliteSessionRepository(database);
    const existingSession = makeSession();
    await oldSessionRepository.insert(existingSession);

    await migrateCaelushDatabase(database);

    expect(database.client.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({
      count: 0,
    });
    expect(await oldSessionRepository.get(existingSession.id)).toEqual(existingSession);
    await database.close();
  });
});
