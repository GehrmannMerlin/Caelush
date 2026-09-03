import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createWorkspaceRef, startDaemon } from "../apps/daemon/dist/index.js";

const capabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "SUPPORTED",
  structuredOutput: "SUPPORTED",
  vision: "UNSUPPORTED",
  reasoningSummary: "UNSUPPORTED",
};

const provider = {
  id: "browser-fixture",
  calls: 0,
  supportsModel(model) {
    return model.provider === "browser-fixture" && model.model === "browser-fixture-model";
  },
  getCapabilities() {
    return capabilities;
  },
  stream(request, context) {
    provider.calls += 1;
    const isReview = request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    const promptText = request.messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    const hasToolResult = request.messages.some((message) => message.role === "tool");
    if (!isReview && promptText.includes("read browser fixture") && !hasToolResult) {
      return readFixtureTool(request, context);
    }
    if (
      !isReview &&
      (promptText.includes("apply browser patch") || promptText.includes("reject browser patch")) &&
      !hasToolResult
    ) {
      return patchFixtureTool(request, context);
    }
    if (
      !isReview &&
      (promptText.includes("cancel browser task") ||
        promptText.includes("reconnect browser task")) &&
      !hasToolResult
    ) {
      return waitingFixture(request, context);
    }
    const text = isReview
      ? JSON.stringify({ verdict: "PASS", summary: "The browser candidate is acceptable." })
      : "Verified browser result.";
    return (async function* () {
      yield {
        type: "stream.start",
        payload: { callId: context.callId, providerId: provider.id, model: request.model },
      };
      yield { type: "text.delta", payload: { text } };
      yield { type: "stream.finish", payload: { finishReason: "STOP" } };
    })();
  },
};

async function* readFixtureTool(request, context) {
  yield {
    type: "stream.start",
    payload: { callId: context.callId, providerId: provider.id, model: request.model },
  };
  yield {
    type: "tool_call.start",
    payload: { toolCallId: "browser-read-fixture", toolName: "read_file" },
  };
  yield {
    type: "tool_call.completed",
    payload: {
      id: "browser-read-fixture",
      name: "read_file",
      input: { path: "fixture.txt" },
    },
  };
  yield { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } };
}

async function* patchFixtureTool(request, context) {
  yield {
    type: "stream.start",
    payload: { callId: context.callId, providerId: provider.id, model: request.model },
  };
  yield {
    type: "tool_call.start",
    payload: { toolCallId: "browser-patch-fixture", toolName: "apply_patch" },
  };
  yield {
    type: "tool_call.completed",
    payload: {
      id: "browser-patch-fixture",
      name: "apply_patch",
      input: {
        patch:
          "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-browser fixture\n+patched browser fixture\n*** End Patch",
      },
    },
  };
  yield { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } };
}

async function* waitingFixture(request, context) {
  yield {
    type: "stream.start",
    payload: { callId: context.callId, providerId: provider.id, model: request.model },
  };
  await new Promise((resolvePromise) => {
    context.signal.addEventListener("abort", resolvePromise, { once: true });
  });
}

const directory = await mkdtemp(join(tmpdir(), "caelush-web-browser-"));
const workspace = createWorkspaceRef(directory);
const browserArtifacts = join(process.cwd(), "test-results", "web-session-browser-smoke");
const browserRunner = resolve(process.cwd(), "scripts", "web-session-browser-runner.mjs");
let daemon;
try {
  daemon = await startDaemon({
    databasePath: join(directory, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 250,
    providerOverrides: [provider],
    defaultModel: { provider: "browser-fixture", model: "browser-fixture-model" },
    web: { buildRoot: resolve(process.cwd(), "apps", "web", "dist"), workspace },
  });
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
  await daemon?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
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
