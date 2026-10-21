import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentAssistantToolCallPart,
  createAgentConversationSnapshot,
  createContextContributionPipeline,
  createConversationTurn,
  createStandardAgentMessageProjectorRegistry,
  type PromptSurfaceEpoch,
  type PromptSurfaceRecord,
  type PromptSurfaceSectionState,
  type StoredAgentMessage,
} from "@caelush/agent";
import type { ModelDescriptor } from "@caelush/ai";
import type { RunAgentContextEngineInput } from "@caelush/core";
import {
  AgentRunSchema,
  AgentSessionSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  normalizeCreateRunResourcePolicy,
} from "@caelush/protocol";
import { LocalRuntime } from "@caelush/runtime";
import { expandPermissionPreset } from "@caelush/security";
import { openCaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonV2ContextEngine } from "../src/context/v2-context-composition.js";
import {
  factory,
  modelMessageSource,
  stored,
  toolResultMessage,
  turnIdFor,
  userMessage,
} from "../../../packages/agent/test/messages/fixtures.js";

/**
 * What a hundred accepted Tool results cost the Prompt Surface.
 *
 * ```text
 * stable plan body      the same bytes on every Step, or the whole body is rewritten for a counter
 * churn                 confined to the 512-byte bookkeeping Section, never the 6 KiB plan
 * replay                bounded: past the soft budget the epoch rolls over to a smaller baseline
 * durable messages      untouched — a projection reads history, it does not rewrite it
 * restart               same Sections, same projection, no duplicate checkpoint or record
 * ```
 *
 * The numbers here come from the real daemon composition on real SQLite: the plan provider, the work
 * commentary provider, the authority sections and the engine's own Surface store. A unit test of the
 * renderer cannot show that a Step rewrites one Section instead of three, because that depends on
 * which items the composition publishes and on how the engine diffs them.
 */

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "surface-churn" },
  api: "fixture-api",
  limits: { contextWindowTokens: 200_000, maxOutputTokens: 4_000 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "SUPPORTED",
    structuredOutput: "UNKNOWN",
    vision: "UNSUPPORTED",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

/** A plan big enough that rewriting its body would be a real cost, not a rounding error. */
const PLAN_INPUT = Object.freeze({
  planVersion: 2,
  explanation: "the endpoint rejects empty patches",
  plan: Array.from({ length: 12 }, (_unused, index) => ({
    id: `step_${String(index)}`,
    step: `Repair module ${String(index)} of the importer and verify the round trip`,
    status: index === 0 ? ("in_progress" as const) : ("pending" as const),
    acceptance: [`module ${String(index)} round-trips through the validator`],
    evidenceRefs: [`verification:module-${String(index)}`],
  })),
  execution: {
    constraints: ["do not change the public request schema"],
    unresolved: ["the validator rejects an empty patch"],
    nextAction: "inspect the validator before changing the importer",
  },
});

let directory: string | undefined;
let storage: Awaited<ReturnType<typeof openCaelushStorage>> | undefined;
let runtime: LocalRuntime | undefined;

afterEach(async () => {
  await runtime?.dispose();
  await storage?.close();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  runtime = undefined;
  storage = undefined;
  directory = undefined;
});

interface Harness {
  readonly runId: ReturnType<typeof createRunId>;
  readonly sessionId: string;
  readonly prepare: (
    messages: readonly StoredAgentMessage[],
    stepSequence: number,
  ) => Promise<{
    readonly messages: readonly { readonly content: string }[];
    readonly report: {
      readonly estimatedInputTokens: number;
      readonly compactionCount: number;
      readonly preflight?: {
        readonly replayTokens: number;
        readonly projectionFingerprint: string;
        readonly sentFingerprint: string;
        readonly compacted: boolean;
        readonly matchesSentProjection?: boolean;
      };
    };
  }>;
}

/**
 * Open the production Context Engine for one Run.
 *
 * `targetTokens` is the only knob: it decides the replay soft budget
 * (`min(24000, floor(target × 0.25))` tokens), which is what makes the difference between "a hundred
 * Steps fit" and "a hundred Steps must roll over".
 */
async function openHarness(options: { readonly targetTokens: number }): Promise<Harness> {
  directory = await mkdtemp(join(tmpdir(), "caelush-surface-churn-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  runtime = new LocalRuntime({
    discovery: {
      async find() {
        return { files: [], truncated: false };
      },
    },
  });
  const session = AgentSessionSchema.parse({
    id: createSessionId(),
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(1),
    metadata: {},
  });
  const resourcePolicy = normalizeCreateRunResourcePolicy({
    limits: { maxSteps: 400, maxToolCalls: 400, timeoutMs: 600_000 },
  });
  const run = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: session.id,
    goal: "Keep a long Run's plan stable while a hundred accepted Tool results arrive.",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: directory },
    model: MODEL.ref,
    runtime: { id: "local", kind: "local" },
    permissionProfile: "FULL_ACCESS",
    approvalPolicy: "ON_BOUNDARY",
    securityPolicy: expandPermissionPreset({
      presetId: "FULL_ACCESS",
      expectedVersion: 1,
      createdAt: new Date(1).toISOString(),
    }),
    resourcePolicy,
    contextBudgetPolicy: {
      version: "WORKING_SET_V2",
      requestBudget: { version: "LEGACY_FULL_OUTPUT_V1" },
      workingSet: {
        targetTokens: options.targetTokens,
        triggerRatio: 0.75,
        postCompactionRatio: 0.5,
        allowCurrentTurnPrefix: true,
        cooldownTurns: 5,
      },
    },
    limits: { maxSteps: 400, maxToolCalls: 400, timeoutMs: 600_000 },
    createdAt: createTimestampMs(1),
  });
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  const turnId = turnIdFor(String(run.id));

  return {
    runId: run.id,
    sessionId: String(session.id),
    async prepare(messages, stepSequence) {
      const live = storage;
      const liveRuntime = runtime;
      if (live === undefined || liveRuntime === undefined) {
        throw new Error("The harness was closed before the Step was prepared.");
      }
      const turn = createConversationTurn({
        id: turnId,
        sessionId: session.id,
        runId: run.id,
        status: "OPEN",
        openedAt: run.createdAt,
        messages: [...messages],
      });
      const conversation = createAgentConversationSnapshot({
        sessionId: session.id,
        currentRunId: run.id,
        currentTurnId: turn.id,
        turns: [turn],
      });
      const engine = createDaemonV2ContextEngine({
        input: {
          run,
          identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
          cwd: directory!,
          baseSystemPrompt: "Execute the goal and keep the accepted plan.",
          runMode: "EXECUTE",
        } as RunAgentContextEngineInput,
        storage: live,
        promptSurfaceStore: live.promptSurface,
        runtime: liveRuntime,
        gateway: {
          async complete() {
            throw new Error("This Run never asks for a summary.");
          },
        } as never,
        messageProjectors: createStandardAgentMessageProjectorRegistry(),
        notifier: { notifyCommitted: () => undefined },
        contributionPipeline: createContextContributionPipeline(),
        clock: { now: () => createTimestampMs(10_000) },
        activeToolNames: [],
      });
      return (await engine.prepare({
        identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
        turn: { stepId: createStepId(), sequence: stepSequence },
        conversation,
        input: { kind: "CONTINUATION", reason: "TOOL_RESULT" },
        model: MODEL,
        tools: [],
        mode: "NORMAL",
        signal: new AbortController().signal,
      })) as never;
    },
  };
}

interface SurfaceView {
  readonly epoch: PromptSurfaceEpoch;
  readonly records: readonly PromptSurfaceRecord[];
  readonly sectionStates: readonly PromptSurfaceSectionState[];
}

async function readSurface(runId: Harness["runId"]): Promise<SurfaceView> {
  const live = storage;
  if (live === undefined) throw new Error("The harness is closed.");
  const epoch = await live.promptSurface.getCurrent(runId);
  if (epoch === undefined) throw new Error("The Run has no Prompt Surface epoch.");
  const complete = await live.promptSurface.readEpoch(runId, epoch.epochId);
  if (complete === undefined || complete.records === undefined) {
    throw new Error("The Prompt Surface epoch has no V3 records.");
  }
  return {
    epoch,
    records: complete.records,
    sectionStates: complete.sectionStates ?? [],
  };
}

function stateLabeled(
  states: readonly PromptSurfaceSectionState[],
  label: string,
): PromptSurfaceSectionState {
  const state = states.find((candidate) => candidate.content.includes(`label="${label}"`));
  if (state === undefined) throw new Error(`The Surface has no Section labelled "${label}".`);
  return state;
}

/** The conversation a Run has after `accepted` Tool results following its accepted plan. */
function conversationAfter(
  accepted: number,
  turnId: ReturnType<typeof turnIdFor>,
  scope: { readonly runId: string; readonly sessionId: string },
): StoredAgentMessage[] {
  /*
   * One scripted factory per conversation, handed to every message.
   *
   * Two factories would mint the same scripted ids and the conversation would contain the same
   * message id twice. One deterministic factory means Step N's messages are Step N+1's prefix, byte
   * for byte — which is what makes "append one Tool result" a real increment rather than a rewrite.
   */
  const messageFactory = factory(4_096);
  const planCallId = "call_update_plan";
  const messages: StoredAgentMessage[] = [
    userMessage({
      messageFactory,
      runId: scope.runId,
      sessionId: scope.sessionId,
      turnId,
      sequence: 1,
      text: "Fix the importer, keep the public request schema, and tell me what is verified.",
    }),
    stored(
      messageFactory.createAssistant({
        runId: scope.runId as never,
        sessionId: scope.sessionId as never,
        conversationTurnId: turnId,
        source: modelMessageSource("llm_plan"),
        phase: "COMMENTARY",
        content: [
          agentAssistantToolCallPart({
            toolCallId: planCallId,
            toolName: "update_plan",
            input: PLAN_INPUT,
          }),
        ],
        model: {
          kind: "MODEL_TURN",
          callId: "llm_plan",
          model: MODEL.ref,
          finishReason: "TOOL_CALLS",
        },
      }),
      2,
    ),
    toolResultMessage({
      messageFactory,
      runId: scope.runId,
      sessionId: scope.sessionId,
      turnId,
      sequence: 3,
      toolCallId: planCallId,
      toolName: "update_plan",
      projectedContent: "plan accepted",
    }),
  ];
  for (let index = 0; index < accepted; index += 1) {
    const callId = `call_work_${String(index)}`;
    messages.push(
      stored(
        messageFactory.createAssistant({
          runId: scope.runId as never,
          sessionId: scope.sessionId as never,
          conversationTurnId: turnId,
          source: modelMessageSource(`llm_work_${String(index)}`),
          phase: "COMMENTARY",
          content: [
            agentAssistantToolCallPart({
              toolCallId: callId,
              toolName: "read_file",
              input: { path: `src/module-${String(index)}.ts` },
            }),
          ],
          model: {
            kind: "MODEL_TURN",
            callId: `llm_work_${String(index)}`,
            model: MODEL.ref,
            finishReason: "TOOL_CALLS",
          },
        }),
        4 + index * 2,
      ),
      toolResultMessage({
        messageFactory,
        runId: scope.runId,
        sessionId: scope.sessionId,
        turnId,
        sequence: 5 + index * 2,
        toolCallId: callId,
        toolName: "read_file",
        projectedContent: `module ${String(index)} read`,
      }),
    );
  }
  return messages;
}

describe("Prompt Surface churn from dynamic Sections", () => {
  /**
   * A hundred accepted Tool results, and what each one costs the request.
   *
   * Every Step adds one accepted Tool result, so the bookkeeping Section changes on every Step and
   * nothing else about the plan does. Before the plan was split, the accepted-result count sat in the
   * same 8 KiB item as the milestones, so every Step rewrote the whole plan; the assertions below are
   * that the stable body's hash never moves and that the per-Step churn stays inside the 512-byte
   * bookkeeping Section.
   *
   * A hundred Steps still exceed one epoch's replay budget — one Step costs about 1 KiB, and the cap
   * is 24 000 tokens — so a rollover is allowed, and only a rollover may re-state the whole view.
   */
  it("keeps the accepted plan byte-identical across a hundred accepted Tool results", async () => {
    const harness = await openHarness({ targetTokens: 96_000 });
    const turnId = turnIdFor(String(harness.runId));
    const scope = { runId: String(harness.runId), sessionId: harness.sessionId };
    const messages = conversationAfter(0, turnId, scope);
    const durable = structuredClone(messages);

    const first = await harness.prepare(messages, 1);
    const firstSurface = await readSurface(harness.runId);
    const firstCurrent = stateLabeled(firstSurface.sectionStates, "current plan");
    const firstEpoch = firstSurface.epoch;
    expect(Buffer.byteLength(firstCurrent.content, "utf8")).toBeGreaterThan(2_000);

    const epochs = new Set([firstEpoch.epochId]);
    let previousReplay = first.report.preflight?.replayTokens ?? 0;
    let deltas = 0;
    let rollovers = 0;
    for (let step = 2; step <= 101; step += 1) {
      const next = conversationAfter(step - 1, turnId, scope);
      const prepared = await harness.prepare(next, step);
      const surface = await readSurface(harness.runId);
      epochs.add(surface.epoch.epochId);
      const preflight = prepared.report.preflight;
      expect(preflight?.compacted).toBe(false);
      expect(preflight?.matchesSentProjection).toBe(true);

      // 1. The stable plan body is the same bytes on every Step, rollover or not.
      expect(stateLabeled(surface.sectionStates, "current plan").contentHash).toBe(
        firstCurrent.contentHash,
      );
      // 2. The cache-prefix identity holds: the same model, tools and stable head throughout.
      expect(surface.epoch.stableHeadFingerprint).toBe(firstEpoch.stableHeadFingerprint);

      // 3. A Step's churn is one Section, and it is the 512-byte bookkeeping one. A rollover is the
      //    only record allowed to restate the complete view.
      const decision = surface.records.at(-1);
      if (decision?.kind === "BASELINE") {
        rollovers += 1;
        expect(surface.epoch.resetReason).toBe("CAPACITY_ROLLOVER");
        expect(decision.updates.length).toBeGreaterThan(1);
      } else {
        deltas += 1;
        expect(decision?.kind).toBe("DELTA");
        expect(decision?.updates.length ?? 0).toBe(1);
        for (const update of decision?.updates ?? []) {
          expect(update.op).toBe("SET");
          if (update.op !== "SET") continue;
          expect(update.content).toContain('label="plan bookkeeping"');
          expect(Buffer.byteLength(update.content, "utf8")).toBeLessThanOrEqual(600);
        }
        expect(preflight?.replayTokens ?? 0).toBeGreaterThan(previousReplay);
      }
      // 4. The replay budget is enforced: a Step never reports more than the 24 000-token cap.
      expect(preflight?.replayTokens ?? 0).toBeLessThanOrEqual(24_000);
      previousReplay = preflight?.replayTokens ?? 0;
    }

    const settled = await readSurface(harness.runId);
    // Every Step produced one decision, and a hundred Steps needed at most a couple of rollovers.
    expect(deltas + rollovers).toBe(100);
    expect(rollovers).toBeLessThanOrEqual(2);
    // A hundred accepted results are counted, once, in the small Section.
    expect(stateLabeled(settled.sectionStates, "plan bookkeeping").content).toContain(
      "accepted Tool results since plan: 100",
    );
    // ...and they did not touch the plan, the evidence, or the conversation they came from.
    expect(stateLabeled(settled.sectionStates, "current plan").contentHash).toBe(
      firstCurrent.contentHash,
    );
    // A reference the plan cites and the host cannot resolve is printed as UNKNOWN, not dropped:
    // "unchecked" and "checked and failed" are different facts about the same step.
    expect(stateLabeled(settled.sectionStates, "plan evidence").content).toContain(
      "verification:module-0 [UNKNOWN]",
    );
    expect(messages).toEqual(durable);
    // A rollover opens a new epoch and leaves the one it replaced readable, not rewritten.
    if (settled.epoch.epochId !== firstEpoch.epochId) {
      const replaced = await storage!.promptSurface.readEpoch(harness.runId, firstEpoch.epochId);
      expect(replaced?.formatVersion).toBe(3);
      expect(replaced?.records?.[0]?.kind).toBe("BASELINE");
      expect(replaced?.records?.[0]?.contentHash).toBe(firstSurface.records[0]?.contentHash);
    }
  }, 180_000);

  /**
   * The bounded case when the budget is small: replay must not grow without a ceiling.
   *
   * A Prompt Surface that only ever grows turns a long Run's request into a replay of every Step's
   * decision. The soft budget caps it by re-baselining the epoch, and the new baseline has to be
   * *smaller* than what it replaced — otherwise the rollover is a cost with no benefit, and the
   * decision declines to take it.
   */
  it("rolls over to a smaller baseline instead of replaying an unbounded delta chain", async () => {
    const harness = await openHarness({ targetTokens: 24_000 });
    // min(24 000, floor(24 000 × 0.25)) = 6 000 tokens, comfortably above the epoch's opening
    // baseline: a rollover is only worth taking when the replacement is smaller than what it replaces.
    const softBudgetTokens = 6_000;
    const turnId = turnIdFor(String(harness.runId));
    const scope = { runId: String(harness.runId), sessionId: harness.sessionId };

    const epochs: string[] = [];
    const replay: number[] = [];
    let currentHash: string | undefined;
    for (let step = 1; step <= 30; step += 1) {
      const prepared = await harness.prepare(conversationAfter(step, turnId, scope), step);
      const surface = await readSurface(harness.runId);
      const hash = stateLabeled(surface.sectionStates, "current plan").contentHash;
      currentHash ??= hash;
      // The plan does not move across a rollover either: a re-baselined epoch re-sends the same body.
      expect(hash).toBe(currentHash);

      const tokens = prepared.report.preflight?.replayTokens ?? 0;
      replay.push(tokens);
      epochs.push(surface.epoch.epochId);
      // One Step may cross the budget; it may not cross it by more than one Step's growth.
      expect(tokens).toBeLessThanOrEqual(softBudgetTokens + 200);
      expect(prepared.report.preflight?.compacted).toBe(false);
      expect(prepared.report.preflight?.matchesSentProjection).toBe(true);
    }

    const settled = await readSurface(harness.runId);
    const rolledOver = [...new Set(epochs)];
    expect(rolledOver.length).toBeGreaterThan(1);
    expect(settled.epoch.resetReason).toBe("CAPACITY_ROLLOVER");
    let rollovers = 0;
    for (let index = 1; index < replay.length; index += 1) {
      if (epochs[index] === epochs[index - 1]) continue;
      rollovers += 1;
      // The new baseline is smaller than the replay it replaced, and no larger than the baseline its
      // first epoch opened with: a rollover that keeps the same cost is a cost with no benefit.
      expect(replay[index]!).toBeLessThan(replay[index - 1]!);
      expect(replay[index]!).toBeLessThanOrEqual(replay[0]! + 200);
    }
    expect(rollovers).toBeGreaterThanOrEqual(1);
    // A rollover re-baselines; it does not replay the whole history it replaced.
    expect(replay.at(-1)!).toBeLessThan(softBudgetTokens);
  }, 180_000);

  /** A restart replays the same projection: same Sections, same request, one new decision. */
  it("replays the same projection after a restart", async () => {
    const harness = await openHarness({ targetTokens: 96_000 });
    const turnId = turnIdFor(String(harness.runId));
    const scope = { runId: String(harness.runId), sessionId: harness.sessionId };
    const messages = conversationAfter(6, turnId, scope);

    const before = await harness.prepare(messages, 1);
    const beforeSurface = await readSurface(harness.runId);
    expect(before.report.preflight?.matchesSentProjection).toBe(true);

    const databasePath = join(directory!, "caelush.db");
    await storage!.close();
    storage = await openCaelushStorage({ path: databasePath });

    const after = await harness.prepare(messages, 2);
    const afterSurface = await readSurface(harness.runId);

    // The same Sections, byte for byte: nothing about the projection depended on process state.
    expect(afterSurface.sectionStates).toEqual(beforeSurface.sectionStates);
    expect(afterSurface.epoch.epochId).toBe(beforeSurface.epoch.epochId);
    // Nothing changed, so the Step is a NOOP record — not a second baseline, not a duplicate.
    expect(afterSurface.records).toHaveLength(2);
    expect(afterSurface.records[1]?.kind).toBe("NOOP");
    expect(afterSurface.records[1]?.updates).toEqual([]);
    // ...and the request the recovered daemon would send is the one it sent before.
    expect(after.report.preflight?.sentFingerprint).toBe(before.report.preflight?.sentFingerprint);
    expect(after.report.preflight?.replayTokens).toBe(before.report.preflight?.replayTokens);
    expect(after.messages.map((message) => message.content)).toEqual(
      before.messages.map((message) => message.content),
    );
  }, 120_000);
});
