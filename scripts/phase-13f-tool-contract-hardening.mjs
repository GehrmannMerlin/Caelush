import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runtimeProcess = globalThis.process;
const providerId = runtimeProcess.env.CAELUSH_PROVIDER_ID ?? "deepseek";
const apiKey = runtimeProcess.env.CAELUSH_PROVIDER_API_KEY ?? runtimeProcess.env.DEEPSEEK_API_KEY;
const configuredBaseUrl =
  runtimeProcess.env.CAELUSH_PROVIDER_BASE_URL ?? runtimeProcess.env.DEEPSEEK_BASE_URL;
const configuredModel =
  runtimeProcess.env.CAELUSH_DEFAULT_MODEL ?? runtimeProcess.env.DEEPSEEK_MODEL;
const baseUrl = configuredBaseUrl ?? "https://api.deepseek.com";
const modelId = configuredModel ?? "deepseek-v4-flash";

function safeError(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNCLASSIFIED_ERROR";
}

function environmentPresence() {
  return {
    CAELUSH_PROVIDER_ID:
      runtimeProcess.env.CAELUSH_PROVIDER_ID === undefined ? "MISSING" : "PRESENT",
    CAELUSH_PROVIDER_BASE_URL: configuredBaseUrl === undefined ? "MISSING" : "PRESENT",
    CAELUSH_PROVIDER_API_KEY: apiKey === undefined ? "MISSING" : "PRESENT",
    CAELUSH_DEFAULT_MODEL: configuredModel === undefined ? "MISSING" : "PRESENT",
  };
}

async function createWorkspace(taskName) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-13f-"));
  const workspace = path.join(parent, "workspace");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        name: `phase-13f-${taskName}`,
        private: true,
        scripts: { test: "node -e \"console.log('fixture tests passed')\"" },
        dependencies: { "fixture-runtime": "1.2.3" },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(path.join(workspace, "README.md"), "Phase 13F bounded fixture.\n", "utf8");
  await writeFile(path.join(workspace, "src", "answer.ts"), "export const answer = 42;\n", "utf8");
  await writeFile(
    path.join(workspace, "src", "notes.md"),
    "native tools should inspect this.\n",
    "utf8",
  );
  await mkdir(path.join(workspace, "tests", "obsolete-fixture"), { recursive: true });
  await writeFile(
    path.join(workspace, "tests", "obsolete-fixture", "marker.txt"),
    "remove me\n",
    "utf8",
  );
  return { parent, workspace };
}

async function runTask({ taskName, goal, prepare }) {
  const [protocol, eventsPackage, storagePackage, daemonPackage] = await Promise.all([
    import("../packages/protocol/dist/index.js"),
    import("../packages/events/dist/index.js"),
    import("../packages/storage/dist/index.js"),
    import("../apps/daemon/dist/daemon-composition.js"),
  ]);
  const fixture = await createWorkspace(taskName);
  if (prepare !== undefined) await prepare(fixture.workspace);
  const storage = await storagePackage.openCaelushStorage({ path: ":memory:" });
  const eventBus = new eventsPackage.EventBus(storage.events);
  const composition = daemonPackage.composeDaemon({
    storage,
    eventBus,
    providers: [
      {
        provider: providerId,
        baseUrl,
        apiKey,
        allowedModels: [modelId],
      },
    ],
    defaultModel: { provider: providerId, model: modelId },
    toolExposure: { git: "UNAVAILABLE" },
    toolCallingDebugWriter:
      runtimeProcess.env.CAELUSH_DEBUG_TOOL_CALLING === "1"
        ? (event) =>
            runtimeProcess.stderr.write(`[caelush:tool-calling] ${JSON.stringify(event)}\n`)
        : undefined,
  });
  const run = protocol.AgentRunSchema.parse({
    id: protocol.createRunId(),
    sessionId: protocol.createSessionId(),
    goal,
    status: "PENDING",
    workspace: { id: protocol.createWorkspaceId(), path: fixture.workspace },
    model: { provider: providerId, model: modelId },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 10, maxToolCalls: 24, timeoutMs: 120_000 },
    createdAt: protocol.createTimestampMs(Date.now()),
  });
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: protocol.createTimestampMs(Date.now()),
    updatedAt: protocol.createTimestampMs(Date.now()),
    metadata: {},
  });
  await storage.runs.insert(run);

  try {
    let result = await composition.controller.start(run.id);
    let approvalCount = 0;
    while (result.status === "WAITING_APPROVAL" && approvalCount < 8) {
      const pending = await storage.approvals.listPendingByRun(run.id);
      const approval = pending[0];
      if (approval === undefined) break;
      approvalCount += 1;
      result = await composition.controller.resolveApproval(run.id, approval.id, {
        action: "APPROVE",
        scope: approval.scope,
      });
    }
    const invocations = await storage.toolInvocations.listByRun(run.id);
    const durableEvents = await storage.events.replay(run.id, { limit: 512 });
    const failureKeys = new Map();
    for (const invocation of invocations) {
      if (invocation.status !== "FAILED") continue;
      const key = `${invocation.toolName}:${JSON.stringify(invocation.args)}:${invocation.error?.code ?? ""}`;
      failureKeys.set(key, (failureKeys.get(key) ?? 0) + 1);
    }
    const repeatedFailureCount = [...failureKeys.values()]
      .map((count) => Math.max(0, count - 1))
      .reduce((sum, count) => sum + count, 0);
    const toolInvocations = invocations.map((invocation) => ({
      toolName: invocation.toolName,
      status: invocation.status,
      errorCode: invocation.error?.code,
    }));
    const deletionVerified =
      taskName !== "dangerous-delete-approval"
        ? undefined
        : await access(path.join(fixture.workspace, "tests", "obsolete-fixture"))
            .then(() => false)
            .catch(() => true);
    return {
      task: taskName,
      status: result.status,
      llmTurns: durableEvents.filter((event) => event.type === "llm.started").length,
      approvalRequests: durableEvents.filter((event) => event.type === "approval.requested").length,
      toolInvocations,
      assertions: {
        usedListDirectory: invocations.some((item) => item.toolName === "list_directory"),
        usedReadFile: invocations.some((item) => item.toolName === "read_file"),
        readPackageJson: invocations.some(
          (item) => item.toolName === "read_file" && item.args.path === "package.json",
        ),
        usedExecCommand: invocations.some((item) => item.toolName === "exec_command"),
        repeatedFailureCount,
        ...(deletionVerified === undefined ? {} : { deletionVerified }),
      },
      exposedTools: composition.toolRegistry.names(),
    };
  } catch (error) {
    return { task: taskName, status: "ERROR", errorCode: safeError(error) };
  } finally {
    await composition.dispose().catch(() => undefined);
    await storage.close().catch(() => undefined);
    await rm(fixture.parent, { recursive: true, force: true });
  }
}

async function runDeletionTask() {
  const result = await runTask({
    taskName: "dangerous-delete-approval",
    goal: "Delete only the directory tests/obsolete-fixture. Use the appropriate mutation or shell Tool. The operation is destructive, so it must pass through the approval boundary before execution. Do not delete anything else.",
  });
  return result;
}

if (apiKey === undefined || apiKey.length === 0) {
  globalThis.console.log(
    JSON.stringify({
      status: "SKIPPED",
      reason: "CAELUSH_PROVIDER_API_KEY_MISSING",
      env: environmentPresence(),
      configuredModel: modelId,
    }),
  );
} else {
  const results = [];
  results.push(
    await runTask({
      taskName: "workspace-structure",
      goal: "Scan this workspace and report its project structure. Use list_directory and find_files or read_file as needed. Do not use a shell command for inspection.",
    }),
  );
  results.push(
    await runTask({
      taskName: "dependency-analysis",
      goal: "Analyze the project dependencies. Read package.json with read_file and report the dependency names and versions. Do not use bash, cat, or exec_command for this task.",
    }),
  );
  results.push(
    await runTask({
      taskName: "test-execution",
      goal: "Run the project's tests and report the result. Use exec_command with the package test command; do not claim test results from reading files.",
    }),
  );
  results.push(await runDeletionTask());
  globalThis.console.log(
    JSON.stringify({ status: "COMPLETED", env: environmentPresence(), results }),
  );
}
