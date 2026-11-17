import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCodingTools } from "@caelush/coding-agent";
import { createRequestedToolInvocation, startToolInvocation } from "@caelush/agent";
import {
  createRunId,
  createTimestampMs,
  createToolInvocationId,
  type AgentRun,
} from "@caelush/protocol";
import { createInjectedReplayKeyProvider, createReplayProtection } from "@caelush/security";
import { openToolStorage } from "../../../packages/storage/test/support/tool-settlement-decoder.js";
import { makeRun, makeSession, makeStep } from "../../../packages/storage/test/support/fixtures.js";
import type { CaelushStorage } from "@caelush/storage";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

describe("durable Skill script recovery", () => {
  let directory: string | undefined;
  let storage: CaelushStorage | undefined;
  let composition: DaemonComposition | undefined;

  afterEach(async () => {
    await composition?.dispose().catch(() => undefined);
    await storage?.close().catch(() => undefined);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    composition = undefined;
    storage = undefined;
    directory = undefined;
  });

  it("keeps an interrupted RUNNING script invocation uncertain and never invokes it again", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-script-recovery-"));
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    storage = await openToolStorage({
      path: join(directory, "caelush.db"),
      replayProtection: createReplayProtection(
        createInjectedReplayKeyProvider("phase06-recovery-fixture-key", Buffer.alloc(32, 0x63)),
      ),
    });

    const workspaceResult = await new WorkspaceService({
      repository: storage.workspaces,
    }).registerWorkspace({
      path: workspaceRoot,
    });
    const workspace = {
      id: workspaceResult.workspace.id,
      path: workspaceResult.workspace.canonicalPath,
    };
    const session = makeSession({ workspaceId: workspace.id, defaultWorkspace: workspace });
    await storage.sessions.insert(session);

    const runScript = vi.fn(async () => ({ kind: "UNAVAILABLE" as const }));
    const toolRegistrations = createDefaultCodingTools({
      readFile: {} as never,
      readOnly: {} as never,
      patch: {} as never,
      exec: {} as never,
      process: {} as never,
      git: {} as never,
      skills: {
        async search() {
          return { items: [], inventoryComplete: true };
        },
        async read() {
          throw new Error("The interrupted call should never be dispatched.");
        },
        runScript,
      },
    });
    composition = await composeDaemon({
      storage,
      toolRegistrations,
      toolExposure: "AVAILABLE",
    });

    const runId = createRunId();
    const now = createTimestampMs(Date.now());
    const runDraft = makeRun(session.id, {
      id: runId,
      goal: "Recover an interrupted Skill script Tool call.",
      status: "RUNNING",
      startedAt: now,
      workspace,
      model: { provider: "deepseek", model: "deepseek-reasoner" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      completionContract: "NATURAL_V1",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 90_000 },
    });
    const run = {
      ...runDraft,
      contextBudgetPolicy: await composition.contextBudgetPolicyResolver.resolve(runDraft),
    };
    await storage.runs.insert(run);
    const step = makeStep(runId, {
      sequence: 1,
      status: "COMPLETED",
      startedAt: now,
      finishedAt: createTimestampMs(Number(now) + 1),
    });
    await storage.steps.insert(step);

    const call = {
      externalCallId: "phase06-script-interrupted-call",
      toolName: "run_skill_script" as const,
      args: {
        bindingId: "binding_from_frozen_run",
        resourcePath: "scripts/check.mjs",
        args: ["two words", "; echo must-remain-one-argument"],
        yieldTimeMs: 1_000,
      },
    };
    const invocation = createRequestedToolInvocation({
      id: createToolInvocationId(),
      runId,
      stepId: step.id,
      externalCallId: call.externalCallId,
      toolName: call.toolName,
      args: call.args,
      riskLevel: "CRITICAL",
      createdAt: now,
    });
    await storage.toolExecution.commit({
      sessionId: session.id,
      invocation,
      expectedRevision: null,
      events: [],
    });
    await storage.toolExecution.commit({
      sessionId: session.id,
      invocation: startToolInvocation(invocation, createTimestampMs(Number(now) + 2)),
      expectedRevision: 1,
      events: [],
    });

    const batchRequest = {
      runId,
      sessionId: session.id,
      sourceStepId: step.id,
      calls: [call],
      environment: { workspace, runtime: run.runtime },
      securityContext: securityContextFor(run),
      signal: new AbortController().signal,
    };
    const firstRecovery = await composition.toolTurn.batches.execute(batchRequest);
    const repeatedRecovery = await composition.toolTurn.batches.execute(batchRequest);

    expect(firstRecovery.kind).toBe("EFFECT_UNCONFIRMED");
    expect(repeatedRecovery.kind).toBe("EFFECT_UNCONFIRMED");
    expect(runScript).not.toHaveBeenCalled();
    await expect(storage.toolExecution.load(invocation.id)).resolves.toMatchObject({
      invocation: { status: "RUNNING" },
    });
    await expect(storage.runs.get(runId)).resolves.toMatchObject({ status: "RUNNING" });
  });
});

function securityContextFor(run: AgentRun) {
  const policy = run.securityPolicy;
  if (policy === undefined) throw new Error("The recovery Run lacks its durable security policy.");
  return {
    permissionProfile: run.permissionProfile,
    approvalPolicy: run.approvalPolicy,
    securityPolicy: {
      presetId: policy.preset.id,
      presetVersion: policy.preset.version,
      policyDigest: policy.policyDigest,
      filesystemBoundary: policy.filesystemBoundary,
      processBoundary: policy.processBoundary,
      requiredEnforcement: policy.requiredEnforcement,
    },
  };
}
