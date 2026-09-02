import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

const browserCode = String.raw`
from playwright.sync_api import sync_playwright
import sys

url = sys.argv[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(url, wait_until="domcontentloaded")
    page.locator("#session-workspace-title").wait_for(state="visible", timeout=15000)
    page.locator("button.new-session-button").click()
    composer = page.locator("textarea.prompt-input")
    composer.fill("complete browser task")
    page.locator("button.prompt-submit-button").click()
    page.get_by_text("Verified browser result.", exact=True).wait_for(state="visible", timeout=15000)
    page.reload(wait_until="domcontentloaded")
    page.locator(".session-list-title").filter(has_text="complete browser task").click()
    page.get_by_text("Verified browser result.", exact=True).wait_for(state="visible", timeout=15000)
    body = page.locator("body").inner_text()
    assert "Verified browser result." in body
    assert "Inspector" not in body
    browser.close()
`;

const directory = await mkdtemp(join(tmpdir(), "caelush-web-browser-"));
const workspace = createWorkspaceRef(directory);
let daemon;
try {
  daemon = await startDaemon({
    databasePath: join(directory, "caelush.db"),
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerOverrides: [provider],
    defaultModel: { provider: "browser-fixture", model: "browser-fixture-model" },
    web: { buildRoot: resolve(process.cwd(), "apps", "web", "dist"), workspace },
  });
  const result = await runBrowserSmoke(`${daemon.url}/`);
  if (result !== 0) process.exitCode = result;
} finally {
  await daemon?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

function runBrowserSmoke(url) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("python", ["-c", browserCode, url], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}
