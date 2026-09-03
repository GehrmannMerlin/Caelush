import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const isReadFixture = promptText.includes("read browser fixture");
    const isPatchFixture = promptText.includes("apply browser patch");
    const isRejectFixture = promptText.includes("reject browser patch");
    const isCancelFixture = promptText.includes("cancel browser task");
    const hasToolResult = request.messages.some((message) => message.role === "tool");
    if (!isReview && isReadFixture && !hasToolResult) {
      return readFixtureTool(request, context);
    }
    if (!isReview && (isPatchFixture || isRejectFixture) && !hasToolResult) {
      return patchFixtureTool(request, context);
    }
    if (!isReview && isCancelFixture && !hasToolResult) return waitingFixture(request, context);
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

const browserCode = String.raw`
from playwright.sync_api import sync_playwright
import json
import os
import sys
import textwrap
import urllib.request

url = sys.argv[1]
artifact_directory = sys.argv[2]
workspace = json.loads(sys.argv[3])
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    context.tracing.start(screenshots=True, snapshots=True, sources=True)
    page = context.new_page()
    actions = r"""
    page.goto(url, wait_until="domcontentloaded")
    page.locator("#session-workspace-title").wait_for(state="visible", timeout=15000)
    page.locator("button.new-session-button").click()
    composer = page.locator("textarea.prompt-input")
    composer.fill("read browser fixture")
    page.locator("button.prompt-submit-button").click()
    page.get_by_text("Verified browser result.", exact=True).wait_for(state="visible", timeout=15000)
    page.locator(".timeline-entry-title").filter(has_text="读取文件").wait_for(state="visible")
    page.locator(".timeline-entry-path").filter(has_text="fixture.txt").wait_for(state="visible")
    assert page.locator(".session-list-meta").count() == 0
    assert page.locator(".session-status-icon").count() >= 1
    assert page.locator('.session-status-icon[aria-label="已完成"]').count() == 1
    page.reload(wait_until="domcontentloaded")
    page.locator(".session-list-title").filter(has_text="read browser fixture").click()
    page.get_by_text("Verified browser result.", exact=True).wait_for(state="visible", timeout=15000)
    page.locator("button.new-session-button").click()
    page.locator("textarea.prompt-input").fill("apply browser patch")
    page.locator("button.prompt-submit-button").click()
    page.get_by_text("需要审批", exact=True).wait_for(state="visible", timeout=15000)
    page.reload(wait_until="domcontentloaded")
    page.locator(".session-list-title").filter(has_text="apply browser patch").click()
    page.locator(".approval-card").wait_for(state="visible", timeout=15000)
    page.locator("button.approval-action--approve_once").click()
    page.get_by_text("Verified browser result.", exact=True).last.wait_for(state="visible", timeout=15000)
    page.locator(".timeline-entry-title").filter(has_text="修改文件").last.wait_for(state="visible")
    page.get_by_text("Verification passed.", exact=True).last.wait_for(state="visible")
    page.locator("li.session-list-item").filter(has_text="apply browser patch").locator('.session-status-icon[aria-label="已完成"]').wait_for(state="visible", timeout=15000)
    page.locator("button.new-session-button").click()
    page.locator("textarea.prompt-input").fill("reject browser patch")
    page.locator("button.prompt-submit-button").click()
    page.get_by_text("需要审批", exact=True).wait_for(state="visible", timeout=15000)
    page.locator("button.approval-action--reject").click()
    page.get_by_text("需要审批", exact=True).wait_for(state="hidden", timeout=15000)
    page.get_by_text("Verified browser result.", exact=True).last.wait_for(state="visible", timeout=15000)
    page.locator("li.session-list-item").filter(has_text="reject browser patch").locator('.session-status-icon[aria-label="已完成"]').wait_for(state="visible", timeout=15000)
    page.locator("button.new-session-button").click()
    page.locator("textarea.prompt-input").fill("cancel browser task")
    page.locator("button.prompt-submit-button").click()
    page.locator("button.cancel-button").wait_for(state="visible", timeout=15000)
    page.locator("button.cancel-button").click()
    page.locator('.session-status-icon[aria-label="已取消"]').last.wait_for(state="visible", timeout=15000)
    def post_json(path, payload):
        request = urllib.request.Request(
            url.rstrip("/") + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    session = post_json(
        "/api/v1/sessions",
        {
            "title": "pending browser task",
            "defaultWorkspace": workspace,
            "defaultModel": {"provider": "browser-fixture", "model": "browser-fixture-model"},
            "metadata": {},
        },
    )
    post_json(
        "/api/v1/sessions/" + session["id"] + "/runs",
        {
            "goal": "pending browser task",
            "workspace": workspace,
            "model": {"provider": "browser-fixture", "model": "browser-fixture-model"},
            "runtime": {"id": "local", "kind": "local"},
            "permissionProfile": "PROJECT_ACCESS",
            "approvalPolicy": "DANGEROUS_ONLY",
            "limits": {"maxSteps": 8, "maxToolCalls": 8, "timeoutMs": 10000},
        },
    )
    page.reload(wait_until="domcontentloaded")
    page.locator(".session-list-title").filter(has_text="pending browser task").click()
    page.locator(".recovery-panel").wait_for(state="visible", timeout=15000)
    page.locator(".recovery-run button").click()
    page.get_by_text("Verified browser result.", exact=True).last.wait_for(state="visible", timeout=15000)
    page.locator("li.session-list-item").filter(has_text="pending browser task").locator('.session-status-icon[aria-label="已完成"]').wait_for(state="visible", timeout=15000)
    page.set_viewport_size({"width": 375, "height": 812})
    page.locator(".sidebar-toggle-button").click()
    assert page.locator(".sidebar-toggle-button").get_attribute("aria-expanded") == "true"
    page.locator(".sidebar-close-button").click()
    assert page.locator(".sidebar-toggle-button").get_attribute("aria-expanded") == "false"
    body = page.locator("body").inner_text()
    assert "cancel browser task" in body
    assert "Inspector" not in body
    assert "Terminal" not in body
    assert "stdout" not in body
    """
    try:
        exec(textwrap.dedent(actions))
    except BaseException:
        os.makedirs(artifact_directory, exist_ok=True)
        page.screenshot(path=os.path.join(artifact_directory, "failure.png"), full_page=True)
        context.tracing.stop(path=os.path.join(artifact_directory, "failure.zip"))
        raise
    else:
        context.tracing.stop()
    browser.close()
`;

const directory = await mkdtemp(join(tmpdir(), "caelush-web-browser-"));
const workspace = createWorkspaceRef(directory);
const browserArtifacts = join(process.cwd(), "test-results", "web-session-browser-smoke");
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
  await writeFile(join(directory, "fixture.txt"), "browser fixture\n", "utf8");
  await rm(browserArtifacts, { recursive: true, force: true });
  const result = await runBrowserSmoke(`${daemon.url}/`, browserArtifacts, workspace);
  if (result !== 0) process.exitCode = result;
} finally {
  await daemon?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

function runBrowserSmoke(url, artifactDirectory, workspace) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "python",
      ["-c", browserCode, url, artifactDirectory, JSON.stringify(workspace)],
      {
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}
