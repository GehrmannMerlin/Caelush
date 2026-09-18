/* global Buffer, URL, fetch */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createWorkspaceRef, startDaemon } from "../apps/daemon/dist/index.js";

/**
 * The browser smoke's model backend.
 *
 * ```text
 * BEFORE  startDaemon({ providerOverrides: [legacyProviderObject] })
 * AFTER   startDaemon({ providers: [{ provider, baseUrl }] })  →  a local HTTP fake provider
 * ```
 *
 * `providerOverrides` never existed on the production `DaemonOptions`; it was silently ignored, so the
 * daemon came up with no providers at all and the first session creation failed with
 * `MODEL_PROVIDER_UNAVAILABLE`. The current composition seam is the declarative `providers`
 * configuration, which reaches `toAIProviderBinding` (endpoint + credentials + `openai-compatible-chat`
 * dialect) and `toModelDescriptorSources` (a `CONFIGURATION` descriptor per model profile).
 *
 * So the fixture is a real model *server* rather than an in-process provider object: a loopback-only,
 * ephemeral-port `node:http` server that speaks OpenAI-compatible SSE. That keeps the smoke honest —
 * the request still travels `AIGateway → OpenAI-compatible adapter → @ai-sdk/openai-compatible → fetch
 * → HTTP → SSE`, which is the path a real deployment uses, and it reaches no external network.
 *
 * The turn script is the one the previous in-process fixture implemented, only expressed on the wire.
 */

const FIXTURE_PROVIDER_ID = "browser-fixture";
const FIXTURE_MODEL_ID = "browser-fixture-model";

async function startFakeModelServer() {
  const server = createServer((request, response) => {
    void handleModelRequest(request, response);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    // Ephemeral port on loopback only: no fixed port to collide with, and nothing off-host can reach it.
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The browser fixture provider did not bind a TCP port.");
  }
  let closed;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      (closed ??= new Promise((resolvePromise) => {
        // A held "waiting" stream is still open by design; closeAllConnections is what guarantees the
        // process can exit rather than hanging on a leaked socket.
        server.closeAllConnections();
        server.close(() => resolvePromise());
      })),
  };
}

async function handleModelRequest(request, response) {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readRequestBody(request));
  } catch {
    response.writeHead(400).end();
    return;
  }
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const isReview = messages.some(
    (message) =>
      message?.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes("Review the supplied"),
  );
  const hasToolResult = messages.some((message) => message?.role === "tool");
  const promptText = messages
    .map((message) => (typeof message?.content === "string" ? message.content : ""))
    .join("\n");

  // The task-acceptance review is a host action, not an Agent turn: it must answer with strict JSON and
  // no tool calls, or the completion gate reports REVIEWER_RESPONSE_INVALID.
  if (isReview) {
    writeSse(
      response,
      textChunks(
        JSON.stringify({ verdict: "PASS", summary: "The browser candidate is acceptable." }),
      ),
    );
    return;
  }
  if (promptText.includes("read browser fixture") && !hasToolResult) {
    writeSse(
      response,
      toolCallChunks("read_file", { path: "fixture.txt" }, "browser-read-fixture"),
    );
    return;
  }
  if (
    (promptText.includes("apply browser patch") || promptText.includes("reject browser patch")) &&
    !hasToolResult
  ) {
    writeSse(
      response,
      toolCallChunks(
        "apply_patch",
        {
          patch:
            "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-browser fixture\n+patched browser fixture\n*** End Patch",
        },
        "browser-patch-fixture",
      ),
    );
    return;
  }
  if (
    (promptText.includes("cancel browser task") || promptText.includes("reconnect browser task")) &&
    !hasToolResult
  ) {
    holdStreamOpen(request, response);
    return;
  }
  writeSse(response, textChunks("Verified browser result."));
}

/**
 * Answer a turn by never finishing it.
 *
 * The cancellation scenario needs a provider attempt that is genuinely in flight when the user cancels,
 * so the SSE headers are flushed and the response is deliberately left without a `finish_reason`.
 * `request.on("close")` drops the response when the daemon aborts the turn or the socket dies, and
 * `server.closeAllConnections()` is the backstop for anything still parked at teardown.
 */
function holdStreamOpen(request, response) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.flushHeaders();
  request.on("close", () => response.destroy());
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

/** One chunk. `choices` is required by the provider schema even on a usage-only terminal chunk. */
function chunk(delta, finishReason, usage) {
  return {
    id: "chatcmpl-browser-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: FIXTURE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...(usage === undefined ? {} : { usage }),
  };
}

/** A real usage block keeps the durable budget ledger exact instead of conservative. */
const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function textChunks(text) {
  return [chunk({ role: "assistant", content: text }, null), chunk({}, "stop", USAGE)];
}

function toolCallChunks(name, input, toolCallId) {
  return [
    chunk(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: toolCallId,
            type: "function",
            function: { name, arguments: JSON.stringify(input) },
          },
        ],
      },
      null,
    ),
    chunk({}, "tool_calls", USAGE),
  ];
}

const directory = await mkdtemp(join(tmpdir(), "caelush-web-browser-"));
const workspace = createWorkspaceRef(directory);
const browserArtifacts = join(process.cwd(), "test-results", "web-session-browser-smoke");
const browserRunner = resolve(process.cwd(), "scripts", "web-session-browser-runner.mjs");
const fakeProvider = await startFakeModelServer();
let daemon;
try {
  // The session/run creation chain is proven reachable *before* a browser is launched: if the provider
  // is misconfigured this throws here with the daemon's own error instead of as a browser timeout.
  daemon = await startDaemon({
    databasePath: join(directory, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 250,
    providers: [
      {
        provider: FIXTURE_PROVIDER_ID,
        baseUrl: fakeProvider.url,
        apiKey: "browser-fixture-key",
        allowedModels: [FIXTURE_MODEL_ID],
        modelProfiles: {
          [FIXTURE_MODEL_ID]: {
            contextWindowTokens: 128_000,
            maxOutputTokens: 8_192,
            recommendedOutputReserveTokens: 4_096,
          },
        },
      },
    ],
    defaultModel: { provider: FIXTURE_PROVIDER_ID, model: FIXTURE_MODEL_ID },
    web: { buildRoot: resolve(process.cwd(), "apps", "web", "dist"), workspace },
  });
  await assertModelConfigured(daemon.url);
  await writeFile(join(directory, "fixture.txt"), "browser fixture\n", "utf8");
  await rm(browserArtifacts, { recursive: true, force: true });
  const result = await runBrowserSmoke(daemon.url + "/", browserArtifacts, workspace);
  if (result === 0) {
    const fixture = await readFile(join(directory, "fixture.txt"), "utf8");
    if (fixture !== "patched browser fixture\n") {
      throw new Error("Browser approval flow did not persist the verified patch.");
    }
  }
  if (result !== 0) process.exitCode = result;
} finally {
  // Order matters: the daemon aborts its active streams and disposes its composition first, which
  // releases any parked model request; the fixture server is then force-closed, then the temp dir.
  await daemon?.close().catch(() => undefined);
  await fakeProvider.close();
  await rm(directory, { recursive: true, force: true });
}

/**
 * Fail fast when the fixture provider is not actually composed.
 *
 * `providerOverrides` used to be silently ignored, and the smoke died several steps later inside a
 * browser timeout. Asking the daemon which providers it configured turns that into one clear error.
 */
async function assertModelConfigured(url) {
  const response = await fetch(new URL("/api/v1/info", url));
  if (!response.ok) throw new Error(`The daemon info route answered HTTP ${response.status}.`);
  const info = await response.json();
  const configured = Array.isArray(info?.configuredProviders) ? info.configuredProviders : [];
  if (!configured.includes(FIXTURE_PROVIDER_ID)) {
    throw new Error(
      `The fixture provider ${FIXTURE_PROVIDER_ID} is not composed; configured: ${JSON.stringify(configured)}.`,
    );
  }
}

function runBrowserSmoke(url, artifactDirectory, workspaceRef) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [browserRunner, url, artifactDirectory, JSON.stringify(workspaceRef)],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}
