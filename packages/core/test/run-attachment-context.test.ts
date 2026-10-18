import { describe, expect, it } from "vitest";
import type { AIMessage, ModelDescriptor } from "@caelush/ai";
import {
  AGENT_USER_MESSAGE_AUDIENCE,
  agentAttachmentRefPart,
  agentMessageId,
  agentTextPart,
  attachmentMarker,
  attachmentMarkerV2,
  createAgentMessageFactory,
  createAgentConversationSnapshot,
  createConversationTurn,
  createDeterministicConversationTurnIdFactory,
  createScriptedAgentMessageIdFactory,
  NO_TOOL_RESULT_OBSERVATION,
  toolMessageSource,
  userMessageSource,
} from "@caelush/agent";
import type {
  ContextEnginePort,
  ContextPrepareInput,
  PreparedModelContext,
  StoredAgentMessage,
} from "@caelush/agent";
import {
  AttachmentContextMaterializationError,
  createAttachmentAwareContextEngine,
} from "../src/run-attachment-context.js";
import type {
  AttachmentContextPort,
  AttachmentContextSnapshot,
} from "../src/attachment-context-port.js";
import type { AttachmentModelContentReference, TimestampMs } from "@caelush/protocol";

const RUN_ID =
  "run_0195f3a0-0000-7000-8000-000000000000" as ContextPrepareInput["identity"]["runId"];
const SESSION_ID =
  "ses_0195f3a0-0000-7000-8000-000000000000" as ContextPrepareInput["identity"]["sessionId"];
const WORKSPACE_ID =
  "wsp_0195f3a0-0000-7000-8000-000000000000" as AttachmentContextSnapshot["descriptor"]["workspaceId"];
const TURN_FACTORY = createDeterministicConversationTurnIdFactory();
const TURN_ID = TURN_FACTORY.forRun(RUN_ID);
const MESSAGE_ID = agentMessageId("amsg_0195f3a0-0000-7000-8000-000000000000");
const ARTIFACT_ID = "att_0123456789ab" as AttachmentContextSnapshot["descriptor"]["artifactId"];
const SHA256 = "a".repeat(64);
const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "fixture-model" },
  api: "fixture-api",
  limits: { contextWindowTokens: 8_192, maxOutputTokens: 1_024 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "SUPPORTED",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

function fixtureInput(
  model: ModelDescriptor = MODEL,
  projectionVersion = 2,
  additionalMessages: readonly StoredAgentMessage[] = [],
): ContextPrepareInput {
  const userMessage = {
    id: MESSAGE_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    conversationTurnId: TURN_ID,
    createdAt: 1_000 as ContextPrepareInput["turn"]["stepId"] & number,
    source: userMessageSource("GOAL"),
    audience: AGENT_USER_MESSAGE_AUDIENCE,
    type: "USER" as const,
    content: [
      agentTextPart("Please inspect this."),
      agentAttachmentRefPart({ artifactId: ARTIFACT_ID }),
    ],
  };
  const stored = {
    sequence: 1,
    schemaVersion: 1,
    modelProjectionVersion: projectionVersion,
    message: userMessage,
  };
  return {
    identity: { runId: RUN_ID, sessionId: SESSION_ID, goal: "inspect attachment" },
    turn: {
      stepId: "stp_0195f3a0-0000-7000-8000-000000000000" as ContextPrepareInput["turn"]["stepId"],
      sequence: 1,
    },
    conversation: createAgentConversationSnapshot({
      sessionId: SESSION_ID,
      currentRunId: RUN_ID,
      currentTurnId: TURN_ID,
      turns: [
        createConversationTurn({
          id: TURN_ID,
          sessionId: SESSION_ID,
          runId: RUN_ID,
          status: "OPEN",
          openedAt: 1_000 as ContextPrepareInput["turn"]["stepId"] & number,
          messages: [stored, ...additionalMessages],
        }),
      ],
    }),
    input: { kind: "USER_INPUT", messages: [] },
    model,
    tools: [],
    mode: "NORMAL",
    signal: new AbortController().signal,
  } as unknown as ContextPrepareInput;
}

function prepared(
  message: AIMessage,
  selectedMessageIds: readonly string[] = [MESSAGE_ID],
  remainingTokens = 200,
): PreparedModelContext {
  return {
    messages: [message],
    requestBudget: { version: "ADAPTIVE_V1", outputReserveTokens: 1_024, safetyReserveTokens: 256 },
    selectedMessageIds,
    report: {
      estimatedInputTokens: 100,
      effectiveInputLimitTokens: 2_000,
      remainingTokens,
      pressure: "NORMAL",
      compactionCount: 0,
      requestOverheadTokens: 10,
      contributions: [],
    },
    observationPolicy: { maxSingleObservationTokens: 1_000, maxObservationBatchTokens: 2_000 },
  };
}

function snapshot(overrides: Partial<AttachmentContextSnapshot> = {}): AttachmentContextSnapshot {
  const descriptor: AttachmentContextSnapshot["descriptor"] = {
    artifactId: ARTIFACT_ID,
    workspaceId: WORKSPACE_ID,
    name: "notes.txt",
    mediaType: "text/plain",
    byteLength: 5,
    sha256: SHA256,
    status: "READY",
    visualRequirement: "NOT_REQUIRED",
    processorVersion: "attachments-v1",
  };
  const manifest: AttachmentContextSnapshot["manifest"] = {
    artifactId: ARTIFACT_ID,
    sha256: SHA256,
    mediaType: "text/plain",
    processorVersion: "attachments-v1",
    visualRequirement: "NOT_REQUIRED",
    kind: "TEXT",
    encoding: "UTF-8",
    lineCount: 1,
    characterCount: 5,
  };
  return {
    descriptor,
    manifest,
    contentReference: {
      artifactId: ARTIFACT_ID,
      sha256: SHA256,
      async read({ range }) {
        return {
          artifactId: ARTIFACT_ID,
          sha256: SHA256,
          processorVersion: "attachments-v1",
          range,
          items: [
            {
              type: "TEXT",
              location: { kind: "TEXT_LINES", startLine: 1, endLine: 1 },
              text: "hello",
            },
          ],
          truncated: false,
          outputBytes: 32,
        };
      },
    },
    ...overrides,
  };
}

function portWith(snapshotValue: AttachmentContextSnapshot): AttachmentContextPort {
  return {
    async readSnapshot() {
      return snapshotValue;
    },
  };
}

function hostEngine(result: PreparedModelContext): ContextEnginePort {
  return {
    async prepare() {
      return result;
    },
  };
}

describe("Core attachment model materialization", () => {
  it("replaces a new durable reference with bounded text and accounts for its budget", async () => {
    const marker = attachmentMarkerV2({ artifactId: ARTIFACT_ID });
    const engine = createAttachmentAwareContextEngine(
      hostEngine(prepared({ role: "user", content: `Please inspect this.\n${marker}` })),
      portWith(snapshot()),
    );

    const result = await engine.prepare(fixtureInput());

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Please inspect this.\n" },
          { type: "text", text: "[notes.txt; lines 1-1]\nhello" },
        ],
      },
    ]);
    expect(result.report.estimatedInputTokens).toBeGreaterThan(100);
    expect(result.report.remainingTokens).toBeLessThan(200);
    expect(result.report.contributions).toContainEqual(
      expect.objectContaining({ providerId: "conversation.attachments", itemCount: 1 }),
    );
  });

  it("replays a historical Tool page image by its bounded attachment reference", async () => {
    const reference: AttachmentModelContentReference = {
      artifactId: ARTIFACT_ID,
      sha256: SHA256,
      range: { kind: "PDF_PAGE", pageNumber: 2 },
      location: { kind: "PDF_PAGE", pageNumber: 2 },
      mediaType: "image/png",
    };
    const toolFactory = createAgentMessageFactory({
      ids: createScriptedAgentMessageIdFactory(["amsg_0195f3a0-0000-7000-8000-000000000001"]),
      now: () => 1_000 as TimestampMs,
      turns: TURN_FACTORY,
    });
    const toolMessageValue = toolFactory.createToolResult({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      conversationTurnId: TURN_ID,
      sourceStepId:
        "stp_0195f3a0-0000-7000-8000-000000000002" as ContextPrepareInput["turn"]["stepId"],
      source: toolMessageSource(),
      toolCallId: "call_page_image",
      toolName: "read_attachment",
      observation: NO_TOOL_RESULT_OBSERVATION,
      isError: false,
      projectedContent: "Page 2 contains a diagram.",
      attachmentReferences: [reference],
      projection: {
        policy: {
          kind: "SNAPSHOT",
          snapshot: { maxSingleObservationTokens: 100, maxObservationBatchTokens: 200 },
        },
        fingerprint: "fixture-fingerprint",
        version: 1,
      },
    });
    const storedToolResult: StoredAgentMessage = {
      sequence: 2,
      schemaVersion: 2,
      modelProjectionVersion: 1,
      message: toolMessageValue,
    };
    const imageSnapshot = snapshot({
      descriptor: {
        artifactId: ARTIFACT_ID,
        workspaceId: WORKSPACE_ID,
        name: "report.pdf",
        mediaType: "application/pdf",
        byteLength: 128,
        sha256: SHA256,
        status: "READY",
        visualRequirement: "REQUIRED",
        processorVersion: "attachments-v1",
      },
      manifest: {
        artifactId: ARTIFACT_ID,
        sha256: SHA256,
        mediaType: "application/pdf",
        processorVersion: "attachments-v1",
        visualRequirement: "REQUIRED",
        kind: "PDF",
        pageCount: 2,
        pages: [
          {
            pageNumber: 1,
            textAvailable: false,
            visualContentAvailable: true,
            width: 640,
            height: 480,
          },
          {
            pageNumber: 2,
            textAvailable: false,
            visualContentAvailable: true,
            width: 640,
            height: 480,
          },
        ],
      },
      contentReference: {
        artifactId: ARTIFACT_ID,
        sha256: SHA256,
        async read({ range }) {
          return {
            artifactId: ARTIFACT_ID,
            sha256: SHA256,
            processorVersion: "attachments-v1",
            range,
            items: [
              {
                type: "IMAGE",
                location: { kind: "PDF_PAGE", pageNumber: 2 },
                mediaType: "image/png",
                data: "aGVsbG8=",
                width: 640,
                height: 480,
              },
            ],
            truncated: false,
            outputBytes: 16,
          };
        },
      },
    });
    const toolMessage: AIMessage = {
      role: "tool",
      toolCallId: "call_page_image",
      toolName: "read_attachment",
      content: "Page 2 contains a diagram.",
      isError: false,
    };
    let snapshotReads = 0;
    const engine = createAttachmentAwareContextEngine(
      hostEngine(prepared(toolMessage, [storedToolResult.message.id], 2_000)),
      {
        async readSnapshot() {
          snapshotReads += 1;
          return imageSnapshot;
        },
      },
    );

    const input = fixtureInput(MODEL, 2, [storedToolResult]);
    expect(input.conversation.turns[0]?.messages[1]?.message).toMatchObject({
      type: "TOOL_RESULT",
      attachmentReferences: [reference],
    });
    const result = await engine.prepare(input);

    expect(snapshotReads).toBe(1);
    expect(result.messages).toEqual([
      {
        role: "tool",
        toolCallId: "call_page_image",
        toolName: "read_attachment",
        content: [
          { type: "text", text: "Page 2 contains a diagram." },
          { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
        ],
        isError: false,
      },
    ]);
    expect(result.report.estimatedInputTokens).toBeGreaterThan(100);
  });

  it("fails closed when the snapshot integrity fields disagree", async () => {
    const invalid = snapshot({
      contentReference: {
        ...snapshot().contentReference,
        sha256: "b".repeat(64),
      },
    });
    const engine = createAttachmentAwareContextEngine(
      hostEngine(
        prepared({
          role: "user",
          content: `Please inspect this.\n${attachmentMarkerV2({ artifactId: ARTIFACT_ID })}`,
        }),
      ),
      portWith(invalid),
    );

    await expect(engine.prepare(fixtureInput())).rejects.toMatchObject({
      name: "AttachmentContextMaterializationError",
      code: "SNAPSHOT_INVALID",
    } satisfies Partial<AttachmentContextMaterializationError>);
  });

  it("leaves historical v1 projections unchanged and does not resolve their blobs eagerly", async () => {
    let calls = 0;
    const port: AttachmentContextPort = {
      async readSnapshot() {
        calls += 1;
        return snapshot();
      },
    };
    const marker = attachmentMarker({ artifactId: ARTIFACT_ID });
    const engine = createAttachmentAwareContextEngine(
      hostEngine(prepared({ role: "user", content: `Please inspect this.\n${marker}` })),
      port,
    );

    const result = await engine.prepare(fixtureInput(MODEL, 1));

    expect(result.messages).toEqual(
      prepared({ role: "user", content: `Please inspect this.\n${marker}` }).messages,
    );
    expect(calls).toBe(0);
  });

  it("keeps a large document as a durable reference instead of silently sending a prefix", async () => {
    const large = snapshot({
      descriptor: { ...snapshot().descriptor, byteLength: 1_000_000 },
      manifest: {
        artifactId: ARTIFACT_ID,
        sha256: SHA256,
        mediaType: "text/plain",
        processorVersion: "attachments-v1",
        visualRequirement: "NOT_REQUIRED",
        kind: "TEXT",
        encoding: "UTF-8",
        lineCount: 1_000_000,
        characterCount: 1_000_000,
      },
    });
    let reads = 0;
    const noReadPort: AttachmentContextPort = {
      async readSnapshot() {
        return {
          ...large,
          contentReference: {
            ...large.contentReference,
            async read() {
              reads += 1;
              throw new Error("large attachments must not be auto-read");
            },
          },
        };
      },
    };
    const marker = attachmentMarkerV2({ artifactId: ARTIFACT_ID });
    const base = prepared({ role: "user", content: `Please inspect this.\n${marker}` });
    const engine = createAttachmentAwareContextEngine(hostEngine(base), noReadPort);

    const result = await engine.prepare(fixtureInput());

    expect(result.messages).toEqual(base.messages);
    expect(reads).toBe(0);
    expect(result.report.contributions).toContainEqual(
      expect.objectContaining({ providerId: "conversation.attachments", droppedItems: 1 }),
    );
  });
});
