import {
  AttachmentDescriptorSchema,
  AttachmentDraftSchema,
  AttachmentOwnerSchema,
  AttachmentUploadBeginRequestSchema,
  AgentRunSchema,
  ATTACHMENT_ONLY_RUN_GOAL,
  CreateRunRequestSchema,
  CreateSessionRequestSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  TranscriptAttachmentRefSchema,
  createSessionId,
  createRunId,
  createWorkspaceId,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const workspaceId = createWorkspaceId();
const sessionId = createSessionId();
const owner = { kind: "WORKSPACE" as const, workspaceId };
const attachmentId = "att_01j8x2v8q7p3k6s9d4m5n0c1ab";

const descriptor = {
  artifactId: attachmentId,
  workspaceId,
  name: "notes.txt",
  mediaType: "text/plain",
  byteLength: 42,
  sha256: "a".repeat(64),
  status: "READY" as const,
  visualRequirement: "NOT_REQUIRED" as const,
  processorVersion: "text-v1",
};

const runBase = {
  goal: "Review the attached notes.",
  workspace: { id: workspaceId, path: "C:/workspace" },
  runtime: { id: "local", kind: "test" },
  preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
  limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1_000 },
};

describe("conversation attachment contracts", () => {
  it("attachmentDescriptorRejectsHostPathAndBytes", () => {
    expect(AttachmentDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(
      AttachmentDescriptorSchema.safeParse({
        ...descriptor,
        absolutePath: "C:/Users/private/report.txt",
      }).success,
    ).toBe(false);
    expect(AttachmentDescriptorSchema.safeParse({ ...descriptor, bytes: "raw" }).success).toBe(
      false,
    );
  });

  it("draftOwnerIsExactlyWorkspaceOrSession", () => {
    expect(AttachmentOwnerSchema.parse(owner)).toEqual(owner);
    expect(AttachmentOwnerSchema.parse({ kind: "SESSION", sessionId })).toEqual({
      kind: "SESSION",
      sessionId,
    });
    expect(AttachmentOwnerSchema.safeParse({ ...owner, path: "C:/workspace" }).success).toBe(false);
    expect(AttachmentOwnerSchema.safeParse({ kind: "RUN", runId: "run_fake" }).success).toBe(false);
    expect(
      AttachmentDraftSchema.safeParse({
        owner,
        revision: 1,
        text: "draft",
        artifactIds: [attachmentId],
        submissionId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("uploadMetadataUsesByteLimits", () => {
    expect(MAX_ATTACHMENT_COUNT).toBe(10);
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_MESSAGE_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
    expect(
      AttachmentUploadBeginRequestSchema.safeParse({
        owner,
        name: "notes.txt",
        declaredMediaType: "text/plain",
        declaredByteLength: MAX_ATTACHMENT_BYTES,
      }).success,
    ).toBe(true);
    expect(
      AttachmentUploadBeginRequestSchema.safeParse({
        owner,
        name: "too-large.txt",
        declaredMediaType: "text/plain",
        declaredByteLength: MAX_ATTACHMENT_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      AttachmentUploadBeginRequestSchema.safeParse({
        owner,
        name: "bad-name.txt",
        declaredMediaType: "text/plain",
        declaredByteLength: 1,
        destinationPath: "C:/outside",
      }).success,
    ).toBe(false);
  });

  it("createRunAcceptsAttachmentOnlyAndOldTextRequest", () => {
    expect(CreateRunRequestSchema.safeParse(runBase).success).toBe(true);
    const submissionId = "6f6cfeba-0bf8-4f88-a55d-f16e87d2671d";
    const attachmentOnlyRequest = CreateRunRequestSchema.parse({
      ...runBase,
      goal: ATTACHMENT_ONLY_RUN_GOAL,
      userText: "",
      attachmentIds: [attachmentId],
      submissionId,
    });
    expect(attachmentOnlyRequest).toMatchObject({ userText: "", attachmentIds: [attachmentId] });
    const persistedRun = AgentRunSchema.parse({
      id: createRunId(),
      sessionId,
      goal: attachmentOnlyRequest.goal,
      userText: attachmentOnlyRequest.userText,
      attachmentIds: attachmentOnlyRequest.attachmentIds,
      submissionId: attachmentOnlyRequest.submissionId,
      status: "PENDING",
      workspace: runBase.workspace,
      model: { provider: "test", model: "test-model" },
      runtime: runBase.runtime,
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      limits: runBase.limits,
      createdAt: 1,
    });
    expect(persistedRun).toMatchObject({
      goal: ATTACHMENT_ONLY_RUN_GOAL,
      userText: "",
      attachmentIds: [attachmentId],
      submissionId,
    });
    expect(CreateRunRequestSchema.safeParse({ ...runBase, attachmentIds: [] }).success).toBe(false);
  });

  it("createSessionAcceptsSubmissionId", () => {
    expect(
      CreateSessionRequestSchema.safeParse({
        defaultWorkspace: { id: workspaceId, path: "C:/workspace" },
        submissionId: "6f6cfeba-0bf8-4f88-a55d-f16e87d2671d",
      }).success,
    ).toBe(true);
    expect(CreateSessionRequestSchema.safeParse({ submissionId: "bad-id" }).success).toBe(false);
  });

  it("transcriptAttachmentReferenceContainsOnlySafeDisplayMetadata", () => {
    expect(
      TranscriptAttachmentRefSchema.safeParse({
        artifactId: attachmentId,
        name: "notes.txt",
        mediaType: "text/plain",
        byteLength: 42,
        previewAvailable: false,
        downloadAvailable: true,
      }).success,
    ).toBe(true);
    expect(
      TranscriptAttachmentRefSchema.safeParse({
        artifactId: attachmentId,
        name: "notes.txt",
        mediaType: "text/plain",
        byteLength: 42,
        previewAvailable: false,
        downloadAvailable: true,
        storagePath: "C:/private/notes.txt",
      }).success,
    ).toBe(false);
  });
});
