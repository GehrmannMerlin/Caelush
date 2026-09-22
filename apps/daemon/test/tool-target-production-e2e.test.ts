import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, AIMessage } from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon } from "../src/index.js";
import { FIXTURE_API, finish, fixtureBinding, fixtureModelSource, toolCall } from "./support/ai-fixture.js";

/**
 * The daemon cutover, end to end, through a real Run.
 *
 * ```text
 * daemon composition  →  Coding target Tool  →  Operations port  →  Runtime adapter  →  Runtime
 *        ↓
 * canonical Tool pipeline  →  ToolObservation  →  model feedback
 * ```
 *
 * The point of this suite is that the *production* composition is the one under test: the daemon is
 * started through `startDaemon`, the Run is created through the real HTTP client, and the provider is
 * a scripted adapter that emits genuine tool calls. Nothing is wired by hand, so a Tool that the
 * composition did not register cannot be called and a Tool that fails cannot be hidden by a fixture.
 *
 * Three Tools are covered, one per capability family the round migrated:
 *
 * ```text
 * read_file      a read        proves the read-only Operations adapter
 * apply_patch    a mutation    proves the patch adapter and the effect projection
 * exec_command   a process     proves the process adapter and the transient update channel
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

/** A scripted provider that calls one Tool and then answers. */
class ScriptedProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly seen: AIMessage[][] = [];
  #turns = 0;

  /**
   * @param scripted the events of the first provider turn — a tool-call turn.
   *
   * `finish()` is used with `TOOL_CALLS`, not `STOP`: a model turn that requested tools is a tool-call
   * decision, and a `STOP` finish reason would make the same message a final candidate.
   */
  constructor(private readonly scripted: readonly AIAdapterEvent[]) {}

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.seen.push([...input.request.messages]);
    const review = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    // A verification review and every turn after the first answer with plain text.
    if (review || this.#turns > 0) {
      this.#turns += 1;
      return this.events([
        ...(review
          ? [
              {
                type: "text.delta" as const,
                payload: { text: JSON.stringify({ verdict: "PASS", summary: "ok" }) },
              },
            ]
          : [{ type: "text.delta" as const, payload: { text: "done" } }]),
        { type: "adapter.finish", payload: { finishReason: "STOP" } },
      ]);
    }
    this.#turns += 1;
    return this.events([...this.scripted, finish("TOOL_CALLS")]);
  }

  private async *events(events: readonly AIAdapterEvent[]): AsyncGenerator<AIAdapterEvent> {
    for (const event of events) yield event;
  }
}

async function drive(provider: ApiAdapter, files: Record<string, string>) {
  directory = await mkdtemp(join(tmpdir(), "caelush-4e-daemon-e2e-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content, "utf8");
  }
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
    goal: "exercise the production tool",
    workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "FULL_ACCESS",
    approvalPolicy: "NEVER_ASK",
    limits: { maxSteps: 6, maxToolCalls: 6, timeoutMs: 20_000 },
  });
  await client.startRun(run.id);
  let settled = await client.getRun(run.id);
  for (let attempt = 0; attempt < 200 && !isTerminal(settled.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    settled = await client.getRun(run.id);
  }
  return { client, runId: run.id, status: settled.status };
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

/** Every tool-result message the provider was shown, across the whole Run. */
function toolResults(provider: ScriptedProvider): readonly AIMessage[] {
  return provider.seen.flat().filter((message) => message.role === "tool");
}

describe("Phase 4E daemon production Tool E2E", () => {
  it("runs read_file through the production composition and feeds the result back", async () => {
    const provider = new ScriptedProvider(toolCall("call_read", "read_file", { path: "README.md" }));
    const { status } = await drive(provider, { "README.md": "fixture line one\nfixture line two\n" });

    expect(status).toBe("COMPLETED");
    const results = toolResults(provider);
    expect(results.length).toBeGreaterThan(0);
    const result = results[0]!;
    expect(result.toolName).toBe("read_file");
    expect(result.isError).toBe(false);
    // The Runtime renders numbered lines, and the content is the Tool's own output.
    expect(result.content).toContain("fixture line one");
    expect(result.content).toContain("fixture line two");
  }, 40_000);

  it("runs apply_patch through the production composition and changes the workspace", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: created-by-tool.txt",
      "+caelush",
      "*** End Patch",
    ].join("\n");
    const provider = new ScriptedProvider(toolCall("call_patch", "apply_patch", { patch }));
    const { status } = await drive(provider, { "README.md": "x\n" });

    expect(status).toBe("COMPLETED");
    const result = toolResults(provider)[0]!;
    expect(result.toolName).toBe("apply_patch");
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Patch applied.");
    // The mutation really happened: the Tool reached the Runtime patch service through the port.
    expect(existsSync(join(directory!, "created-by-tool.txt"))).toBe(true);
    expect(await readFile(join(directory!, "created-by-tool.txt"), "utf8")).toBe("caelush\n");
  }, 40_000);

  it("runs exec_command through the production composition and reports its output", async () => {
    const provider = new ScriptedProvider(toolCall("call_exec", "exec_command", { cmd: "echo caelush-4e-marker" }));
    const { status } = await drive(provider, { "README.md": "x\n" });

    expect(status).toBe("COMPLETED");
    const result = toolResults(provider)[0]!;
    expect(result.toolName).toBe("exec_command");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("caelush-4e-marker");
    expect(result.content).toContain("exit code 0");
  }, 40_000);

  it("answers an unavailable Tool as safe feedback without a fabricated observation", async () => {
    // `git_status` on a workspace that is not a repository is a command failure, not a missing Tool;
    // the point here is narrower — a Tool the model asks for is dispatched through the same pipeline
    // and any failure comes back as a model-recoverable result rather than a Run failure.
    const provider = new ScriptedProvider(toolCall("call_git", "git_status", {}));
    const { status } = await drive(provider, { "README.md": "x\n" });

    expect(status).toBe("COMPLETED");
    const result = toolResults(provider)[0]!;
    expect(result.toolName).toBe("git_status");
    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  }, 40_000);
});
