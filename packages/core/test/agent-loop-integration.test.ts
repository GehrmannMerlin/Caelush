import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import type { ApiAdapterStreamInput } from "@caelush/ai";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";
import {
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  createTestAiSubsystem,
} from "./support/test-ai-subsystem.js";

const model = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL };

/**
 * The production composition, end to end.
 *
 * Phase 2C deleted every Core seam that could reach a model directly, so this suite
 * exercises the *real* chain:
 *
 * ```text
 * AgentLoop → ModelTurnExecutor → AIGateway.stream() → ApiAdapter → Context
 * ```
 *
 * Only the wire dialect is scripted. The gateway, model catalog, provider registry,
 * stream validator and turn assembler are the production implementations, which is
 * what makes this an integration test rather than a unit test with stubs.
 */
function dependencies(script: Parameters<typeof createTestAiSubsystem>[0]["script"]): {
  dependencies: AgentLoopDependencies;
  adapterCalls: readonly ApiAdapterStreamInput[];
} {
  const { ai, adapterCalls } = createTestAiSubsystem({ script });
  return {
    dependencies: {
      inspector: createLocalProjectInspector(),
      planner: createLocalRelevantFilePlanner(),
      contextBuilder: new ContextBuilder(),
      models: ai.models,
      modelTurns: createModelTurnExecutor({ gateway: ai.gateway }),
      clock: { now: () => createTimestampMs(10) },
      stepIdFactory: { create: () => createStepId() },
    },
    adapterCalls,
  };
}

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-loop-integration-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "AGENTS.md"), "Keep parser tests passing.\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
  await writeFile(
    path.join(root, "src", "parser.ts"),
    `export function parse(value: string): boolean {\n  return value.length > 0;\n}\n${"// parser implementation context\n".repeat(30)}`,
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "parser.test.ts"),
    "test('parser', () => expect(parse('value')).toBe(true));\n",
    "utf8",
  );
  return root;
}

function makeInput(root: string): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "Fix parser behavior without breaking its tests.",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: root },
    model,
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 10, timeoutMs: 1000 },
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
    contextLimits: { maxInputTokens: 4000, safetyMarginTokens: 0 },
    signal: new AbortController().signal,
    cwd: root,
    tools: [
      {
        name: "read_file",
        description: "Read a project file.",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
        riskLevel: "LOW",
        requiredCapabilities: ["FS_READ"],
        runtimeRequirements: {},
      },
    ],
  };
}

describe("real Context → AIGateway resumable loop", () => {
  it("re-observes the fixture after the external tool boundary", async () => {
    const root = await makeFixture();
    try {
      // Turn one asks for a tool; turn two answers. One adapter call per turn proves
      // the loop never retried or double-invoked the transport.
      const { dependencies: deps, adapterCalls } = dependencies((input, turnIndex) => {
        if (turnIndex === 0) {
          return [
            { type: "tool_call.start", payload: { toolCallId: "call_a", toolName: "read_file" } },
            {
              type: "tool_call.completed",
              payload: { id: "call_a", name: "read_file", input: { path: "src/parser.ts" } },
            },
            { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } },
          ];
        }
        return [
          { type: "text.delta", payload: { text: "parser fixed" } },
          { type: "adapter.finish", payload: { finishReason: "STOP" } },
        ];
      });

      const initial = makeInput(root);
      const loop = new AgentLoop(deps);
      const first = await loop.run(initial);
      expect(first.status).toBe("OUTCOME");
      if (first.status !== "OUTCOME" || first.outcome.type !== "TOOL_CALLS_REQUESTED") {
        throw new Error("expected tool request");
      }
      expect(first.state.status).toBe("RUNNING");
      expect(first.state.usage.steps).toBe(1);
      expect(first.messagesToAppend.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(adapterCalls).toHaveLength(1);
      // The model turn resolved through the catalog, not through a request field.
      expect(adapterCalls[0]?.model.ref).toEqual(model);
      expect(adapterCalls[0]?.request.model.ref).toEqual(model);

      const updated = `export function parse(value: string): boolean { return value.trim() !== ''; }\n${"// updated parser\n".repeat(30)}`;
      await writeFile(path.join(root, "src", "parser.ts"), updated, "utf8");
      const resumed = await loop.resumeWithToolResults({
        ...initial,
        state: first.state,
        history: first.messagesToAppend,
        pendingDecision: first.outcome,
        toolResults: [
          {
            role: "tool",
            toolCallId: "call_a",
            toolName: "read_file",
            content: updated,
            isError: false,
          },
        ],
      });

      expect(resumed.status).toBe("OUTCOME");
      if (resumed.status !== "OUTCOME") throw new Error("expected final outcome");
      expect(resumed.outcome.type).toBe("FINAL_CANDIDATE");
      expect(resumed.state.status).toBe("VERIFYING");
      expect(resumed.state.usage.steps).toBe(2);
      expect(adapterCalls).toHaveLength(2);
      expect(resumed.messagesToAppend.map((message) => message.role)).toEqual([
        "tool",
        "assistant",
      ]);
      const secondTurn = adapterCalls[1]?.request;
      expect(secondTurn?.messages.some((message) => message.role === "tool")).toBe(true);
      expect(
        secondTurn?.messages.some(
          (message) => message.role === "user" && message.content.includes("updated parser"),
        ),
      ).toBe(true);
      expect(resumed.state.status).not.toBe("COMPLETED");

      // Exactly one transport attempt per Agent Step: no hidden provider retry.
      expect(adapterCalls).toHaveLength(resumed.state.usage.steps);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
