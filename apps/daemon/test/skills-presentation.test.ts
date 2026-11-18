import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunSchema,
  ToolInvocationSchema,
  ToolObservationSchema,
  createRunId,
  createObservationId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type DurableRunEvent,
  type PreparedInputResourceReceiptV1,
  type SessionId,
  type SessionTurnPresentationResponseV4,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";
import {
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageCodecRegistry,
  projectionVersionTable,
  agentTextPart,
  userMessageSource,
} from "@caelush/agent";
import { afterEach, describe, expect, it } from "vitest";
import { CaelushToolPresentation } from "@caelush/security";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { buildDaemonApp } from "../src/index.js";
import { SessionPresentationService } from "../src/services/session-presentation-service.js";
import { createSubmissionSkillViewService } from "../src/skills/submission-skill-view.js";

let routeStorage: CaelushStorage | undefined;
let routeDirectory: string | undefined;

afterEach(async () => {
  await routeStorage?.close();
  routeStorage = undefined;
  if (routeDirectory !== undefined) await rm(routeDirectory, { recursive: true, force: true });
  routeDirectory = undefined;
});

const NOW = createTimestampMs(1_700_100_000_000);
const SESSION_ID = createSessionId();
const RUN_ID = createRunId();
const STEP_ID = createStepId();
const WORKSPACE_ID = createWorkspaceId();
const HASH = `sha256:${"a".repeat(64)}`;
const manualSkillId = `skill:v1:${"b".repeat(64)}`;
const automaticSkillId = `skill:v1:${"c".repeat(64)}`;
const turns = createDeterministicConversationTurnIdFactory();
const factory = createAgentMessageFactory({
  ids: createAgentMessageIdFactory(),
  now: () => NOW,
  turns,
});
const codecs = createStandardAgentMessageCodecRegistry(() => 1);

function durableEvent(sequence: number): DurableRunEvent {
  return {
    eventId: `evt_skill_presentation_${sequence}` as never,
    schemaVersion: 1,
    type: sequence === 1 ? "run.completed" : "step.input.prepared",
    runId: RUN_ID,
    sessionId: SESSION_ID,
    stepId: STEP_ID,
    timestamp: NOW + sequence,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    payload: {},
  } as DurableRunEvent;
}

function usageFixture(options: {
  readonly invocationStatus: "REQUESTED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly hasAutomaticBinding: boolean;
  readonly isError?: boolean;
}) {
  const run = AgentRunSchema.parse({
    id: RUN_ID,
    sessionId: SESSION_ID,
    goal: "review this change",
    userText: "review this change",
    status: "COMPLETED",
    workspace: { id: WORKSPACE_ID, path: "D:\\private\\workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW + 20,
  });
  const user = factory.createUser({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    conversationTurnId: turns.forRun(RUN_ID),
    source: userMessageSource("GOAL"),
    content: [agentTextPart("review this change")],
  });
  const messageDraft = codecs.encode(user);
  const invocationId = createToolInvocationId();
  const invocation = ToolInvocationSchema.parse({
    id: invocationId,
    runId: RUN_ID,
    stepId: STEP_ID,
    externalCallId: "call_read_skill",
    toolName: "read_skill",
    args: { skillId: automaticSkillId, secret: "private skill body" },
    riskLevel: "LOW",
    status: options.invocationStatus,
    createdAt: NOW + 5,
    ...(options.invocationStatus === "RUNNING" ? { startedAt: NOW + 6 } : {}),
    ...(options.invocationStatus === "COMPLETED" ||
    options.invocationStatus === "FAILED" ||
    options.invocationStatus === "CANCELLED"
      ? { finishedAt: NOW + 7 }
      : {}),
  });
  const observation =
    options.invocationStatus === "COMPLETED" || options.isError === true
      ? ToolObservationSchema.parse({
          id: createObservationId(),
          kind: "TOOL",
          runId: RUN_ID,
          stepId: STEP_ID,
          toolInvocationId: invocationId,
          content: "safe tool result",
          isError: options.isError ?? false,
          createdAt: NOW + 8,
        })
      : undefined;
  const catalogSnapshot = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    catalogRevision: `sha256:${"d".repeat(64)}`,
    complete: true,
    artifactRef: "private-catalog-artifact",
    manifestFingerprint: HASH,
    skills: [
      {
        skillId: manualSkillId,
        name: "review-helper",
        description: "Review code changes",
        displayName: "Review helper",
        enabled: true,
        userInvocable: true,
        modelInvocable: false,
        bundle: {
          bundleRevision: "sha256:review-revision",
          artifactRef: "private-review-bundle",
          manifestFingerprint: HASH,
        },
      },
      {
        skillId: automaticSkillId,
        name: "change-analyzer",
        description: "Analyze code changes",
        enabled: true,
        userInvocable: true,
        modelInvocable: true,
        bundle: {
          bundleRevision: "sha256:automatic-revision",
          artifactRef: "private-automatic-bundle",
          manifestFingerprint: HASH,
        },
      },
    ],
  };
  const profile = {
    runId: RUN_ID,
    profileVersion: 1,
    workflowRendererVersion: "workflow-resource@1",
    catalogSnapshotRef: {
      catalogRevision: catalogSnapshot.catalogRevision,
      artifactRef: catalogSnapshot.artifactRef,
      manifestFingerprint: catalogSnapshot.manifestFingerprint,
    },
  };
  const binding = (input: {
    readonly bindingId: string;
    readonly skillId: string;
    readonly revision: string;
    readonly ordinal: number;
    readonly sourceToolInvocationId?: string;
  }): WorkflowResourceBindingV1 => ({
    runId: RUN_ID,
    bindingId: input.bindingId,
    resourceKind: "WORKFLOW_INSTRUCTION",
    resourceId: input.skillId,
    resourceRevision: input.revision,
    artifactRef: `private-${input.bindingId}-artifact`,
    sourceFingerprint: HASH,
    utf8Bytes: 512,
    tokenEstimate: 128,
    activationOrdinal: input.ordinal,
    ...(input.sourceToolInvocationId === undefined
      ? {}
      : { sourceToolInvocationId: input.sourceToolInvocationId as never }),
  });
  const bindings = [
    binding({
      bindingId: "binding_manual_review",
      skillId: manualSkillId,
      revision: "sha256:review-revision",
      ordinal: 0,
    }),
    ...(options.hasAutomaticBinding
      ? [
          binding({
            bindingId: "binding_model_analyzer",
            skillId: automaticSkillId,
            revision: "sha256:automatic-revision",
            ordinal: 1,
            sourceToolInvocationId: invocationId,
          }),
        ]
      : []),
  ];
  let receipts: readonly PreparedInputResourceReceiptV1[] = [];
  let watermark = 1;
  const events = new Map<number, DurableRunEvent>([[1, durableEvent(1)]]);
  const skillView = createSubmissionSkillViewService({
    runs: {
      get: async () => run,
      readWorkflowProfile: async () => profile,
      readPreparedResources: async () => bindings,
      readPreparedInputReceipts: async () => receipts,
    } as never,
    readCatalogSnapshot: async () => catalogSnapshot as never,
  });
  const service = new SessionPresentationService({
    sessions: { get: async () => ({ id: SESSION_ID }) as never },
    runs: { listBySession: async () => [run] },
    messageRecords: {
      listBySession: async () => [
        {
          messageId: user.id,
          runId: RUN_ID,
          sessionId: SESSION_ID,
          sequence: 1,
          conversationTurnId: user.conversationTurnId,
          messageType: "USER",
          schemaVersion: messageDraft.schemaVersion,
          modelProjectionVersion: messageDraft.modelProjectionVersion,
          sourceStepId: user.sourceStepId,
          createdAt: user.createdAt,
          source: user.source,
          audience: user.audience,
          data: messageDraft.data,
        } as never,
      ],
    },
    codecs,
    toolInvocations: { listByRun: async () => [invocation] },
    observations: { listByRun: async () => (observation === undefined ? [] : [observation]) },
    eventReader: {
      latestSequence: async () => watermark,
      replay: async (_runId, query) =>
        [...events.values()].filter((event) => {
          const sequence = event.durability.kind === "DURABLE" ? event.durability.sequence : 0;
          return sequence > query.afterSequence && sequence <= query.throughSequence;
        }),
    },
    toolPresentation: new CaelushToolPresentation({ terminalOutputSanitizer: (value) => value }),
    skillView,
  } as never);
  return {
    service,
    setReceipts(next: readonly PreparedInputResourceReceiptV1[]) {
      receipts = next;
      watermark += 1;
      events.set(watermark, durableEvent(watermark));
    },
    invocationId,
  };
}

function getV4(service: SessionPresentationService) {
  const getter = (service as unknown as {
    getSessionPresentationV4?: (
      sessionId: SessionId,
      query: unknown,
    ) => Promise<SessionTurnPresentationResponseV4>;
  }).getSessionPresentationV4;
  expect(getter).toBeTypeOf("function");
  return getter?.call(service, SESSION_ID, {});
}

describe("Skill V4 session presentation", () => {
  it("serves V4 from the daemon while preserving the strict V3 route", async () => {
    routeDirectory = await mkdtemp(join(tmpdir(), "caelush-skill-presentation-"));
    routeStorage = await openCaelushStorage({ path: join(routeDirectory, "caelush.db") });
    const app = buildDaemonApp({
      sessions: routeStorage.sessions,
      runs: routeStorage.runs,
      eventHub: { watch: async function* () {} } as never,
      config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
      info: {
        apiVersion: "v1",
        protocolVersion: 1,
        daemonVersion: "test",
        capabilities: {
          runExecution: true,
          runRecovery: true,
          cancellation: true,
          approvals: true,
          sseReplay: true,
          sessionTurnPresentation: true,
        },
        runtimeKinds: ["local"],
        configuredProviders: [],
        defaultRunConfiguration: {
          runtime: { id: "local", kind: "local" },
          permissionProfile: "READ_ONLY",
          approvalPolicy: "ALWAYS_ASK",
          limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 1_000 },
        },
      },
      presentation: new SessionPresentationService({
        sessions: routeStorage.sessions,
        runs: routeStorage.runs,
        messageRecords: routeStorage.messageRecords,
        codecs: createStandardAgentMessageCodecRegistry(
          projectionVersionTable({ USER: 1, ASSISTANT: 1, TOOL_RESULT: 1 }),
        ),
        toolInvocations: routeStorage.toolInvocations,
        observations: routeStorage.observations,
        eventReader: routeStorage.eventReader,
        toolPresentation: new CaelushToolPresentation({ terminalOutputSanitizer: (value) => value }),
      }),
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {},
    });
    const sessionId = created.json().id as string;
    const v4 = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/presentation-v4?limit=10`,
      headers: { host: "127.0.0.1" },
    });
    const v3 = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/presentation?limit=10`,
      headers: { host: "127.0.0.1" },
    });

    expect(v4.statusCode).toBe(200);
    expect(v4.json()).toEqual({ capabilityVersion: 4, turns: [] });
    expect(v3.statusCode).toBe(200);
    expect(v3.json()).toEqual({ capabilityVersion: 3, turns: [] });
    await app.close();
  });

  it("keeps a completed read_skill at CONTENT_READY until a matching Step receipt exists", async () => {
    const fixture = usageFixture({ invocationStatus: "COMPLETED", hasAutomaticBinding: true });
    const before = await getV4(fixture.service);
    expect(before).toBeDefined();
    const turn = before!.turns[0]!;
    const user = turn.items.find((item) => item.kind === "USER");
    expect(user).toMatchObject({
      selectedSkills: [{ skillId: manualSkillId, name: "review-helper", displayName: "Review helper" }],
    });
    expect(turn.items.filter((item) => item.kind === "SKILL")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: manualSkillId,
          name: "review-helper",
          skillStatus: "CONTENT_READY",
        }),
        expect.objectContaining({
          skillId: automaticSkillId,
          name: "change-analyzer",
          skillStatus: "CONTENT_READY",
        }),
      ]),
    );

    fixture.setReceipts([
      {
        runId: RUN_ID,
        stepId: STEP_ID,
        bindingId: "binding_model_analyzer",
        projectionFingerprint: HASH,
        rendererVersion: "workflow-resource@1",
      },
      {
        runId: RUN_ID,
        stepId: createStepId(),
        bindingId: "binding_model_analyzer",
        projectionFingerprint: HASH,
        rendererVersion: "workflow-resource@1",
      },
    ]);
    const after = await getV4(fixture.service);
    const skillItems = after!.turns[0]!.items.filter((item) => item.kind === "SKILL");
    expect(skillItems.filter((item) => item.skillId === automaticSkillId)).toHaveLength(1);
    expect(skillItems.find((item) => item.skillId === automaticSkillId)).toMatchObject({
      skillStatus: "LOADED",
    });
    expect(skillItems.find((item) => item.skillId === manualSkillId)).toMatchObject({
      skillStatus: "CONTENT_READY",
    });
    expect(JSON.stringify(after)).not.toContain("private skill body");
    expect(JSON.stringify(after)).not.toContain("private-automatic-bundle");
    expect(JSON.stringify(after)).not.toContain("D:\\\\private");

    const legacy = await fixture.service.getPresentation(SESSION_ID, {});
    expect(legacy.capabilityVersion).toBe(3);
    expect(legacy.turns[0]!.items.some((item) => item.kind === "SKILL")).toBe(false);
    expect(JSON.stringify(legacy)).not.toContain("private skill body");
  });

  it.each([
    ["RUNNING", "STREAMING", "READING"],
    ["FAILED", "FAILED", "FAILED"],
    ["CANCELLED", "CANCELLED", "FAILED"],
  ] as const)("projects %s read_skill as a safe %s state", async (invocationStatus, itemStatus, skillStatus) => {
    const fixture = usageFixture({
      invocationStatus,
      hasAutomaticBinding: false,
      ...(invocationStatus === "FAILED" ? { isError: true } : {}),
    });
    const response = await getV4(fixture.service);
    expect(response).toBeDefined();
    const item = response!.turns[0]!.items.find(
      (candidate) => candidate.kind === "SKILL" && candidate.skillId === automaticSkillId,
    );
    expect(item).toMatchObject({ kind: "SKILL", status: itemStatus, skillStatus });
    expect(JSON.stringify(response)).not.toContain("private skill body");
    expect(JSON.stringify(response)).not.toContain("D:\\\\private");
  });
});
