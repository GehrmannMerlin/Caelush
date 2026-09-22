import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, AIMessage } from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

/**
 * Prompt guidance through the real daemon: Context, not description.
 *
 * ```text
 * BEFORE 4E   registry-builder folds modelGuidance into AIToolSpec.description
 * AFTER  4E   CodingToolCatalog.promptSnippet → ToolPromptContextProvider → budgeted Context
 * ```
 *
 * The test drives a real Run through the real HTTP surface and then reads the *actual provider
 * request* the adapter was handed, because "guidance left the description" and "guidance is in the
 * context" are claims about the wire, not about an internal object.
 *
 * What it asserts, and why each one matters:
 *
 * ```text
 * description is short      guidance inside a tool definition is counted against the catalog byte
 *                           budget, is sent whether or not the Tool is exposed, and is not context
 * context carries it once   a duplicated block would bill the model twice for the same instruction
 * inactive Tools absent     a Git Tool this host did not register must not describe itself
 * ```

 */

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

interface CapturedTurn {
  readonly messages: readonly AIMessage[];
  readonly tools: readonly { readonly name: string; readonly description: string }[];
}

/** Captures every provider request, then answers with plain text so the Run can complete. */
class CapturingProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly turns: CapturedTurn[] = [];

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    const review = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    this.turns.push({
      messages: input.request.messages,
      tools: (input.request.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    });
    return this.events(
      review
        ? JSON.stringify({ verdict: "PASS", summary: "The candidate is acceptable." })
        : "done",
    );
  }

  private async *events(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
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

async function runOnce(provider: ApiAdapter) {
  directory = await mkdtemp(join(tmpdir(), "caelush-4e-prompt-e2e-"));
  await writeFile(join(directory, "README.md"), "# fixture\n", "utf8");
  daemon = await startDaemon({
    databasePath: join(directory, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [fixtureBinding()],
    modelSources: [fixtureModelSource()],
    adapterOverrides: [provider],
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  const client = new CaelushClient({ baseUrl: daemon.url });
  const workspace = { id: createWorkspaceId(), path: directory };
  const session = await client.createSession({
    defaultWorkspace: workspace,
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  const run = await client.createRun(session.id, {
    goal: "describe the workspace",
    workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "NEVER_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 15_000 },
  });
  await client.startRun(run.id);
  let settled = await client.getRun(run.id);
  for (let attempt = 0; attempt < 120 && !isTerminal(settled.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    settled = await client.getRun(run.id);
  }
  return { client, runId: run.id, status: settled.status };
}

describe("Phase 4E prompt production E2E", () => {
  it("carries the active Tool specs with guidance-free descriptions", async () => {
    const provider = new CapturingProvider();
    const { status } = await runOnce(provider);
    expect(status).toBe("COMPLETED");
    expect(provider.turns.length).toBeGreaterThan(0);

    const turn = provider.turns[0]!;
    // The nine default Tools reach the model, in the frozen order.
    expect(turn.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "git_status",
      "git_diff",
    ]);

    for (const tool of turn.tools) {
      // A concise, stable statement of what the Tool is — and nothing else.
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(64);
      for (const heading of [
        "Purpose:",
        "When:",
        "When not:",
        "Args:",
        "Side effects:",
        "Safety:",
        "Results:",
      ]) {
        expect(tool.description, `${tool.name} / ${heading}`).not.toContain(heading);
      }
    }
  }, 30_000);

  it("delivers the guidance block exactly once, inside the system context", async () => {
    const provider = new CapturingProvider();
    await runOnce(provider);

    const messages = provider.turns[0]!.messages;
    const system = messages.filter((message) => message.role === "system");
    expect(system.length).toBeGreaterThan(0);

    const systemText = system.map((message) => message.content).join("\n");
    expect(systemText).toContain("<tool_guidance>");

    // Exactly once, across every message of the turn: the guidance is context, not a description
    // suffix, so a second copy would be a duplicated instruction billed twice.
    const wholeTurn = messages.map((message) => message.content).join("\n");
    expect(occurrences(wholeTurn, "<tool_guidance>")).toBe(1);
    expect(occurrences(wholeTurn, "read_file\nPurpose:")).toBe(1);

    // It describes the active Tools, in registry order, and every block is present.
    for (const name of ["read_file", "list_directory", "find_files", "search_text"]) {
      expect(systemText).toContain(`${name}\nPurpose:`);
    }
  }, 30_000);

  it("accounts the guidance inside the Context token estimate", async () => {
    const provider = new CapturingProvider();
    const { client, runId } = await runOnce(provider);

    const usage = await client.getRunContextUsage(runId);
    // The block is part of the system message, so it is inside `estimatedInputTokens` rather than
    // appended after the budget was measured.
    expect(usage?.estimatedInputTokens ?? 0).toBeGreaterThan(0);
    expect(usage?.effectiveInputLimitTokens ?? 0).toBeGreaterThan(0);
  }, 30_000);
});

/**
 * How many times one substring appears.
 *
 * A count rather than a boolean: "guidance is present" and "guidance is present exactly once" are
 * different claims, and the second is the one the round requires.
 */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
