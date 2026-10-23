import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { createAIError } from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { createWorkspaceId, type PublicRunEvent } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  writeOpenAIChunk,
} from "./support/controllable-provider-server.js";
import type { ControllableProviderServer } from "./support/controllable-provider-server.js";
import {
  FIXTURE_API,
  answer,
  finish,
  fixtureBinding,
  fixtureModelSource,
  toolCall,
} from "./support/ai-fixture.js";

let directory: string | undefined;
const daemons: { close(): Promise<void>; url: string }[] = [];
let providerServer: ControllableProviderServer | undefined;

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
  await providerServer?.close().catch(() => undefined);
  providerServer = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

interface TurnObservation {
  readonly maxOutputTokens: number | undefined;
  readonly toolResultCount: number;
  readonly toolResultJson: readonly string[];
}

class RecoveryFixtureAdapter implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly turns: TurnObservation[] = [];

  constructor(
    private readonly script: (
      input: ApiAdapterStreamInput,
      turn: number,
    ) => Promise<readonly AIAdapterEvent[]> | readonly AIAdapterEvent[],
  ) {}

  async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    const turn = this.turns.length;
    const toolResults = input.request.messages.filter((message) => message.role === "tool");
    this.turns.push({
      maxOutputTokens: input.request.settings.maxOutputTokens,
      toolResultCount: toolResults.length,
      toolResultJson: toolResults.map((message) => JSON.stringify(message)),
    });
    yield* await this.script(input, turn);
  }
}

async function boot(options: {
  readonly adapter: ApiAdapter;
  readonly maxOutputTokens?: number;
}): Promise<{
  readonly client: CaelushClient;
  readonly session: Awaited<ReturnType<CaelushClient["createSession"]>>;
  readonly workspacePath: string;
}> {
  directory = await mkdtemp(join(tmpdir(), "caelush-output-recovery-r10-"));
  const daemon = await startDaemon({
    databasePath: join(directory, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [fixtureBinding()],
    modelSources: [
      fixtureModelSource({
        contextWindowTokens: 128_000,
        maxOutputTokens: options.maxOutputTokens ?? 32_768,
      }),
    ],
    adapterOverrides: [options.adapter],
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  daemons.push(daemon);
  const client = new CaelushClient({ baseUrl: daemon.url });
  const workspace = { id: createWorkspaceId(), path: directory };
  const session = await client.createSession({
    defaultWorkspace: workspace,
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  return { client, session, workspacePath: directory };
}

async function bootWithRequiredNativeReplay(provider: ControllableProviderServer): Promise<{
  readonly client: CaelushClient;
  readonly session: Awaited<ReturnType<CaelushClient["createSession"]>>;
  readonly workspacePath: string;
}> {
  directory = await mkdtemp(join(tmpdir(), "caelush-output-recovery-replay-r10-"));
  const daemon = await startDaemon({
    databasePath: join(directory, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providers: [
      {
        provider: "fixture",
        baseUrl: provider.endpoint,
        apiKey: "fixture-only",
        allowedModels: ["fixture-model"],
      },
    ],
    modelSources: [
      fixtureModelSource(
        { contextWindowTokens: 128_000, maxOutputTokens: 32_768 },
        { "openai-compatible": { requiresReasoningReplayWithTools: true } },
        "openai-compatible-chat",
      ),
    ],
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  daemons.push(daemon);
  const client = new CaelushClient({ baseUrl: daemon.url });
  const workspace = { id: createWorkspaceId(), path: directory };
  const session = await client.createSession({
    defaultWorkspace: workspace,
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  return { client, session, workspacePath: directory };
}

async function createRun(
  client: CaelushClient,
  session: Awaited<ReturnType<CaelushClient["createSession"]>>,
) {
  const workspace = session.defaultWorkspace;
  if (workspace === undefined) throw new Error("test Workspace was not registered");
  return await client.createRun(session.id, {
    goal: "create and verify a small source file",
    workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    preset: { id: "FULL_ACCESS", expectedVersion: 1 },
    limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 30_000 },
  });
}

async function waitForTerminal(
  client: CaelushClient,
  runId: Parameters<CaelushClient["getRun"]>[0],
) {
  let run = await client.getRun(runId);
  for (let attempt = 0; attempt < 400 && !isTerminal(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    run = await client.getRun(runId);
  }
  return run;
}

async function collectEventsThroughTerminal(
  client: CaelushClient,
  runId: Parameters<CaelushClient["getRun"]>[0],
): Promise<PublicRunEvent[]> {
  const events: PublicRunEvent[] = [];
  for await (const event of client.watchRunEvents(runId)) {
    events.push(event);
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled" ||
      event.type === "run.timed_out"
    ) {
      return events;
    }
  }
  return events;
}

function isTerminal(status: string): boolean {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}

function recoverySchedules(events: readonly PublicRunEvent[]) {
  return events.filter((event) => event.type === "retry.scheduled" && event.schemaVersion === 2);
}

function truncationOnly(): readonly AIAdapterEvent[] {
  return [
    // A provider emitted hidden reasoning activity. The public adapter contract deliberately
    // carries no reasoning bytes, and LENGTH means this turn is not an assistant answer.
    { type: "provider.activity" },
    finish("LENGTH", { inputTokens: 64, outputTokens: 8_192 }),
  ];
}

describe("new Run model output recovery", () => {
  it("raises output once after a reasoning-only LENGTH, then writes, checks, and completes naturally", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: recovered.ts",
      "+export const answer = 42",
      "*** End Patch",
    ].join("\n");
    const check =
      "node -e \"const fs = require('node:fs'); if (fs.readFileSync('recovered.ts', 'utf8') !== 'export const answer = 42\\n') process.exitCode = 1\"";
    const adapter = new RecoveryFixtureAdapter((_input, turn) => {
      switch (turn) {
        case 0:
          return [
            ...toolCall("call_probe", "read_file", { path: "README.md" }),
            finish("TOOL_CALLS"),
          ];
        case 1:
          return truncationOnly();
        case 2:
          return [...toolCall("call_patch", "apply_patch", { patch }), finish("TOOL_CALLS")];
        case 3:
          return [...toolCall("call_check", "exec_command", { cmd: check }), finish("TOOL_CALLS")];
        case 4:
          return answer("The source file was created and the check passed.");
        default:
          throw new Error(`unexpected Provider turn ${turn}`);
      }
    });
    const { client, session, workspacePath } = await boot({ adapter });
    await writeFile(join(workspacePath, "README.md"), "probe source\n", "utf8");
    const run = await createRun(client, session);
    expect(run.contextBudgetPolicy).toMatchObject({
      version: "TURN_BUDGET_V3",
      outputRecovery: {
        version: "OUTPUT_RECOVERY_V1",
        maxRecoveryTurns: 1,
        outputMultiplier: 2,
      },
    });

    const eventsPromise = collectEventsThroughTerminal(client, run.id);
    await client.startRun(run.id);
    const settled = await waitForTerminal(client, run.id);
    const events = await eventsPromise;

    expect(settled.status).toBe("COMPLETED");
    expect(settled.finalResult).toMatchObject({
      type: "NORMAL_COMPLETION",
      text: "The source file was created and the check passed.",
    });
    expect(existsSync(join(workspacePath, "recovered.ts"))).toBe(true);
    expect(await readFile(join(workspacePath, "recovered.ts"), "utf8")).toBe(
      "export const answer = 42\n",
    );
    expect(adapter.turns.map((turn) => turn.maxOutputTokens)).toEqual([
      16_384, 16_384, 32_768, 16_384, 16_384,
    ]);
    expect(adapter.turns.map((turn) => turn.toolResultCount)).toEqual([0, 1, 1, 2, 3]);
    expect(adapter.turns[4]?.toolResultJson.join("\n")).toContain("exit code 0");
    expect(recoverySchedules(events)).toHaveLength(1);
    expect(recoverySchedules(events)[0]).toMatchObject({
      schemaVersion: 2,
      type: "retry.scheduled",
      payload: {
        attempt: 2,
        maxAttempts: 2,
        errorCode: "LLM_OUTPUT_TRUNCATED",
      },
    });
  }, 40_000);

  it("stops at the model output ceiling without fabricating a budget failure or scheduling recovery", async () => {
    const adapter = new RecoveryFixtureAdapter((_input, turn) => {
      if (turn === 0) return truncationOnly();
      throw new Error(`unexpected Provider turn ${turn}`);
    });
    const { client, session } = await boot({ adapter, maxOutputTokens: 8_192 });
    const run = await createRun(client, session);
    const eventsPromise = collectEventsThroughTerminal(client, run.id);

    await client.startRun(run.id);
    const settled = await waitForTerminal(client, run.id);
    const events = await eventsPromise;

    expect(settled.status).toBe("FAILED");
    expect(settled.status).not.toBe("BUDGET_EXCEEDED");
    expect(adapter.turns.map((turn) => turn.maxOutputTokens)).toEqual([8_192]);
    expect(recoverySchedules(events)).toHaveLength(0);
  }, 30_000);

  it("does not loop after a second LENGTH and cannot revive the FAILED Run", async () => {
    const adapter = new RecoveryFixtureAdapter((_input, turn) => {
      if (turn === 0 || turn === 1) return truncationOnly();
      throw new Error(`unexpected Provider turn ${turn}`);
    });
    const { client, session } = await boot({ adapter });
    const run = await createRun(client, session);
    const eventsPromise = collectEventsThroughTerminal(client, run.id);

    await client.startRun(run.id);
    const settled = await waitForTerminal(client, run.id);
    const events = await eventsPromise;

    expect(settled.status).toBe("FAILED");
    expect(adapter.turns.map((turn) => turn.maxOutputTokens)).toEqual([16_384, 32_768]);
    expect(recoverySchedules(events)).toHaveLength(1);
    await client.recoverRun(run.id).catch(() => undefined);
    expect((await client.getRun(run.id)).status).toBe("FAILED");
    expect(adapter.turns).toHaveLength(2);
  }, 30_000);

  it("keeps cancellation authoritative while the single recovery Provider turn is open", async () => {
    let enterRecovery: (() => void) | undefined;
    const recoveryEntered = new Promise<void>((resolve) => {
      enterRecovery = resolve;
    });
    const adapter = new RecoveryFixtureAdapter(async (input, turn) => {
      if (turn === 0) return truncationOnly();
      if (turn !== 1) throw new Error(`unexpected Provider turn ${turn}`);
      enterRecovery?.();
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return [];
    });
    const { client, session } = await boot({ adapter });
    const run = await createRun(client, session);
    const eventsPromise = collectEventsThroughTerminal(client, run.id);

    await client.startRun(run.id);
    await recoveryEntered;
    await client.cancelRun(run.id);
    const settled = await waitForTerminal(client, run.id);
    const events = await eventsPromise;

    expect(settled.status).toBe("CANCELLED");
    expect(adapter.turns).toHaveLength(2);
    expect(recoverySchedules(events)).toHaveLength(1);
  }, 30_000);

  it("does not enter ordinary retry when the recovery Provider turn fails on the network", async () => {
    const adapter = new RecoveryFixtureAdapter((_input, turn) => {
      if (turn === 0) return truncationOnly();
      if (turn === 1) throw createAIError("AI_NETWORK");
      throw new Error(`unexpected Provider turn ${turn}`);
    });
    const { client, session } = await boot({ adapter });
    const run = await createRun(client, session);
    const eventsPromise = collectEventsThroughTerminal(client, run.id);

    await client.startRun(run.id);
    const settled = await waitForTerminal(client, run.id);
    const events = await eventsPromise;

    expect(settled.status).toBe("FAILED");
    expect(adapter.turns).toHaveLength(2);
    expect(recoverySchedules(events)).toHaveLength(1);
  }, 30_000);

  it("does not treat missing required private Provider replay as output truncation", async () => {
    providerServer = await createControllableProviderServer(async (_request, response) => {
      beginOpenAISse(response);
      writeOpenAIChunk(response, {
        model: "fixture-model",
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_replay_probe",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"README.md"}' },
            },
          ],
        },
      });
      writeOpenAIChunk(response, {
        model: "fixture-model",
        delta: {},
        finishReason: "tool_calls",
      });
      response.end("data: [DONE]\n\n");
    });
    const { client, session, workspacePath } = await bootWithRequiredNativeReplay(providerServer);
    await writeFile(join(workspacePath, "README.md"), "private replay probe\n", "utf8");
    const run = await createRun(client, session);
    expect(run.contextBudgetPolicy).toMatchObject({
      version: "TURN_BUDGET_V3",
      outputRecovery: { version: "OUTPUT_RECOVERY_V1" },
    });
    const eventsPromise = collectEventsThroughTerminal(client, run.id);

    await client.startRun(run.id);
    const settled = await waitForTerminal(client, run.id);
    const events = await eventsPromise;

    expect(settled.status).toBe("FAILED");
    expect(providerServer.requests).toHaveLength(1);
    expect(recoverySchedules(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === "retry.scheduled")).toHaveLength(0);
  }, 30_000);
});
