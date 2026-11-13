import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import { CaelushClient } from "@caelush/client";
import type { AIProviderBinding, ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  sendOpenAIText,
  writeOpenAIChunk,
  type ControllableProviderServer,
} from "./support/controllable-provider-server.js";
import { restrictedProvider } from "./support/permission-flow-fixture.js";

const PROVIDER_ID = "skills-off-baseline-fixture";
const MODEL_ID = "skills-off-baseline-model";
const OPENAI_API = "openai-compatible-chat";

let workspacePath: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;
let provider: ControllableProviderServer | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  await provider?.close().catch(() => undefined);
  if (workspacePath !== undefined) await rm(workspacePath, { recursive: true, force: true });
  daemon = undefined;
  provider = undefined;
  workspacePath = undefined;
});

describe("Skills OFF production request baseline", () => {
  it("captures the real createRun, AgentLoop, and Provider adapter request", async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "caelush-skills-off-baseline-"));
    await mkdir(join(workspacePath, "src"));
    await writeFile(join(workspacePath, "README.md"), "OFF baseline read-only fixture\n", "utf8");

    let taskTurn = 0;
    provider = await createControllableProviderServer((request, response) => {
      if (JSON.stringify(request.body).includes("Review the supplied")) {
        sendOpenAIText(response, JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
        return;
      }
      taskTurn += 1;
      if (taskTurn === 1) {
        beginOpenAISse(response);
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "skills-off-baseline-read",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"README.md"}' },
              },
            ],
          },
          finishReason: "tool_calls",
        });
        response.end("data: [DONE]\n\n");
        return;
      }
      sendOpenAIText(response, "Completed the local read-only baseline.");
    });

    const binding: AIProviderBinding = {
      id: PROVIDER_ID,
      endpoint: `${provider.endpoint}/v1`,
      defaultApi: OPENAI_API,
      allowUnknownModels: true,
      credentials: { resolve: async () => ({ apiKey: "fixture-only-key" }) },
      rateLimitDomain: "skills-off-baseline",
    };
    const modelSource: ModelDescriptorSourcePort = {
      id: "skills-off-baseline",
      priority: 0,
      resolve: ({ provider: providerId, model }) =>
        providerId === PROVIDER_ID && model === MODEL_ID ? fixtureDescriptor() : undefined,
    };
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [binding],
      modelSources: [modelSource],
      defaultModel: { provider: PROVIDER_ID, model: MODEL_ID },
      processSandboxProviders: [restrictedProvider],
      logger: false,
    });

    const client = new CaelushClient({ baseUrl: daemon.url });
    const defaultWorkspace = { id: createWorkspaceId(), path: workspacePath };
    const session = await client.createSession({
      defaultWorkspace,
      defaultModel: { provider: PROVIDER_ID, model: MODEL_ID },
    });
    const run = await client.createRun(session.id, {
      goal: "inspect the local OFF baseline fixture",
      workspace: session.defaultWorkspace ?? defaultWorkspace,
      model: { provider: PROVIDER_ID, model: MODEL_ID },
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 30_000 },
    });

    await client.startRun(run.id);
    const settled = await waitForRun(client, run.id);
    expect(settled.status).toBe("COMPLETED");
    expect(taskTurn).toBe(2);

    const requests = provider.requests.filter((request) => !isReviewRequest(request.body));
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const first = requests[0]!;
    const second = requests[1]!;
    const tools = first.body["tools"];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(13);
    expect((tools as readonly Record<string, unknown>[]).map(getToolName)).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "update_plan",
      "exec_command",
      "write_stdin",
      "stop_process",
      "git_status",
      "git_diff",
      "read_attachment",
      "read_history",
    ]);
    expect(second.body["tools"]).toEqual(tools);
    for (const request of [first, second]) {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1/chat/completions");
      expect(request.rawBodyByteLength).toBeGreaterThan(0);
      expect(request.rawBodySha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const providerOptions = withoutKey(first.body, "messages");
    expect(withoutKey(second.body, "messages")).toEqual(providerOptions);

    const firstMessages = getMessages(first.body);
    const secondMessages = getMessages(second.body);
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < firstMessages.length &&
      commonPrefixLength < secondMessages.length &&
      JSON.stringify(firstMessages[commonPrefixLength]) ===
        JSON.stringify(secondMessages[commonPrefixLength])
    ) {
      commonPrefixLength += 1;
    }
    expect(commonPrefixLength).toBe(3);
    expect(secondMessages.slice(0, commonPrefixLength).map((message) => message["role"])).toEqual([
      "system",
      "user",
      "user",
    ]);

    const stableHead = firstMessages.find((message) => message["role"] === "system");
    expect(stableHead).toBeDefined();
    const toolSpecsJson = JSON.stringify(tools);
    const stableHeadJson = JSON.stringify(stableHead);
    expect(sha256(toolSpecsJson)).toBe(
      "5b6f83a94b744229d682fc0c492bcda41f7ccedbc0b4d0dc69fd4f7d8df7dd8d",
    );
    expect(sha256(stableHeadJson)).toBe(
      "aea72f2a0ee1bc47c393bc41fd2e2c90fc1ee166807ad55021d1af42d73b61f0",
    );
    expect(sha256(JSON.stringify(providerOptions))).toBe(
      "794ecab5d169ac2f171f35ba4c4660919dc079bc2e227084dab2ec607dd3d07d",
    );
  }, 30_000);
});

function fixtureDescriptor(): ModelDescriptor {
  return {
    ref: { provider: PROVIDER_ID, model: MODEL_ID },
    api: OPENAI_API,
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
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
}

function getMessages(body: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const messages = body["messages"];
  if (!Array.isArray(messages)) throw new Error("Provider request did not contain messages.");
  return messages as readonly Record<string, unknown>[];
}

function getToolName(tool: Readonly<Record<string, unknown>>): string {
  const fn = tool["function"];
  if (typeof fn !== "object" || fn === null || Array.isArray(fn)) {
    throw new Error("Provider tool definition did not contain a function.");
  }
  const name = (fn as Readonly<Record<string, unknown>>)["name"];
  if (typeof name !== "string") throw new Error("Provider tool definition did not have a name.");
  return name;
}

function isReviewRequest(body: Readonly<Record<string, unknown>>): boolean {
  return JSON.stringify(body).includes("Review the supplied");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withoutKey(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

async function waitForRun(client: CaelushClient, runId: Parameters<CaelushClient["getRun"]>[0]) {
  let run = await client.getRun(runId);
  for (let attempt = 0; attempt < 600 && !isTerminal(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    run = await client.getRun(runId);
  }
  return run;
}

function isTerminal(status: string): boolean {
  return ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "BUDGET_EXCEEDED"].includes(status);
}
