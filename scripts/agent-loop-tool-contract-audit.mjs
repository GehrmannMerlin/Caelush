import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const runCommand = promisify(execFile);
const runtimeProcess = globalThis.process;
const apiKey = runtimeProcess.env.DEEPSEEK_API_KEY;
const configuredBaseUrl = runtimeProcess.env.DEEPSEEK_BASE_URL;
const configuredModel = runtimeProcess.env.DEEPSEEK_MODEL;
const baseUrl = configuredBaseUrl ?? "https://api.deepseek.com/v1";
const modelId = configuredModel ?? "deepseek-chat";

function safeError(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNCLASSIFIED_ERROR";
}

async function createWorkspace(isGit) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-agent-loop-audit-"));
  const workspace = path.join(parent, "workspace");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "This fixture is for a read-only audit.\n", "utf8");
  await writeFile(path.join(workspace, "src", "answer.ts"), "export const answer = 42;\n", "utf8");
  if (isGit) {
    await runCommand("git", ["init", "-q"], { cwd: workspace });
    await runCommand("git", ["config", "user.email", "audit@example.invalid"], { cwd: workspace });
    await runCommand("git", ["config", "user.name", "Caelush Audit"], { cwd: workspace });
    await runCommand("git", ["add", "."], { cwd: workspace });
    await runCommand("git", ["commit", "-qm", "audit fixture"], { cwd: workspace });
  }
  return { parent, workspace };
}

async function runCase({ isGit }) {
  const [{ AgentRunSchema, createRunId, createSessionId, createTimestampMs, createWorkspaceId }, { EventBus }, { openCaelushStorage }, { composeDaemon }] = await Promise.all([
    import("@caelush/protocol"),
    import("@caelush/events"),
    import("@caelush/storage"),
    import("../apps/daemon/dist/daemon-composition.js"),
  ]);
  const fixture = await createWorkspace(isGit);
  const storage = await openCaelushStorage({ path: ":memory:" });
  const eventBus = new EventBus(storage.events);
  const composition = composeDaemon({
    storage,
    eventBus,
    providers: [{ provider: "deepseek", baseUrl, apiKey, allowedModels: [modelId] }],
    defaultModel: { provider: "deepseek", model: modelId },
    toolExposure: { git: isGit ? "AVAILABLE" : "UNAVAILABLE" },
  });
  const run = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "Inspect this workspace read-only. Use evidence from the available native tools and stop within twelve model turns.",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: fixture.workspace },
    model: { provider: "deepseek", model: modelId },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 12, maxToolCalls: 24, timeoutMs: 120_000 },
    createdAt: createTimestampMs(Date.now()),
  });
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: createTimestampMs(Date.now()),
    updatedAt: createTimestampMs(Date.now()),
    metadata: {},
  });
  await storage.runs.insert(run);
  try {
    const result = await composition.controller.start(run.id);
    const events = await storage.events.replay(run.id, { limit: 256 });
    const invocations = await storage.toolInvocations.listByRun(run.id);
    return {
      workspace: isGit ? "GIT" : "NON_GIT",
      exposedTools: composition.toolRegistry.names(),
      status: result.status,
      llmTurns: events.filter((event) => event.type === "llm.started").length,
      toolInvocations: invocations.map((invocation) => ({
        toolName: invocation.toolName,
        status: invocation.status,
      })),
    };
  } catch (error) {
    return { workspace: isGit ? "GIT" : "NON_GIT", errorCode: safeError(error) };
  } finally {
    await composition.dispose().catch(() => undefined);
    await storage.close().catch(() => undefined);
    await rm(fixture.parent, { recursive: true, force: true });
  }
}

if (apiKey === undefined || apiKey.length === 0) {
  globalThis.console.log(JSON.stringify({
    status: "SKIPPED",
    reason: "DEEPSEEK_API_KEY_MISSING",
    env: { DEEPSEEK_API_KEY: "MISSING", DEEPSEEK_BASE_URL: configuredBaseUrl === undefined ? "MISSING" : "PRESENT", DEEPSEEK_MODEL: configuredModel === undefined ? "MISSING" : "PRESENT" },
  }));
} else {
  const results = [];
  for (const isGit of [true, false]) results.push(await runCase({ isGit }));
  globalThis.console.log(JSON.stringify({
    status: "COMPLETED",
    env: { DEEPSEEK_API_KEY: "PRESENT", DEEPSEEK_BASE_URL: configuredBaseUrl === undefined ? "MISSING" : "PRESENT", DEEPSEEK_MODEL: configuredModel === undefined ? "MISSING" : "PRESENT" },
    results,
  }));
}
