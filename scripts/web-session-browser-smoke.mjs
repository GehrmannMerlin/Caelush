/* global Buffer, URL, fetch */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createWorkspaceRef, startDaemon } from "../apps/daemon/dist/index.js";
import { resolvePromptCacheArtifactDirectory } from "./browser-smoke-artifact-path.mjs";

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
let providerRecoveryAttempts = 0;
let multiTurnPatchRequests = 0;
let s0PatchServed = false;
let s1PatchServed = false;
let s2ChunksServed = 0;
let s3HiddenChunksServed = 0;
let s3PatchServed = false;

const S2_CANCEL_TEXT = `S2_CANCEL_${"cancel ".repeat(1_800)}`;
const S2_COMPLETE_TEXT = `S2_COMPLETE ${"word ".repeat(1_800).trim()}`;
const S2_CANCEL_CHUNK_COUNT = 1_800;
const S2_COMPLETE_CHUNK_COUNT = 2_000;

/**
 * The sandbox Runner as a host with a working packaged artifact reports it.
 *
 * ```text
 * BEFORE  no restricted Provider  →  restricted presets synthesized from Full Access availability
 * AFTER   no restricted Provider  →  processSandbox UNAVAILABLE, no auto-selectable preset
 * ```
 *
 * `SecurityCapabilityService` now reports restricted capability truthfully, and Full Access
 * availability is never used to manufacture it. That makes this composition load-bearing for the
 * smoke rather than cosmetic: with no restricted Provider, **neither** View Only nor Workspace Write
 * is `AVAILABLE`, `choosePermissionPreset` finds nothing auto-selectable, and the Web composer
 * refuses every prompt before a browser is even launched. This fixture is what "a host with a working
 * Runner" looks like — it probes available with a real enforcement mode.
 *
 * It is a fixture, not a sandbox: `create` throws, because the smoke never runs a restricted process.
 */
const fixtureSandboxProvider = {
  id: "browser-fixture-runner",
  kind: "RESTRICTED",
  enforcement: "HARD",
  create: async () => {
    throw new Error("The browser smoke never executes a restricted process.");
  },
  probe: async () => ({ available: true, enforcement: "HARD" }),
};

/**
 * The workspace preparation port as a real Windows host reports it.
 *
 * ```text
 * VIEW_ONLY        READY          no grant to hand out: the read-only token needs none
 * WORKSPACE_WRITE  REQUIRED  →    READY once `prepare()` accepted it
 * ```
 *
 * This asymmetry is the whole reason the browser flow is worth asserting. A host that reported every
 * preset `AVAILABLE` would never render the preparation affordance, so the smoke could not tell a
 * working `PREPARATION_REQUIRED` path from one that had been silently broken — and neither could a
 * user, because the composer would just preselect a preset the workspace cannot actually use.
 *
 * It mirrors `NativeWorkspaceSandboxController.getStatus` (`VIEW_ONLY` short-circuits to `READY`,
 * `FULL_ACCESS` is not a restricted preset) without touching a Runner, exactly as the provider above
 * mirrors a probe. State is per Daemon instance, which is what lets the smoke prepare once and then
 * run every later scenario on the prepared workspace.
 */
function createFixtureWorkspacePreparation() {
  const prepared = new Set();
  return {
    supported: true,
    async getStatus(_workspaceId, preset) {
      if (preset.id === "VIEW_ONLY") return "READY";
      if (preset.id === "FULL_ACCESS") return "UNAVAILABLE";
      return prepared.has(preset.id) ? "READY" : "REQUIRED";
    },
    async prepare(_workspaceId, selection) {
      prepared.add(selection.id);
      return { status: "READY" };
    },
  };
}

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
  // The Web composer only offers models the daemon has *discovered*: `/api/v1/ai/models` is a catalog
  // view, not a view of the static `allowedModels` list. `discoveryPath()` maps a `/v1` endpoint to the
  // relative `models` path, so a provider must answer `GET /v1/models` or the directory stays empty and
  // the composer never leaves its disabled state — no prompt can ever be submitted.
  if (request.method === "GET" && request.url === "/v1/models") {
    const body = JSON.stringify({
      object: "list",
      data: [{ id: FIXTURE_MODEL_ID, object: "model", owned_by: FIXTURE_PROVIDER_ID }],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
    return;
  }
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
  const latestUserText = [...messages]
    .reverse()
    .find((message) => message?.role === "user" && typeof message.content === "string")?.content;
  const multiTurnPromptIndex = messages.findLastIndex(
    (message) =>
      typeof message?.content === "string" && message.content.includes("multi-turn patch fixture"),
  );
  const isMultiTurnPatch = multiTurnPromptIndex >= 0;

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
  if (promptText.includes("observe Provider recovery")) {
    providerRecoveryAttempts += 1;
    if (providerRecoveryAttempts === 1) {
      holdSseFor(
        response,
        5_000,
        [],
        [chunk({ role: "assistant", content: "failed-attempt fragment" }, null)],
      );
    } else {
      holdSseFor(response, 700, textChunks("Recovered after Provider recovery."));
    }
    return;
  }
  if (latestUserText?.includes("s3 hidden provider activity")) {
    const chunks = Array.from({ length: 45 }, (_, index) =>
      chunk({ reasoning_content: `S3_SECRET_REASONING_SENTINEL_${index}` }, null),
    );
    s3HiddenChunksServed += await writeSseDelayed(
      response,
      [...chunks, ...textChunks("S3 hidden activity completed.")],
      20,
    );
    return;
  }
  if (latestUserText?.includes("s3 durable burst")) {
    if (hasToolResult || s3PatchServed) {
      writeSse(response, textChunks("S3 durable refresh completed."));
      return;
    }
    s3PatchServed = true;
    const patch = [
      "*** Begin Patch",
      "*** Update File: fixture.txt",
      "@@",
      "-browser fixture",
      "+S3 durable effect",
      "*** End Patch",
    ].join("\n");
    writeSse(response, toolCallChunks("apply_patch", { patch }, "browser-s3-durable-patch"));
    return;
  }
  if (promptText.includes("s0 streaming buffer") && (hasToolResult || s0PatchServed)) {
    writeSse(response, textChunks("S0 streaming regression completed."));
    return;
  }
  if (promptText.includes("s0 streaming buffer") && !s0PatchServed) {
    s0PatchServed = true;
    const fixtureHtml = [
      "<!doctype html>",
      '<html lang="zh-CN">',
      '<head><meta charset="utf-8"><title>S0 stream fixture</title></head>',
      '<body><form><label>邮箱<input type="email" required></label><button>注册</button></form>',
      `<!-- ${"x".repeat(20_000)} -->`,
      "</body>",
      "</html>",
    ].join("\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: s0-stream-fixture.html",
      ...fixtureHtml.split("\n").map((line) => `+${line}`),
      "*** End Patch",
    ].join("\n");
    const streamedArguments = streamedToolCallChunks(
      "apply_patch",
      JSON.stringify({ patch }),
      "browser-s0-streaming-patch",
      1_000,
    );
    await writeSseDelayed(response, streamedArguments, 4, 500);
    return;
  }
  if (promptText.includes("s1 tool argument cutover") && (hasToolResult || s1PatchServed)) {
    writeSse(response, textChunks("S1 Tool presentation completed."));
    return;
  }
  if (promptText.includes("s1 tool argument cutover") && !s1PatchServed) {
    s1PatchServed = true;
    const fixtureHtml = [
      "<!doctype html>",
      '<html lang="zh-CN">',
      '<head><meta charset="utf-8"><title>S1 stream fixture</title></head>',
      "<body>",
      '<!-- "apiKey":"S1_RAW_ARGS_SECRET_VALUE_123" -->',
      ...Array.from(
        { length: 60 },
        (_, index) => `<!-- S1_RAW_ARGS_SECRET_VALUE_123-${index}-${"x".repeat(1_700)} -->`,
      ),
      "</body>",
      "</html>",
    ].join("\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: register.html",
      ...fixtureHtml.split("\n").map((line) => `+${line}`),
      "*** End Patch",
    ].join("\n");
    const streamedArguments = streamedToolCallChunks(
      "apply_patch",
      JSON.stringify({ patch }),
      "browser-s1-streaming-patch",
      200,
    );
    await writeSseDelayed(response, streamedArguments, 3, 500);
    return;
  }
  if (latestUserText?.includes("s2 cancel stream")) {
    const chunks = streamedTextChunks(S2_CANCEL_TEXT, S2_CANCEL_CHUNK_COUNT);
    s2ChunksServed += await writeSseDelayed(response, chunks, 2);
    return;
  }
  if (latestUserText?.includes("s2 complete stream")) {
    const chunks = streamedTextChunks(S2_COMPLETE_TEXT, S2_COMPLETE_CHUNK_COUNT);
    s2ChunksServed += await writeSseDelayed(response, chunks, 1);
    return;
  }
  if (promptText.includes("read browser fixture") && !hasToolResult) {
    writeSse(
      response,
      toolCallChunks("read_file", { path: "fixture.txt" }, "browser-read-fixture"),
    );
    return;
  }
  if (isMultiTurnPatch) {
    multiTurnPatchRequests += 1;
    if (multiTurnPatchRequests === 1) {
      writeSse(
        response,
        toolCallChunks(
          "apply_patch",
          {
            patch:
              "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-browser fixture\n+multi-turn fixture\n*** End Patch",
          },
          "browser-multi-turn-patch",
        ),
      );
    } else {
      holdStreamOpen(request, response);
    }
    return;
  }
  if (promptText.includes("read browser fixture") && hasToolResult) {
    writeSse(response, textChunks("# Browser report\n\n## Overview\n\nVerified browser result."));
    return;
  }
  if (promptText.includes("apply browser patch") && !hasToolResult) {
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
  // The approval scenarios need an action the gate cannot describe. A `..` segment is an escaping
  // path: `patchPath` refuses it, so `projectApplyPatchSecurityFacts` throws and the admission port
  // reports `opaqueInput`, which `ON_BOUNDARY` answers with a review request. Approving it still does
  // not let the write escape — the same parser refuses it again at execution — which is what makes the
  // boundary assertion below meaningful rather than decorative.
  if (
    (promptText.includes("review browser patch") || promptText.includes("reject browser patch")) &&
    !hasToolResult
  ) {
    writeSse(
      response,
      toolCallChunks(
        "apply_patch",
        {
          patch:
            "*** Begin Patch\n*** Update File: ../caelush-web-browser-outside.txt\n@@\n-outside fixture\n+escaped fixture\n*** End Patch",
        },
        "browser-outside-patch",
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

async function writeSseDelayed(response, chunks, delayMs, initialPauseMs = 0) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  let delivered = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    if (response.destroyed) return delivered;
    response.write(`data: ${JSON.stringify(chunks[index])}\n\n`);
    delivered += 1;
    const delay = index === 0 ? initialPauseMs : delayMs;
    if (delay > 0) {
      await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, delay));
    }
  }
  response.end("data: [DONE]\n\n");
  return delivered;
}

function holdSseFor(response, delayMs, chunks, initialChunks = []) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.flushHeaders();
  let timer;
  const stopTimer = () => globalThis.clearTimeout(timer);
  response.once("close", stopTimer);
  for (const chunk of initialChunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  timer = globalThis.setTimeout(() => {
    if (response.destroyed) return;
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  }, delayMs);
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

function streamedTextChunks(text, deltaCount) {
  if (text.length < deltaCount) {
    throw new Error("The S2 fixture needs at least one character in each text delta.");
  }
  const chunks = [chunk({ role: "assistant" }, null)];
  for (let index = 0; index < deltaCount; index += 1) {
    const start = Math.floor((text.length * index) / deltaCount);
    const end = Math.floor((text.length * (index + 1)) / deltaCount);
    chunks.push(chunk({ content: text.slice(start, end) }, null));
  }
  chunks.push(chunk({}, "stop", USAGE));
  return chunks;
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

function streamedToolCallChunks(name, argumentsText, toolCallId, deltaCount) {
  const initialCharacters = 16 * 1024 + 64;
  const initialArguments = argumentsText.slice(0, initialCharacters);
  const remainder = argumentsText.slice(initialCharacters);
  if (remainder.length < deltaCount) {
    throw new Error("The S0 fixture needs at least one character in each streamed Tool delta.");
  }

  const chunks = [
    chunk(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: toolCallId,
            type: "function",
            function: { name, arguments: initialArguments },
          },
        ],
      },
      null,
    ),
  ];
  for (let index = 0; index < deltaCount; index += 1) {
    const start = Math.floor((remainder.length * index) / deltaCount);
    const end = Math.floor((remainder.length * (index + 1)) / deltaCount);
    chunks.push(
      chunk(
        { tool_calls: [{ index: 0, function: { arguments: remainder.slice(start, end) } }] },
        null,
      ),
    );
  }
  chunks.push(chunk({}, "tool_calls", USAGE));
  return chunks;
}

const promptCacheOnly = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "PROMPT_CACHE";
const multiTurnOnly = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "MULTI_TURN";
const s0Only = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "S0";
const s1Only = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "S1";
const s2Only = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "S2";
const s3Only = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "S3";
const configuredArtifactDirectory = process.env.CAELUSH_BROWSER_SMOKE_ARTIFACT_DIR;
const browserArtifacts = promptCacheOnly
  ? await resolvePromptCacheArtifactDirectory(process.cwd(), configuredArtifactDirectory)
  : configuredArtifactDirectory === undefined
    ? s0Only
      ? join(tmpdir(), `caelush-web-browser-smoke-s0-${process.pid}`)
      : s1Only
        ? join(tmpdir(), `caelush-web-browser-smoke-s1-${process.pid}`)
        : s2Only
          ? join(tmpdir(), `caelush-web-browser-smoke-s2-${process.pid}`)
          : s3Only
            ? join(tmpdir(), `caelush-web-browser-smoke-s3-${process.pid}`)
            : join(process.cwd(), "test-results", "web-session-browser-smoke")
    : resolve(configuredArtifactDirectory);

const directory = await mkdtemp(join(tmpdir(), "caelush-web-browser-"));
const workspace = createWorkspaceRef(directory);
// The workspace's parent, i.e. just outside the boundary. The escaping-patch scenarios target this
// file and the smoke asserts it is byte-identical afterwards: an approval is a review, not a way out.
const outsideFixture = resolve(directory, "..", "caelush-web-browser-outside.txt");
const outsideFixtureContent = "outside fixture\n";
const browserRunner = resolve(process.cwd(), "scripts", "web-session-browser-runner.mjs");
const fakeProvider = await startFakeModelServer();
await writeFile(outsideFixture, outsideFixtureContent, "utf8");
let daemon;
try {
  // The session/run creation chain is proven reachable *before* a browser is launched: if the provider
  // is misconfigured this throws here with the daemon's own error instead of as a browser timeout.
  daemon = await startDaemon({
    databasePath: join(directory, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 250,
    providerStreamPolicy: {
      nudgeAfterMs: s3Only ? 250 : 1_000,
      idleTimeoutMs: s3Only ? 500 : 1_500,
      teardownGraceMs: 300,
    },
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
    processSandboxProviders: [fixtureSandboxProvider],
    // Injected explicitly because the packaged Windows host is only built when *both* the providers
    // and the preparation port are absent. Supplying only the provider would leave the composition
    // with no preparation authority at all, and a registered workspace would look fully prepared.
    workspacePreparation: createFixtureWorkspacePreparation(),
    web: { buildRoot: resolve(process.cwd(), "apps", "web", "dist"), workspace },
  });
  await assertModelConfigured(daemon.url);
  await assertPermissionsUsable(daemon.url);
  await writeFile(join(directory, "fixture.txt"), "browser fixture\n", "utf8");
  if (configuredArtifactDirectory === undefined) {
    await rm(browserArtifacts, { recursive: true, force: true });
  }
  await mkdir(browserArtifacts, { recursive: true });
  const result = await runBrowserSmoke(daemon.url + "/", browserArtifacts, workspace);
  if (result === 0 && s0Only) {
    const fixture = await readFile(join(directory, "s0-stream-fixture.html"), "utf8");
    if (!fixture.includes("S0 stream fixture") || fixture.length < 20_000) {
      throw new Error("The S0 streaming Tool fixture was not written completely.");
    }
    process.stdout.write(
      `[browser-smoke] S0 streamed Tool fixture persisted (${fixture.length} characters).\n`,
    );
  }
  if (result === 0 && s1Only) {
    const fixture = await readFile(join(directory, "register.html"), "utf8");
    if (
      !fixture.includes("S1 stream fixture") ||
      !fixture.includes("S1_RAW_ARGS_SECRET_VALUE_123") ||
      Buffer.byteLength(fixture, "utf8") < 100_000
    ) {
      throw new Error("The S1 large Tool argument fixture was not written completely.");
    }
    process.stdout.write(
      `[browser-smoke] S1 Tool fixture persisted (${Buffer.byteLength(fixture, "utf8")} bytes).\n`,
    );
  }
  if (result === 0 && s2Only) {
    process.stdout.write(`[browser-smoke] S2 provider text chunks served: ${s2ChunksServed}.\n`);
  }
  if (result === 0 && s3Only) {
    process.stdout.write(
      `[browser-smoke] S3 hidden Provider chunks served: ${s3HiddenChunksServed}; durable Tool call served: ${s3PatchServed}.\n`,
    );
    const fixture = await readFile(join(directory, "fixture.txt"), "utf8");
    if (fixture !== "S3 durable effect\n") {
      throw new Error(
        "S3 durable presentation fixture did not persist its Tool effect: " + fixture,
      );
    }
  }
  if (result === 0 && multiTurnOnly) {
    const fixture = await readFile(join(directory, "fixture.txt"), "utf8");
    if (fixture !== "multi-turn fixture\n") {
      throw new Error(
        "Focused multi-turn presentation did not persist its Tool effect: " + fixture,
      );
    }
    process.stdout.write(
      "[browser-smoke] focused multi-turn Tool effect persisted: " + JSON.stringify(fixture) + "\n",
    );
  }
  if (
    result === 0 &&
    !promptCacheOnly &&
    !multiTurnOnly &&
    !s0Only &&
    !s1Only &&
    !s2Only &&
    !s3Only
  ) {
    const fixture = await readFile(join(directory, "fixture.txt"), "utf8");
    if (fixture !== "patched browser fixture\n") {
      throw new Error("Browser approval flow did not persist the verified patch.");
    }
    const outside = await readFile(outsideFixture, "utf8");
    if (outside !== outsideFixtureContent) {
      throw new Error(
        `The reviewed patch escaped the workspace: ${JSON.stringify(outside)} instead of ${JSON.stringify(outsideFixtureContent)}.`,
      );
    }
    process.stdout.write(
      `[browser-smoke] in-workspace patch persisted, reviewed escape blocked: fixture=${JSON.stringify(fixture)} outside=${JSON.stringify(outside)}\n`,
    );
  }
  if (result !== 0) process.exitCode = result;
} finally {
  // Order matters: the daemon aborts its active streams and disposes its composition first, which
  // releases any parked model request; the fixture server is then force-closed, then the temp dir.
  await daemon?.close().catch(() => undefined);
  await fakeProvider.close();
  await rm(directory, { recursive: true, force: true });
  await rm(outsideFixture, { force: true });
}

/**
 * Fail fast when the fixture provider is not actually composed, or its models are undiscoverable.
 *
 * `providerOverrides` used to be silently ignored, and the smoke died several steps later inside a
 * browser timeout. Asking the daemon which providers it configured turns that into one clear error.
 *
 * The directory check is the same idea one level deeper. A provider can be configured and still
 * publish no models — discovery is what fills the directory, and a provider whose discovery fails is
 * omitted from `/api/v1/ai/models` while its failure is reported separately. That used to surface only
 * as a disabled composer in the browser, because the model picker renders an unknown selection as
 * `provider/model · 不可用` and the submit button waits for a directory that matches. Naming the
 * daemon's own answer here is what makes the cause obvious.
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

  const providersResponse = await fetch(new URL("/api/v1/ai/providers", url));
  if (!providersResponse.ok) {
    throw new Error(`The AI providers route answered HTTP ${providersResponse.status}.`);
  }
  const providers = await providersResponse.json();
  const fixtureProvider = (providers?.providers ?? []).find(
    (provider) => provider.id === FIXTURE_PROVIDER_ID,
  );
  if (fixtureProvider === undefined) {
    throw new Error(
      `The fixture provider ${FIXTURE_PROVIDER_ID} is missing from the provider list: ${JSON.stringify(providers)}.`,
    );
  }
  if (fixtureProvider.credentialConfigured !== true) {
    throw new Error(
      `The fixture provider ${FIXTURE_PROVIDER_ID} has no usable credential, so its models cannot be discovered: ${JSON.stringify(fixtureProvider)}.`,
    );
  }

  const modelsResponse = await fetch(
    new URL(`/api/v1/ai/models?provider=${encodeURIComponent(FIXTURE_PROVIDER_ID)}`, url),
  );
  if (!modelsResponse.ok) {
    throw new Error(`The AI model directory route answered HTTP ${modelsResponse.status}.`);
  }
  const directory = await modelsResponse.json();
  const fixtureModel = (directory?.models ?? []).find(
    (model) => model.provider === FIXTURE_PROVIDER_ID && model.id === FIXTURE_MODEL_ID,
  );
  if (fixtureModel === undefined) {
    throw new Error(
      `The fixture model ${FIXTURE_PROVIDER_ID}/${FIXTURE_MODEL_ID} is not in the daemon's model directory, so the composer can never enable: ${JSON.stringify(directory)}; provider=${JSON.stringify(fixtureProvider)}.`,
    );
  }
  if (fixtureModel.availability !== "AVAILABLE") {
    throw new Error(
      `The fixture model ${FIXTURE_MODEL_ID} is not AVAILABLE: ${JSON.stringify(fixtureModel)}.`,
    );
  }
}

/**
 * Fail fast when the permission selector has nothing it may auto-select.
 *
 * The Web composer refuses every prompt while no preset is selected, and a preset is only selected
 * when it is `AVAILABLE` and does not require confirmation — Full Access never qualifies. So this is
 * the precondition for the whole browser flow, and asserting it here names the real cause instead of
 * letting it surface as a browser timeout on the first prompt.
 *
 * The expected statuses are the *unprepared* ones on purpose. `WORKSPACE_WRITE` is
 * `PREPARATION_REQUIRED` until the browser prepares it, which is what the runner then asserts;
 * expecting `AVAILABLE` here would have hidden the entire preparation path.
 */
async function assertPermissionsUsable(url) {
  const workspacesResponse = await fetch(new URL("/api/v1/workspaces", url));
  if (!workspacesResponse.ok) {
    throw new Error(`The workspace route answered HTTP ${workspacesResponse.status}.`);
  }
  const workspaces = await workspacesResponse.json();
  const workspaceId = workspaces?.items?.[0]?.id;
  if (typeof workspaceId !== "string") {
    throw new Error("The browser fixture workspace was not registered.");
  }
  const capabilitiesResponse = await fetch(
    new URL(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/security/capabilities`, url),
  );
  if (!capabilitiesResponse.ok) {
    throw new Error(`The workspace capability route answered HTTP ${capabilitiesResponse.status}.`);
  }
  const capabilities = await capabilitiesResponse.json();
  const statuses = Object.fromEntries(
    (capabilities?.presets ?? []).map((preset) => [preset.id, preset.status]),
  );
  const expected = {
    VIEW_ONLY: "AVAILABLE",
    WORKSPACE_WRITE: "PREPARATION_REQUIRED",
    FULL_ACCESS: "AVAILABLE",
  };
  for (const [id, status] of Object.entries(expected)) {
    if (statuses[id] !== status) {
      throw new Error(
        `The browser smoke needs ${id} to be ${status}; the daemon reported ${JSON.stringify(statuses)}.`,
      );
    }
  }
  if (capabilities?.preparation?.status !== "REQUIRED") {
    throw new Error(
      `The browser smoke needs an unprepared workspace; the daemon reported ${JSON.stringify(capabilities?.preparation)}.`,
    );
  }
  // `console` is not in this file's declared globals and eslint's recommended set flags it as
  // `no-undef`; the explicit stream keeps the diagnostic without the lint error.
  process.stdout.write(`[browser-smoke] workspace permissions: ${JSON.stringify(statuses)}\n`);
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
