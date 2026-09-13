import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type AgentEvent } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CaelushClient } from "@caelush/client";
import { startDaemon } from "../src/index.js";
import { DAEMON_API_DIALECT_IDS } from "../src/providers/legacy-ai-configuration.js";
import {
  ANTHROPIC_FIXTURE_KEY,
  ANTHROPIC_FIXTURE_MODEL,
  ANTHROPIC_FIXTURE_PROVIDER,
  OPENAI_FIXTURE_MODEL,
  OPENAI_FIXTURE_PROVIDER,
  anthropicMessagesSource,
  anthropicProviderBinding,
  openAIMessagesSource,
  type AnthropicWireScript,
} from "./support/anthropic-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  daemon = undefined;
});

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "BUDGET_EXCEEDED", "TIMEOUT"];

async function createWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), "caelush-anthropic-e2e-"));
  directory = workspacePath;
  await mkdir(join(workspacePath, "src"));
  await writeFile(
    join(workspacePath, "src", "message.txt"),
    "anthropic fixture contents\n",
    "utf8",
  );
  return workspacePath;
}

async function startAnthropicDaemon(
  workspacePath: string,
  script: AnthropicWireScript,
): Promise<{ close(): Promise<void>; url: string }> {
  return startDaemon({
    databasePath: join(workspacePath, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [anthropicProviderBinding(script)],
    modelSources: [anthropicMessagesSource()],
    defaultModel: { provider: ANTHROPIC_FIXTURE_PROVIDER, model: ANTHROPIC_FIXTURE_MODEL },
    logger: false,
  });
}

/** Start a Run and poll it to a terminal status. */
async function runToCompletion(
  client: CaelushClient,
  workspacePath: string,
  goal: string,
  provider: string = ANTHROPIC_FIXTURE_PROVIDER,
  model: string = ANTHROPIC_FIXTURE_MODEL,
): Promise<{ readonly status: string; readonly events: readonly AgentEvent[] }> {
  const session = await client.createSession({
    defaultWorkspace: { id: createWorkspaceId(), path: workspacePath },
    defaultModel: { provider, model },
  });
  const run = await client.createRun(session.id, {
    goal,
    workspace: { id: createWorkspaceId(), path: workspacePath },
    model: { provider, model },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "NEVER_ASK",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 20_000 },
  });

  const events: AgentEvent[] = [];
  const subscription = (async () => {
    for await (const event of client.watchRunEvents(run.id, { afterSequence: 0 })) {
      events.push(event);
      if (event.type === "run.completed" || event.type === "run.failed") break;
    }
  })();

  await client.startRun(run.id);

  let settled = await client.getRun(run.id);
  for (let attempt = 0; attempt < 200 && !TERMINAL.includes(settled.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    settled = await client.getRun(run.id);
  }

  await subscription.catch(() => undefined);
  if (!TERMINAL.includes(settled.status)) {
    throw new Error(`run ${run.id} did not settle; last status ${settled.status}`);
  }
  if (settled.status !== "COMPLETED") {
    const interesting = events.filter((event) =>
      ["error", "llm.failed", "run.failed", "verification.finalized"].includes(event.type),
    );
    throw new Error(
      `run ${run.id} settled as ${settled.status}; events: ${JSON.stringify(interesting)}`,
    );
  }
  return { status: settled.status, events };
}

describe("daemon native Anthropic Messages composition", () => {
  it("registers both native dialects in the production composition", () => {
    expect([...DAEMON_API_DIALECT_IDS]).toEqual(["openai-compatible-chat", "anthropic-messages"]);
  });

  it("runs an Agent turn to a verified completion over the native Messages dialect", async () => {
    const workspacePath = await createWorkspace();
    const handle = await startAnthropicDaemon(workspacePath, {
      kind: "answer",
      text: "The requested task is complete.",
    });
    daemon = handle;
    const client = new CaelushClient({ baseUrl: handle.url });

    await expect(client.getInfo()).resolves.toMatchObject({
      configuredProviders: [ANTHROPIC_FIXTURE_PROVIDER],
      defaultModel: { provider: ANTHROPIC_FIXTURE_PROVIDER, model: ANTHROPIC_FIXTURE_MODEL },
    });

    const result = await runToCompletion(client, workspacePath, "report the fixture workspace");

    expect(result.status).toBe("COMPLETED");
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.started", "llm.started", "run.completed"]),
    );
  });

  it("carries a Tool call round trip across two native Anthropic turns", async () => {
    const workspacePath = await createWorkspace();
    const script: AnthropicWireScript = {
      kind: "tool-then-answer",
      toolCallId: "toolu_daemon_read",
      toolName: "read_file",
      toolInput: { path: "src/message.txt" },
      finalText: "The file contains the fixture contents.",
      requests: [],
    };
    const handle = await startAnthropicDaemon(workspacePath, script);
    daemon = handle;
    const client = new CaelushClient({ baseUrl: handle.url });

    const result = await runToCompletion(client, workspacePath, "read src/message.txt");

    expect(result.status).toBe("COMPLETED");
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool.started", "tool.completed"]),
    );
  });

  it("sends every native turn to the Messages endpoint with the native protocol headers", async () => {
    const workspacePath = await createWorkspace();
    const script: AnthropicWireScript = {
      kind: "tool-then-answer",
      toolCallId: "toolu_daemon_read",
      toolName: "read_file",
      toolInput: { path: "src/message.txt" },
      finalText: "Done.",
      requests: [],
    };
    const handle = await startAnthropicDaemon(workspacePath, script);
    daemon = handle;
    const client = new CaelushClient({ baseUrl: handle.url });

    await runToCompletion(client, workspacePath, "read src/message.txt");

    expect(script.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of script.requests) {
      expect(request.url).toBe("http://anthropic.invalid/v1/messages");
      expect(request.headers["x-api-key"]).toBe(ANTHROPIC_FIXTURE_KEY);
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.body["model"]).toBe(ANTHROPIC_FIXTURE_MODEL);
      expect(request.body["stream"]).toBe(true);
      expect(request.body).toHaveProperty("max_tokens");
      // The credential is a header, never part of the prompt.
      expect(request.bodyText).not.toContain(ANTHROPIC_FIXTURE_KEY);
    }
  });

  it("replays the assistant tool_use together with the tool_result on the second turn", async () => {
    const workspacePath = await createWorkspace();
    const script: AnthropicWireScript = {
      kind: "tool-then-answer",
      toolCallId: "toolu_daemon_read",
      toolName: "read_file",
      toolInput: { path: "src/message.txt" },
      finalText: "Done.",
      requests: [],
    };
    const handle = await startAnthropicDaemon(workspacePath, script);
    daemon = handle;
    const client = new CaelushClient({ baseUrl: handle.url });

    await runToCompletion(client, workspacePath, "read src/message.txt");

    const second = script.requests[1];
    expect(second?.nativeMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_use",
              id: "toolu_daemon_read",
              name: "read_file",
              input: { path: "src/message.txt" },
            }),
          ]),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_daemon_read" }),
          ]),
        }),
      ]),
    );
  });

  it("advertises the tool catalog in the native tool shape with no Caelush metadata", async () => {
    const workspacePath = await createWorkspace();
    const script: AnthropicWireScript = {
      kind: "tool-then-answer",
      toolCallId: "toolu_daemon_read",
      toolName: "read_file",
      toolInput: { path: "src/message.txt" },
      finalText: "Done.",
      requests: [],
    };
    const handle = await startAnthropicDaemon(workspacePath, script);
    daemon = handle;
    const client = new CaelushClient({ baseUrl: handle.url });

    await runToCompletion(client, workspacePath, "read src/message.txt");

    const tools = script.requests[0]?.body["tools"] as
      readonly Record<string, unknown>[] | undefined;
    expect(tools).toBeDefined();
    expect(tools?.length).toBeGreaterThan(0);

    const readFile = tools?.find((tool) => tool["name"] === "read_file");
    expect(readFile).toMatchObject({
      name: "read_file",
      input_schema: expect.objectContaining({ type: "object" }),
    });

    const serialized = JSON.stringify(tools);
    for (const forbidden of [
      "riskLevel",
      "outputSchema",
      "requiredCapabilities",
      "runtimeRequirements",
      "handler",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps the native dialect out of the client and HTTP contract", async () => {
    const workspacePath = await createWorkspace();
    const handle = await startAnthropicDaemon(workspacePath, { kind: "answer", text: "done" });
    daemon = handle;
    const client = new CaelushClient({ baseUrl: handle.url });

    const serialized = JSON.stringify(await client.getInfo());

    // A caller selects a provider and a model. It never selects a dialect, and the
    // dialect never becomes part of the public contract.
    expect(serialized).not.toContain("anthropic-messages");
    expect(serialized).not.toContain("anthropicMessages");
    expect(serialized).not.toContain(ANTHROPIC_FIXTURE_KEY);
  });

  it("dispatches each model of one daemon to its own dialect", async () => {
    const workspacePath = await createWorkspace();
    const script: AnthropicWireScript = {
      kind: "tool-then-answer",
      toolCallId: "toolu_daemon_read",
      toolName: "read_file",
      toolInput: { path: "src/message.txt" },
      finalText: "Done.",
      requests: [],
    };

    // One daemon, both dialects: the OpenAI-compatible binding is a plain recording
    // transport, and the Anthropic binding is the native Messages fixture.
    const openAIRequests: string[] = [];
    const openAIFetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      openAIRequests.push(url);
      const body = typeof init?.body === "string" ? init.body : "";
      const isReview = body.includes("Review the supplied");
      const text = isReview
        ? JSON.stringify({ verdict: "PASS", summary: "acceptable" })
        : "openai answer";
      const chunk = (content: string, finishReason: string | null): string =>
        `data: ${JSON.stringify({
          id: "chatcmpl-dual",
          object: "chat.completion.chunk",
          created: 1,
          model: "openai-fixture-model",
          choices: [
            { index: 0, delta: { role: "assistant", content }, finish_reason: finishReason },
          ],
        })}\n\n`;
      return Promise.resolve(
        new Response(`${chunk(text, null)}${chunk("", "stop")}data: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    };

    const handle = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [
        anthropicProviderBinding(script),
        {
          id: OPENAI_FIXTURE_PROVIDER,
          endpoint: "http://openai.invalid/v1",
          defaultApi: "openai-compatible-chat",
          allowUnknownModels: false,
          credentials: { resolve: async () => ({ apiKey: "fixture-openai-key" }) },
          transport: { fetch: openAIFetch },
        },
      ],
      modelSources: [anthropicMessagesSource(), openAIMessagesSource()],
      defaultModel: { provider: ANTHROPIC_FIXTURE_PROVIDER, model: ANTHROPIC_FIXTURE_MODEL },
      logger: false,
    });
    daemon = handle;
    const client = new CaelushClient({ baseUrl: handle.url });

    await expect(client.getInfo()).resolves.toMatchObject({
      configuredProviders: expect.arrayContaining([
        ANTHROPIC_FIXTURE_PROVIDER,
        OPENAI_FIXTURE_PROVIDER,
      ]),
    });

    // Selecting the Anthropic model must reach only the Anthropic transport.
    const anthropicRun = await runToCompletion(client, workspacePath, "read src/message.txt");
    expect(anthropicRun.status).toBe("COMPLETED");
    expect(script.requests.length).toBeGreaterThan(0);
    expect(openAIRequests).toHaveLength(0);

    // Selecting the OpenAI model must reach only the OpenAI transport.
    const openAIRun = await runToCompletion(
      client,
      workspacePath,
      "report the workspace",
      OPENAI_FIXTURE_PROVIDER,
      OPENAI_FIXTURE_MODEL,
    );
    expect(openAIRun.status).toBe("COMPLETED");
    expect(openAIRequests.length).toBeGreaterThan(0);
    for (const url of openAIRequests) expect(url).toContain("openai.invalid");
  });
});
