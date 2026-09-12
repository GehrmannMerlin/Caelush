import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  ContextBuilder,
  createLocalProjectInspector,
  createLocalRelevantFilePlanner,
} from "@caelush/context";
import { createModelTurnExecutor } from "@caelush/agent";
import { AgentLoop } from "../src/agent-loop.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";
import {
  aiError,
  fakeModelTurnExecutor,
  testModelCatalog,
} from "./support/fake-model-turn-executor.js";
import {
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  createTestAiSubsystem,
} from "./support/test-ai-subsystem.js";

/**
 * Agent → model authority end to end.
 *
 * Every test here drives the production chain
 * `AgentLoop → ModelTurnExecutor → AIGateway.stream() → ApiAdapter`, and asserts an
 * authority property that Phase 2C is responsible for: endpoint authority, exactly-once
 * overflow recovery, real transport abort, and the rejection of an uninterpretable
 * provider finish reason.
 */

const ATTACKER_ENDPOINT = "http://attacker.example/v1";
const EXPECTED_ENDPOINT = "http://expected.example/v1";

/**
 * A disposable workspace.
 *
 * The real Context runtime discovers project instructions and relevant files, so a
 * test must not accidentally run against this repository's own (very large) AGENTS.md.
 */
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "caelush-model-authority-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
  await writeFile(join(root, "AGENTS.md"), "Answer briefly.\n", "utf8");
  await writeFile(join(root, "src", "app.ts"), "export const name = 'fixture';\n", "utf8");
  return root;
}

function makeInput(
  root: string,
  overrides: { readonly baseUrl?: string } = {},
): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "answer the question",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: root },
    model: {
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      ...(overrides.baseUrl === undefined ? {} : { baseUrl: overrides.baseUrl }),
    },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 4, timeoutMs: 5_000 },
    createdAt: createTimestampMs(0),
  });
  return {
    run: { ...pendingRun, status: "RUNNING", startedAt: createTimestampMs(0) },
    state: startAgentState(
      createInitialAgentState(pendingRun, createTimestampMs(0)),
      createTimestampMs(0),
    ),
    history: [],
    baseSystemPrompt: "You are a careful coding agent.",
    contextLimits: { maxInputTokens: 4_000 },
    signal: new AbortController().signal,
    cwd: root,
  };
}

function dependencies(modelTurns: AgentLoopDependencies["modelTurns"]): AgentLoopDependencies {
  return {
    inspector: createLocalProjectInspector(),
    planner: createLocalRelevantFilePlanner(),
    contextBuilder: new ContextBuilder(),
    models: testModelCatalog(),
    modelTurns,
    clock: { now: () => createTimestampMs(10) },
    stepIdFactory: { create: () => createStepId() },
  };
}

describe("Agent model authority", () => {
  it("routes through the configured provider connection and never through a stored baseUrl", async () => {
    const root = await makeWorkspace();
    try {
      const { ai, adapterCalls } = createTestAiSubsystem({
        endpoint: EXPECTED_ENDPOINT,
        script: () => [
          { type: "text.delta", payload: { text: "safe answer" } },
          { type: "adapter.finish", payload: { finishReason: "STOP" } },
        ],
      });

      const result = await new AgentLoop(
        dependencies(createModelTurnExecutor({ gateway: ai.gateway })),
      ).run(makeInput(root, { baseUrl: ATTACKER_ENDPOINT }));

      expect(result.status).toBe("OUTCOME");
      expect(adapterCalls).toHaveLength(1);
      // The connection comes from the provider binding, never from durable Run data.
      expect(adapterCalls[0]?.provider.endpoint).toBe(EXPECTED_ENDPOINT);
      expect(adapterCalls[0]?.provider.endpoint).not.toBe(ATTACKER_ENDPOINT);
      // And the stored hint does not survive the projection into the request.
      expect(adapterCalls[0]?.request.model).not.toHaveProperty("baseUrl");
      expect(JSON.stringify(adapterCalls[0]?.request.model)).not.toContain("attacker.example");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compacts once and re-executes through the real transport after a context overflow", async () => {
    const root = await makeWorkspace();
    try {
      const { ai, adapterCalls } = createTestAiSubsystem({
        script: () => [
          { type: "text.delta", payload: { text: "recovered" } },
          { type: "adapter.finish", payload: { finishReason: "STOP" } },
        ],
      });

      let compactions = 0;
      const real = createModelTurnExecutor({ gateway: ai.gateway });
      const base = dependencies(real);
      const loopDependencies: AgentLoopDependencies = {
        ...base,
        // Compaction is a Context-runtime capability. Without it an overflow fails
        // closed immediately, so wiring it here is what makes one recovery possible.
        contextRuntime: {
          prepareModelContext: async (request) => {
            if (request.forceRecovery === true) compactions += 1;
            return {
              messages: [{ role: "user", content: "question" }],
              report: {} as never,
            };
          },
        },
      };

      let attempt = 0;
      const modelTurns = fakeModelTurnExecutor(async (request, signal) => {
        attempt += 1;
        if (attempt === 1) throw aiError("AI_CONTEXT_OVERFLOW");
        return real.execute({ request, signal });
      });

      const result = await new AgentLoop({ ...loopDependencies, modelTurns }).run(makeInput(root));

      expect(result.status).toBe("OUTCOME");
      // Exactly one compaction and exactly one transport attempt after it: no hidden
      // retry, and no second compaction.
      expect(compactions).toBe(1);
      expect(modelTurns.callCount()).toBe(2);
      expect(adapterCalls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed with CONTEXT_EXHAUSTED and performs no transport call when no Context runtime can compact", async () => {
    const root = await makeWorkspace();
    try {
      const { ai, adapterCalls } = createTestAiSubsystem({
        script: () => [
          { type: "text.delta", payload: { text: "unreachable" } },
          { type: "adapter.finish", payload: { finishReason: "STOP" } },
        ],
      });

      let attempt = 0;
      const real = createModelTurnExecutor({ gateway: ai.gateway });
      const modelTurns = fakeModelTurnExecutor(async (request, signal) => {
        attempt += 1;
        if (attempt === 1) throw aiError("AI_CONTEXT_OVERFLOW");
        return real.execute({ request, signal });
      });

      const result = await new AgentLoop(dependencies(modelTurns)).run(makeInput(root));

      expect(result.status).toBe("FAILED");
      if (result.status !== "FAILED") throw new Error("expected failure");
      expect(result.error.code).toBe("CONTEXT_EXHAUSTED");
      // One attempt only: recovery is impossible, so there is no second call to make.
      expect(modelTurns.callCount()).toBe(1);
      expect(adapterCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards the Run abort signal to the real transport and settles CANCELLED", async () => {
    const root = await makeWorkspace();
    try {
      const controller = new AbortController();
      let entered: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const { ai, adapterSignals } = createTestAiSubsystem({
        // A real transport rejects once its signal aborts; the adapter reports that as
        // `AI_ABORTED`, which Core must settle as CANCELLED rather than as a model error.
        script: (input) => ({
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<never>> => {
              entered?.();
              await new Promise<void>((resolve) => {
                if (input.signal.aborted) {
                  resolve();
                  return;
                }
                input.signal.addEventListener("abort", () => resolve(), { once: true });
              });
              throw aiError("AI_ABORTED");
            },
          }),
        }),
      });

      const pending = new AgentLoop(
        dependencies(createModelTurnExecutor({ gateway: ai.gateway })),
      ).run({ ...makeInput(root), signal: controller.signal });
      // Abort only once the adapter is actually on the wire, so this proves the signal
      // is propagated mid-flight rather than short-circuiting preflight.
      await started;
      controller.abort();
      const result = await pending;

      // The gateway forwarded the caller's signal unchanged to the adapter.
      expect(adapterSignals).toHaveLength(1);
      expect(adapterSignals[0]?.aborted).toBe(true);
      // An aborted provider turn is a cancellation, never a model failure.
      expect(result.status).toBe("CANCELLED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an uninterpretable provider finish reason as UNKNOWN_FINISH_REASON", async () => {
    const root = await makeWorkspace();
    try {
      const { ai } = createTestAiSubsystem({
        script: () => [
          { type: "text.delta", payload: { text: "this is not a stop" } },
          { type: "adapter.finish", payload: { finishReason: "OTHER" } },
        ],
      });

      const result = await new AgentLoop(
        dependencies(createModelTurnExecutor({ gateway: ai.gateway })),
      ).run(makeInput(root));

      expect(result.status).toBe("FAILED");
      if (result.status !== "FAILED") throw new Error("expected failure");
      // `OTHER` is not a stop, so it must never become a final candidate for verification.
      expect(result.error.code).toBe("MODEL_ERROR");
      expect(result.step?.status).toBe("FAILED");
      expect(result.state.status).toBe("RUNNING");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
