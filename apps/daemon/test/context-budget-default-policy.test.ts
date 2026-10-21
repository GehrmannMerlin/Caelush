import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

/**
 * The Context budget policy a new Run is frozen against.
 *
 * ```text
 * daemon default                     → WORKING_SET_V2
 * explicit LEGACY_FULL_OUTPUT_V1     → LEGACY_FULL_OUTPUT_V1
 * a Run created before the default   → whatever it was frozen with
 * ```
 *
 * The policy is resolved exactly once, at Run creation, and persisted on the Run. That is why a
 * historical Run must never change when the daemon's default changes, and why this test drives the
 * real HTTP create-run route instead of asserting on the resolver's return value directly: a test
 * that injects `WORKING_SET_V2` by hand proves the resolver can be called, not that production uses
 * it.
 */

let directory: string | undefined;
const daemons: { close(): Promise<void>; url: string }[] = [];

/** The wire is never reached: every case here stops at Run creation. */
class UnusedFixtureAdapter implements ApiAdapter {
  readonly id = FIXTURE_API;

  async *stream(_input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

interface BootedDaemon {
  readonly client: CaelushClient;
  readonly session: Awaited<ReturnType<CaelushClient["createSession"]>>;
}

async function boot(options: {
  readonly databasePath: string;
  readonly contextBudgetPolicyVersion?: "LEGACY_FULL_OUTPUT_V1" | "ADAPTIVE_V1" | "WORKING_SET_V2";
  readonly limits?: { readonly contextWindowTokens: number; readonly maxOutputTokens: number };
}): Promise<BootedDaemon> {
  const daemon = await startDaemon({
    databasePath: options.databasePath,
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [fixtureBinding()],
    modelSources: [fixtureModelSource(options.limits)],
    adapterOverrides: [new UnusedFixtureAdapter()],
    defaultModel: { provider: "fixture", model: "fixture-model" },
    ...(options.contextBudgetPolicyVersion === undefined
      ? {}
      : { contextBudgetPolicyVersion: options.contextBudgetPolicyVersion }),
  });
  daemons.push(daemon);
  const client = new CaelushClient({ baseUrl: daemon.url });
  const session = await client.createSession({
    defaultWorkspace: { id: createWorkspaceId(), path: directory! },
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  return { client, session };
}

async function closeDaemons(): Promise<void> {
  for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
}

async function createRun(
  client: CaelushClient,
  session: Awaited<ReturnType<typeof boot>>["session"],
) {
  const workspace = session.defaultWorkspace;
  if (workspace === undefined) throw new Error("test Workspace was not registered");
  return await client.createRun(session.id, {
    goal: "describe the workspace",
    workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    preset: { id: "FULL_ACCESS", expectedVersion: 1 },
    limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 10_000 },
  });
}

describe("Context budget policy default", () => {
  it("freezes a new Run against WORKING_SET_V2 when the daemon sets no version", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-context-budget-default-"));
    const { client, session } = await boot({ databasePath: join(directory, "caelush.db") });
    const run = await createRun(client, session);

    expect(run.contextBudgetPolicy).toEqual({
      version: "WORKING_SET_V2",
      // The output reserve algorithm is unchanged: V2 moves when history is reorganized, not how
      // much room the answer gets.
      requestBudget: { version: "LEGACY_FULL_OUTPUT_V1" },
      workingSet: {
        targetTokens: 96_000,
        triggerRatio: 0.75,
        postCompactionRatio: 0.5,
        allowCurrentTurnPrefix: true,
        cooldownTurns: 5,
      },
    });
  }, 20_000);

  it("keeps an explicit version selectable", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-context-budget-explicit-"));
    const legacy = await boot({
      databasePath: join(directory, "legacy.db"),
      contextBudgetPolicyVersion: "LEGACY_FULL_OUTPUT_V1",
    });
    expect((await createRun(legacy.client, legacy.session)).contextBudgetPolicy).toEqual({
      version: "LEGACY_FULL_OUTPUT_V1",
    });

    const workingSet = await boot({
      databasePath: join(directory, "working-set.db"),
      contextBudgetPolicyVersion: "WORKING_SET_V2",
    });
    expect((await createRun(workingSet.client, workingSet.session)).contextBudgetPolicy.version).toBe(
      "WORKING_SET_V2",
    );
  }, 30_000);

  it("never rewrites the policy a historical Run was frozen with", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-context-budget-history-"));
    const databasePath = join(directory, "caelush.db");
    const first = await boot({
      databasePath,
      contextBudgetPolicyVersion: "LEGACY_FULL_OUTPUT_V1",
    });
    const historical = await createRun(first.client, first.session);
    expect(historical.contextBudgetPolicy.version).toBe("LEGACY_FULL_OUTPUT_V1");
    await closeDaemons();

    // The same database, restarted with the new default.
    const restarted = await boot({ databasePath });
    const reread = await restarted.client.getRun(historical.id);
    expect(reread.contextBudgetPolicy.version).toBe("LEGACY_FULL_OUTPUT_V1");
    expect((await createRun(restarted.client, restarted.session)).contextBudgetPolicy.version).toBe(
      "WORKING_SET_V2",
    );
  }, 30_000);

  it("refuses to create a Run when the working set has no positive budget", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-context-budget-invalid-"));
    const { client, session } = await boot({
      databasePath: join(directory, "caelush.db"),
      // A model whose declared output reserve plus reserves exceeds its own window: the effective
      // input budget is not positive, so no working set can be defined for it.
      limits: { contextWindowTokens: 9_000, maxOutputTokens: 8_500 },
    });
    // The refusal is reported as a failed request, never as a Run the caller believes exists: the
    // Run row is written only after its frozen policy resolves.
    await expect(createRun(client, session)).rejects.toThrow();
    expect((await client.listRuns(session.id, { limit: 10 })).items).toEqual([]);
  }, 20_000);
});
