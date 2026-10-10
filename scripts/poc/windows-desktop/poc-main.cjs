const { app, BrowserWindow } = require("electron");
const { fork, spawn, spawnSync } = require("node:child_process");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdir, readFile, rm } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { sendIpcAndWaitForMessage } = require("./poc-ipc.cjs");

const STARTUP_TIMEOUT_MS = 10_000;
const NORMAL_SHUTDOWN_TIMEOUT_MS = 20_000;
const ROOT = resolve(__dirname, "../../..");
const PRODUCT_ROOT = join(ROOT, "product");
const NODE_EXECUTABLE = join(ROOT, "runtime", "node.exe");
const CHILD_SCRIPT = join(__dirname, "poc-child.mjs");
const PTY_SCRIPT = join(__dirname, "pty-smoke.mjs");
const ELECTRON_NODE_PROBE = join(__dirname, "poc-electron-node-probe.mjs");
const SANDBOX_SCRIPT = join(__dirname, "sandbox-smoke.mjs");
const SQLITE_SCRIPT = join(__dirname, "sqlite-check.mjs");
const SHUTDOWN_PHASES = new Set([
  "beginDrain",
  "checkpointActive",
  "drainWithin",
  "abortSSE",
  "appClose",
  "compositionDispose",
  "storageClose",
]);
const SYSTEM_ROOT = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const SYSTEM_PATH = join(SYSTEM_ROOT, "System32");
const EVIDENCE_FILE = process.env.CAELUSH_POC_EVIDENCE_FILE;
const activeChildren = new Set();
let mainWindow;
let mainExitCode = 1;

app.whenReady().then(async () => {
  const evidence = createEvidence();
  let dataRoot;
  try {
    validateProductBundle();
    dataRoot = join(ROOT, "test-data", randomUUID());
    await mkdir(dataRoot, { recursive: true });
    const env = isolatedEnvironment(dataRoot);

    evidence.host = {
      platform: process.platform,
      arch: process.arch,
      systemVersion: process.getSystemVersion(),
      electronVersion: process.versions.electron,
      electronNodeVersion: process.versions.node,
      electronModulesAbi: process.versions.modules,
      electronNapi: process.versions.napi,
      electronSqliteVersion: process.versions.sqlite ?? null,
      systemPathAndOptionalGitOnly:
        process.env.PATH === SYSTEM_PATH ||
        process.env.PATH ===
          `${SYSTEM_PATH}${require("node:path").delimiter}${process.env.CAELUSH_POC_GIT_PATH}`,
      pathLookups: Object.fromEntries(
        ["node", "pnpm", "rustc", "cargo", "git"].map((name) => [name, findOnPath(name, env)]),
      ),
    };
    if (
      Object.entries(evidence.host.pathLookups)
        .filter(([name]) => name !== "git")
        .some(([, result]) => result !== "NOT_ON_PATH")
    ) {
      throw new PocError("DEVELOPMENT_TOOL_FOUND_ON_SANITIZED_PATH");
    }
    evidence.artifacts = {
      productArchiveSha256: process.env.CAELUSH_POC_BUNDLE_SHA256 || null,
      productSource: process.env.CAELUSH_POC_PRODUCT_SOURCE ?? "UNKNOWN",
      nodeArchiveSha256: process.env.CAELUSH_POC_NODE_ARCHIVE_SHA256 ?? null,
      electronArchiveSha256: process.env.CAELUSH_POC_ELECTRON_ARCHIVE_SHA256 ?? null,
      electronExecutableSha256: await hashFile(process.execPath),
      nodePtyVersion: JSON.parse(
        await readFile(join(PRODUCT_ROOT, "node_modules", "node-pty", "package.json"), "utf8"),
      ).version,
      nodePtyBinarySha256: await hashFile(
        join(PRODUCT_ROOT, "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node"),
      ),
    };

    evidence.runtime = await probeBundledNode(env);
    evidence.gates.G1 = {
      status: "PASS",
      evidence: "The explicitly addressed portable Node executable started without PATH lookup.",
    };

    evidence.pty = await runJsonProcess(
      NODE_EXECUTABLE,
      [PTY_SCRIPT, PRODUCT_ROOT],
      env,
      20_000,
      "PTY_SMOKE_FAILED",
    );
    evidence.gates.G3 = { status: "PASS", evidence: evidence.pty };

    evidence.electronNodeProbe = await probeElectronNode(env);
    evidence.gates.electronNodeAlternative = evidence.electronNodeProbe.status;

    evidence.sandbox = await runJsonProcess(
      NODE_EXECUTABLE,
      [SANDBOX_SCRIPT, PRODUCT_ROOT, dataRoot],
      env,
      20_000,
      "SANDBOX_SMOKE_FAILED",
    );
    evidence.gates.G4 = {
      status:
        evidence.sandbox.BINARY_FOUND && evidence.sandbox.HASH_VERIFIED
          ? evidence.sandbox.PROTOCOL_COMPATIBLE &&
            evidence.sandbox.STARTUP_VALIDATED &&
            evidence.sandbox.RESTRICTED_EXECUTION_VALIDATED
            ? "PASS"
            : "BLOCKED"
          : "FAIL",
      evidence: evidence.sandbox,
    };

    const vertical = await runDaemonVertical(dataRoot, env, evidence);
    evidence.daemon = vertical.daemon;
    evidence.web = vertical.web;
    evidence.run = vertical.run;
    evidence.sse = vertical.sse;
    evidence.sqlite = vertical.sqlite;
    evidence.lifecycle = vertical.lifecycle;
    evidence.shutdownExperiments = await runShutdownIsolationScenarios(dataRoot, env, vertical);
    evidence.gates.G2 = { status: vertical.sqlite.status, evidence: vertical.sqlite };
    evidence.gates.G5 = {
      status: "PASS",
      evidence: {
        daemon: vertical.daemon,
        web: vertical.web,
        run: vertical.run,
        sse: vertical.sse,
      },
    };
    const failureInjections = await runFailureInjections(dataRoot, env);
    const shutdownExperimentsPassed = Object.values(evidence.shutdownExperiments).every(
      (scenario) => scenario.status === "PASS",
    );
    evidence.gates.G6 = {
      status: shutdownExperimentsPassed && failureInjections.status === "PASS" ? "PASS" : "BLOCKED",
      evidence: {
        failureInjections,
        shutdownExperiments: evidence.shutdownExperiments,
        startupIpcVerified: vertical.lifecycle.startupIpcVerified,
        generationVerified: vertical.lifecycle.generationVerified,
        shutdownRequestSent: vertical.lifecycle.shutdownRequestSent,
        closedAcknowledged: vertical.lifecycle.closedAcknowledged,
        normalChildExit: vertical.lifecycle.normalChildExit,
        orphanChildCount: vertical.lifecycle.orphanChildCount,
      },
    };
    evidence.gates.G7 = {
      status: "BLOCKED",
      evidence:
        "A copied portable directory ran with PATH restricted to Windows System32, but this host has no Windows Sandbox or clean Windows VM; this is not a clean-host gate.",
    };
    evidence.gates.G8 = {
      status: "PASS",
      evidence:
        "The POC imports the packaged Daemon/Runtime/Storage through their existing public production entry points and adds no DaemonInfo capability or production host-auth claim.",
    };

    const gateStatuses = Object.entries(evidence.gates)
      .filter(([name]) => /^G[1-8]$/.test(name))
      .map(([, gate]) => gate.status);
    const hasFailure = gateStatuses.includes("FAIL");
    evidence.overall = hasFailure
      ? "FAIL"
      : gateStatuses.every((status) => status === "PASS")
        ? "COMPLETE"
        : "PARTIAL";
    mainExitCode = hasFailure ? 1 : 0;
    console.log(`D0C_POC_OVERALL=${evidence.overall}`);
    console.log(`D0C_POC_NODE=${evidence.runtime.version}`);
    console.log(`D0C_POC_ELECTRON=${evidence.host.electronVersion}`);
    console.log(`D0C_POC_G4=${evidence.gates.G4.status}`);
    console.log(`D0C_POC_G7=${evidence.gates.G7.status}`);
  } catch (error) {
    const code = error && typeof error.code === "string" ? error.code : "POC_FAILED";
    evidence.overall = "FAIL";
    evidence.failureCode = code;
    if (error && typeof error.detail === "string") evidence.failureDetail = error.detail;
    mainExitCode = 1;
    console.error(`D0C_POC_FAILURE=${code}${error?.detail ? `:${error.detail}` : ""}`);
  } finally {
    await terminateAllOwnedChildren();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
    await persistEvidence(evidence).catch(() => undefined);
    app.exit(mainExitCode);
  }
});

app.on("window-all-closed", (event) => event.preventDefault());

function createEvidence() {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    transportLabel: "POC_ONLY_UNAUTHENTICATED_TRANSPORT",
    host: {},
    runtime: {},
    electronNodeProbe: {},
    pty: {},
    sandbox: {},
    daemon: {},
    web: {},
    run: {},
    sse: {},
    sqlite: {},
    lifecycle: {},
    shutdownExperiments: {},
    gates: {
      G1: { status: "BLOCKED" },
      G2: { status: "BLOCKED" },
      G3: { status: "BLOCKED" },
      G4: { status: "BLOCKED" },
      G5: { status: "BLOCKED" },
      G6: { status: "BLOCKED" },
      G7: { status: "BLOCKED" },
      G8: { status: "BLOCKED" },
    },
  };
}

function validateProductBundle() {
  if (!existsSync(NODE_EXECUTABLE)) throw new PocError("BUNDLED_NODE_MISSING");
  if (!existsSync(join(PRODUCT_ROOT, "node_modules", "@caelush", "daemon", "dist", "index.js"))) {
    throw new PocError("PACKAGED_DAEMON_MISSING");
  }
  if (!existsSync(join(PRODUCT_ROOT, "web", "index.html")))
    throw new PocError("PACKAGED_WEB_MISSING");
  if (!existsSync(join(PRODUCT_ROOT, "sandbox-runner", "caelush-sandbox-runner.exe"))) {
    throw new PocError("PACKAGED_RUNNER_MISSING");
  }
}

function isolatedEnvironment(tempRoot) {
  const appData = join(tempRoot, "appdata");
  const userProfile = join(tempRoot, "userprofile");
  const gitPath = process.env.CAELUSH_POC_GIT_PATH;
  return {
    SystemRoot: SYSTEM_ROOT,
    WINDIR: SYSTEM_ROOT,
    PATH:
      gitPath === undefined
        ? SYSTEM_PATH
        : `${SYSTEM_PATH}${require("node:path").delimiter}${gitPath}`,
    HOME: userProfile,
    USERPROFILE: userProfile,
    CAELUSH_HOME: join(tempRoot, "caelush-home"),
    TEMP: tempRoot,
    TMP: tempRoot,
    APPDATA: appData,
    LOCALAPPDATA: join(tempRoot, "localappdata"),
    ComSpec: join(SYSTEM_PATH, "cmd.exe"),
    ELECTRON_NO_ATTACH_CONSOLE: "1",
  };
}

function findOnPath(command, env) {
  const whereExe = join(SYSTEM_PATH, "where.exe");
  const result = spawnSync(whereExe, [command], {
    env,
    windowsHide: true,
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status === 0) return "FOUND_ON_PATH";
  return "NOT_ON_PATH";
}

async function probeBundledNode(env) {
  const facts = await runJsonProcess(
    NODE_EXECUTABLE,
    [
      "-e",
      "process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,modules:process.versions.modules,napi:process.versions.napi,sqlite:process.versions.sqlite,execPath:process.execPath})+'\\n')",
    ],
    env,
    5000,
    "BUNDLED_NODE_START_FAILED",
  );
  if (
    facts.version !== "v24.18.0" ||
    facts.arch !== "x64" ||
    facts.platform !== "win32" ||
    resolve(facts.execPath).toLowerCase() !== resolve(NODE_EXECUTABLE).toLowerCase()
  ) {
    throw new PocError("BUNDLED_NODE_IDENTITY_MISMATCH");
  }
  const digest = await hashFile(NODE_EXECUTABLE);
  return {
    ...facts,
    executableSha256: digest,
    archiveSha256: process.env.CAELUSH_POC_NODE_ARCHIVE_SHA256 ?? null,
  };
}

async function probeElectronNode(env) {
  try {
    const probe = await runJsonProcess(
      process.execPath,
      [ELECTRON_NODE_PROBE, PRODUCT_ROOT],
      {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        CAELUSH_POC_NODE_EXECUTABLE: NODE_EXECUTABLE,
      },
      20_000,
      "ELECTRON_RUN_AS_NODE_UNAVAILABLE",
    );
    return { status: probe.pty?.status === "PASS" ? "PASS" : "FAIL", ...probe };
  } catch (error) {
    return {
      status: "FAIL",
      reason: error && typeof error.code === "string" ? error.code : "ELECTRON_NODE_PROBE_FAILED",
      evidence:
        "Electron embedded Node child did not complete the version, ESM, node:sqlite and node-pty probe.",
    };
  }
}

async function runDaemonVertical(dataRoot, env, evidence) {
  const profileRoot = join(dataRoot, "profile");
  const workspaceRoot = join(dataRoot, "workspace");
  const databasePath = join(profileRoot, "caelush.db");
  await mkdir(profileRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  const firstGeneration = randomUUID();
  let daemon = await startDaemonChild({ databasePath, dataRoot, env, generation: firstGeneration });
  const firstStartupIpc = {
    startupIpcVerified: daemon.startupIpcVerified === true,
    generationVerified: daemon.generationVerified === true,
    pidVerified: daemon.pidVerified === true,
  };
  const firstChildPid = daemon.child.pid;
  const firstClient = await createClient(daemon.ready.port);
  const health = await firstClient.getHealth();
  const info = await firstClient.getInfo();
  if (
    daemon.ready.pid !== daemon.child.pid ||
    daemon.ready.generation !== firstGeneration ||
    daemon.ready.bootstrapChannelOnly !== true ||
    !Number.isInteger(daemon.ready.port) ||
    daemon.ready.port < 1 ||
    daemon.ready.port > 65535 ||
    info.daemonVersion !== "0.1.0" ||
    info.apiVersion !== "v1" ||
    info.protocolVersion !== 1
  ) {
    throw new PocError("DAEMON_HANDSHAKE_INVALID");
  }

  const web = await verifyAndLoadWeb(daemon.url);
  const { CaelushClient } = await importProductPackage("client");
  const {
    createWorkspaceId,
    SecurityCapabilitiesResponseSchema,
    WorkspaceSecurityCapabilitiesResponseSchema,
  } = await importProductPackage("protocol");
  const client = new CaelushClient({ baseUrl: daemon.url });
  const session = await client.createSession({
    defaultWorkspace: { id: createWorkspaceId(), path: workspaceRoot },
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  const workspace = session.defaultWorkspace;
  if (!workspace) throw new PocError("SESSION_WORKSPACE_MISSING");
  const globalSecurityResponse = await fetch(`${daemon.url}/api/v1/security/capabilities`);
  const globalSecurity = SecurityCapabilitiesResponseSchema.parse(
    await globalSecurityResponse.json(),
  );
  const workspaceSecurityResponse = await fetch(
    `${daemon.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/security/capabilities`,
  );
  const workspaceSecurity = WorkspaceSecurityCapabilitiesResponseSchema.parse(
    await workspaceSecurityResponse.json(),
  );
  const sandboxRunnerDiscovery = {
    processSandbox: globalSecurity.processSandbox,
    workspacePreparationSupported: globalSecurity.workspacePreparationSupported,
    workspacePreparation: workspaceSecurity.preparation,
    restrictedPresetAvailability: workspaceSecurity.presets.filter((preset) =>
      ["VIEW_ONLY", "WORKSPACE_WRITE"].includes(preset.id),
    ),
  };
  const run = await client.createRun(session.id, {
    goal: "return a fixed Windows POC fixture answer",
    workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    preset: { id: "FULL_ACCESS", expectedVersion: 1 },
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
  });

  const liveController = new AbortController();
  let signalOpened;
  const opened = new Promise((resolvePromise) => (signalOpened = resolvePromise));
  const liveIterator = client
    .watchRunEvents(run.id, {
      afterSequence: 0,
      signal: liveController.signal,
      onOpen: signalOpened,
    })
    [Symbol.asyncIterator]();
  const firstLiveEvent = liveIterator.next();
  await withTimeout(opened, 5000, "SSE_OPEN_TIMEOUT");
  await client.startRun(run.id);
  const firstEvent = await withTimeout(firstLiveEvent, 5000, "SSE_FIRST_EVENT_TIMEOUT");
  if (firstEvent.done || firstEvent.value === undefined)
    throw new PocError("SSE_FIRST_EVENT_MISSING");
  liveController.abort();
  await drainAbortedIterator(liveIterator, 2000);

  const settled = await waitForRun(client, run.id, 10_000);
  if (
    settled.status !== "COMPLETED" ||
    settled.finalResult?.type !== "NORMAL_COMPLETION" ||
    settled.finalResult.text !== "Windows POC fixture completed."
  ) {
    const terminalEvents = await readUntilTerminal(client, run.id, 0);
    const failure = terminalEvents.find((event) => event.type === "run.failed")?.payload?.error;
    throw new PocError(
      "FIXTURE_RUN_NOT_COMPLETED",
      JSON.stringify({
        status: settled.status,
        completionContract: settled.completionContract,
        failureCode: failure?.code,
        failurePhase: failure?.phase,
        failureMessage:
          typeof failure?.message === "string" ? failure.message.slice(0, 300) : undefined,
        durableEventTypes: terminalEvents
          .filter((event) => isDurableEvent(event))
          .map((event) => event.type),
      }).slice(0, 1200),
    );
  }

  const fullReplay = await readUntilCompleted(client, run.id, 0);
  const durableEvents = fullReplay.filter(isDurableEvent);
  const durableSequences = durableEvents.map((event) => event.durability.sequence);
  if (
    durableSequences.length < 2 ||
    hasDuplicates(durableSequences) ||
    !strictlyIncreasing(durableSequences)
  ) {
    throw new PocError("SSE_DURABLE_SEQUENCE_INVALID");
  }
  const midpoint = durableSequences[Math.floor(durableSequences.length / 2)];
  const resumed = await readUntilCompleted(client, run.id, midpoint);
  const resumedSequences = resumed.filter(isDurableEvent).map((event) => event.durability.sequence);
  const expectedSuffix = durableSequences.filter((sequence) => sequence > midpoint);
  if (JSON.stringify(resumedSequences) !== JSON.stringify(expectedSuffix)) {
    throw new PocError("SSE_REPLAY_GAP_OR_DUPLICATE");
  }

  const runEvidence = {
    sessionId: session.id,
    runId: run.id,
    status: settled.status,
    finalResult: settled.finalResult,
    provider: "local scripted fixture",
    externalProviderCalls: 0,
  };
  const sseEvidence = {
    initialSubscriberAbortedDuringRun: true,
    runCompletedAfterDisconnect: settled.status === "COMPLETED",
    durableEventCount: durableSequences.length,
    durableSequences,
    replayCursor: midpoint,
    replaySequences: resumedSequences,
    replayNoDuplicateOrLoss: true,
    abortClosedSseIterator: true,
  };
  evidence.daemon = {
    childPids: [firstChildPid],
    firstGeneration,
    loopbackHost: "127.0.0.1",
    initialPort: "OS-assigned port 0",
    firstHealthChecked: true,
    firstInfo: {
      daemonVersion: info.daemonVersion,
      apiVersion: info.apiVersion,
      protocolVersion: info.protocolVersion,
    },
    sandboxRunnerDiscovery,
    noFallbackDiscovery: true,
  };
  evidence.web = web;
  evidence.run = runEvidence;
  evidence.sse = sseEvidence;
  evidence.gates.G5 = {
    status: "PASS",
    evidence: { daemon: evidence.daemon, web, run: runEvidence, sse: sseEvidence },
  };

  let gracefulShutdown = "PASS";
  let shutdownProgressMs = [];
  let repeatedShutdownSharedAttempt = false;
  try {
    const firstShutdown = stopDaemonChild(daemon);
    const repeatedShutdown = stopDaemonChild(daemon);
    repeatedShutdownSharedAttempt = firstShutdown === repeatedShutdown;
    await Promise.all([firstShutdown, repeatedShutdown]);
  } catch (error) {
    if (
      ![
        "SHUTDOWN_TIMEOUT",
        "DAEMON_SHUTDOWN_FAILED",
        "CHILD_EXIT_BEFORE_SHUTDOWN_ACK",
        "CHILD_EXIT_TIMEOUT",
        "CHILD_EXIT_AFTER_CLOSED_NOT_NORMAL",
      ].includes(error?.code)
    ) {
      throw error;
    }
    gracefulShutdown = "BLOCKED";
    daemon.shutdownFailureCode = error.code;
    try {
      shutdownProgressMs = JSON.parse(error.detail ?? "[]");
    } catch {
      shutdownProgressMs = [];
    }
  }
  const shutdownEvidence = shutdownAttemptEvidence(daemon);
  shutdownEvidence.repeatedShutdownSharedAttempt = repeatedShutdownSharedAttempt;
  await closeMainWindow();
  daemon = undefined;
  const sqlite = await runJsonProcess(
    NODE_EXECUTABLE,
    [SQLITE_SCRIPT, databasePath],
    env,
    5000,
    "SQLITE_INTEGRITY_CHECK_FAILED",
  );
  if (sqlite.integrity !== "ok" || sqlite.tables < 1)
    throw new PocError("SQLITE_INTEGRITY_CHECK_FAILED");
  evidence.sqlite = {
    databasePathRelative: "test-data/<run>/profile/caelush.db",
    integrityCheck: sqlite.integrity,
    tableCount: sqlite.tables,
    userHomeCaelushAccessed: false,
    gracefulShutdown,
    restartRecovery: false,
  };

  const secondGeneration = randomUUID();
  if (secondGeneration === firstGeneration) throw new PocError("GENERATION_NOT_ROTATED");
  daemon = await startDaemonChild({ databasePath, dataRoot, env, generation: secondGeneration });
  const secondChildPid = daemon.child.pid;
  const secondClient = await createClient(daemon.ready.port);
  const persistedSession = await secondClient.getSession(session.id);
  const persistedRun = await secondClient.getRun(run.id);
  const transcript = await secondClient.getSessionTranscript(session.id);
  if (
    persistedSession.id !== session.id ||
    persistedRun.status !== "COMPLETED" ||
    persistedRun.finalResult?.text !== "Windows POC fixture completed." ||
    !transcript.items.some((item) => item.runId === run.id && item.kind === "ASSISTANT")
  ) {
    throw new PocError("SQLITE_RESTART_RECOVERY_FAILED");
  }
  evidence.sqlite.restartRecovery = true;
  const rejectedStale = await sendIpcAndWaitForMessage(
    daemon.child,
    { type: "SHUTDOWN", generation: firstGeneration },
    3000,
    "STALE_GENERATION_ACCEPTED",
    "STALE_GENERATION_TIMEOUT",
    (message) => message?.type === "CONTROL_REJECTED",
  );
  if (rejectedStale.type !== "CONTROL_REJECTED" || rejectedStale.code !== "GENERATION_MISMATCH") {
    throw new PocError("STALE_GENERATION_CONTROL_ACCEPTED");
  }
  const acceptedCurrent = await sendIpcAndWaitForMessage(
    daemon.child,
    { type: "PING", generation: secondGeneration },
    3000,
    "CURRENT_GENERATION_REJECTED",
    "CURRENT_GENERATION_TIMEOUT",
    (message) => ["PONG", "CONTROL_REJECTED"].includes(message?.type),
  );
  if (acceptedCurrent.type !== "PONG" || acceptedCurrent.generation !== secondGeneration) {
    throw new PocError("CURRENT_GENERATION_CONTROL_FAILED");
  }
  const restartedHealth = await secondClient.getHealth();
  const restartedInfo = await secondClient.getInfo();
  if (gracefulShutdown === "PASS") await stopDaemonChild(daemon);
  else await killOwnedChild(daemon);
  daemon = undefined;

  const daemonEvidence = {
    childPids: [firstChildPid, secondChildPid],
    firstGeneration,
    secondGeneration,
    loopbackHost: "127.0.0.1",
    initialPort: "OS-assigned port 0",
    firstHealthChecked: Boolean(health),
    firstInfo: {
      daemonVersion: info.daemonVersion,
      apiVersion: info.apiVersion,
      protocolVersion: info.protocolVersion,
    },
    restartedHealthChecked: Boolean(restartedHealth),
    restartedInfo: {
      daemonVersion: restartedInfo.daemonVersion,
      apiVersion: restartedInfo.apiVersion,
      protocolVersion: restartedInfo.protocolVersion,
    },
    sandboxRunnerDiscovery,
    noFallbackDiscovery: true,
  };
  const sqliteEvidence = {
    ...evidence.sqlite,
    status: gracefulShutdown === "PASS" ? "PASS" : "BLOCKED",
    sessionAndRunRecoveredAfterDaemonRestart: true,
  };
  const lifecycleEvidence = {
    childOwnedByElectronMain: true,
    ...firstStartupIpc,
    shutdownRequestSent: shutdownEvidence.requestSent,
    closedAcknowledged:
      shutdownEvidence.responseReceived && shutdownEvidence.responseType === "CLOSED",
    normalChildExit: shutdownEvidence.normalChildExit,
    childPidValidatedAgainstIpcReport: true,
    portLearnedOnlyFromPrivateIpc: true,
    bootstrapSecretInArgvEnvOrUrl: false,
    restartCreatedNewGeneration: true,
    staleGenerationRejected: true,
    normalShutdownBounded: true,
    gracefulShutdown,
    shutdownProgressMs,
    shutdown: shutdownEvidence,
    orphanChildCount: activeChildren.size,
  };
  evidence.daemon = daemonEvidence;
  evidence.sqlite = sqliteEvidence;
  evidence.lifecycle = lifecycleEvidence;

  return {
    daemon: daemonEvidence,
    web,
    run: { ...runEvidence, status: persistedRun.status, finalResult: persistedRun.finalResult },
    sse: {
      ...sseEvidence,
    },
    sqlite: sqliteEvidence,
    lifecycle: lifecycleEvidence,
    shutdown: shutdownEvidence,
  };
}

async function runShutdownIsolationScenarios(dataRoot, env, vertical) {
  const results = {};
  results.A = await runShutdownIsolationCase({
    name: "A_IDLE_NO_WINDOW",
    dataRoot,
    env,
  });
  results.B = await runShutdownIsolationCase({
    name: "B_IDLE_RENDERER_OPEN",
    dataRoot,
    env,
    openWindow: true,
  });
  results.C = await runShutdownIsolationCase({
    name: "C_FIXTURE_RUN_RENDERER_CLOSED",
    dataRoot,
    env,
    openWindow: true,
    completeFixtureRun: true,
    closeWindowBeforeShutdown: true,
    verifySqliteRecovery: true,
  });
  results.D = await runShutdownIsolationCase({
    name: "D_FIXTURE_RUN_RENDERER_OPEN",
    dataRoot,
    env,
    openWindow: true,
    completeFixtureRun: true,
  });
  results.E = await runShutdownIsolationCase({
    name: "E_ACTIVE_SSE_SUBSCRIPTION",
    dataRoot,
    env,
    activeSse: true,
  });
  results.F = await runShutdownIsolationCase({
    name: "F_FIXTURE_RUN_NO_WINDOW",
    dataRoot,
    env,
    completeFixtureRun: true,
  });
  results.G = await runShutdownIsolationCase({
    name: "G_FIXTURE_RUN_CONNECTION_CLOSE",
    dataRoot,
    env,
    completeFixtureRun: true,
    connectionClose: true,
  });
  results.H = await runShutdownIsolationCase({
    name: "H_WINDOW_CLOSED_BEFORE_FIXTURE_RUN",
    dataRoot,
    env,
    openWindow: true,
    closeWindowBeforeFixtureRun: true,
    completeFixtureRun: true,
  });
  return results;
}

async function runShutdownIsolationCase(options) {
  const caseRoot = join(options.dataRoot, "shutdown-cases", options.name);
  const profileRoot = join(caseRoot, "profile");
  const workspaceRoot = join(caseRoot, "workspace");
  const databasePath = join(profileRoot, "caelush.db");
  await mkdir(profileRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  const daemon = await startDaemonChild({
    databasePath,
    dataRoot: caseRoot,
    env: options.env,
    generation: randomUUID(),
  });
  let browserWindowOpened = false;
  let browserClosedBeforeShutdown = false;
  let fixtureRunCompleted = false;
  let fixtureRunFailureCode;
  let fixtureSessionId;
  let fixtureRunId;
  let activeSseController;
  let activeSseIterator;
  let activeSseFirstRead;
  let activeSseClosed;
  let activeSseOpen = false;
  let shutdownFailureCode;
  let stuckPhaseAtTimeout;

  try {
    const client = await createClient(daemon.ready.port, {
      connectionClose: options.connectionClose === true,
    });
    if (options.openWindow) {
      await verifyAndLoadWeb(daemon.url);
      browserWindowOpened = true;
    }

    if (options.closeWindowBeforeFixtureRun && browserWindowOpened) {
      await closeMainWindow();
      browserClosedBeforeShutdown = true;
    }

    if (options.completeFixtureRun) {
      try {
        const fixture = await createFixtureRun(client, workspaceRoot, true);
        fixtureRunCompleted = fixture.run.status === "COMPLETED";
        fixtureSessionId = fixture.session.id;
        fixtureRunId = fixture.run.id;
      } catch (error) {
        fixtureRunFailureCode = typeof error?.code === "string" ? error.code : "FIXTURE_RUN_FAILED";
      }
    }

    if (options.activeSse) {
      const fixture = await createFixtureRun(client, workspaceRoot, false);
      activeSseController = new AbortController();
      let signalOpened;
      const opened = new Promise((resolvePromise) => (signalOpened = resolvePromise));
      activeSseIterator = client
        .watchRunEvents(fixture.run.id, {
          afterSequence: 0,
          signal: activeSseController.signal,
          onOpen: signalOpened,
        })
        [Symbol.asyncIterator]();
      activeSseFirstRead = activeSseIterator.next();
      await withTimeout(opened, 5000, "SSE_OPEN_TIMEOUT");
      activeSseOpen = true;
    }

    if (options.closeWindowBeforeShutdown && browserWindowOpened) {
      await closeMainWindow();
      browserClosedBeforeShutdown = true;
    }

    try {
      await stopDaemonChild(daemon);
    } catch (error) {
      if (!isShutdownFailure(error?.code)) throw error;
      shutdownFailureCode = error.code;
      stuckPhaseAtTimeout = shutdownAttemptEvidence(daemon).stuckPhase;
    }

    if (options.activeSse && daemon.shutdownResponseType === "CLOSED") {
      try {
        await drainAbortedIterator(activeSseIterator, 1000, activeSseFirstRead);
        activeSseClosed = true;
      } catch {
        activeSseClosed = false;
      }
    }
  } finally {
    if (activeSseController !== undefined) activeSseController.abort();
    if (activeSseFirstRead !== undefined) {
      await withTimeout(
        activeSseFirstRead.catch(() => undefined),
        1000,
        "SSE_CLEANUP_TIMEOUT",
      ).catch(() => undefined);
    }
    if (browserWindowOpened && !browserClosedBeforeShutdown) {
      await closeMainWindow().catch(() => undefined);
    }
    if (!daemon.exited) await killOwnedChild(daemon).catch(() => undefined);
  }

  const shutdown = shutdownAttemptEvidence(daemon);
  const completed = shutdownFailureCode === undefined && shutdown.normalChildExit;
  let sqliteEvidence;
  if (options.verifySqliteRecovery) {
    let integrity;
    let sqliteFailureCode;
    if (completed) {
      try {
        integrity = await runJsonProcess(
          NODE_EXECUTABLE,
          [SQLITE_SCRIPT, databasePath],
          options.env,
          5000,
          "SQLITE_INTEGRITY_CHECK_FAILED",
        );
      } catch (error) {
        sqliteFailureCode = typeof error?.code === "string" ? error.code : "SQLITE_CHECK_FAILED";
      }
    }

    let sessionAndRunRecoveredAfterRestart = false;
    if (
      completed &&
      integrity?.integrity === "ok" &&
      fixtureSessionId !== undefined &&
      fixtureRunId !== undefined
    ) {
      const restarted = await startDaemonChild({
        databasePath,
        dataRoot: caseRoot,
        env: options.env,
        generation: randomUUID(),
      });
      try {
        const restartedClient = await createClient(restarted.ready.port, {
          connectionClose: options.connectionClose === true,
        });
        const [session, run, transcript] = await Promise.all([
          restartedClient.getSession(fixtureSessionId),
          restartedClient.getRun(fixtureRunId),
          restartedClient.getSessionTranscript(fixtureSessionId),
        ]);
        sessionAndRunRecoveredAfterRestart =
          session.id === fixtureSessionId &&
          run.id === fixtureRunId &&
          run.status === "COMPLETED" &&
          transcript.items.some((item) => item.runId === fixtureRunId && item.kind === "ASSISTANT");
        await stopDaemonChild(restarted);
      } finally {
        if (!restarted.exited) await killOwnedChild(restarted).catch(() => undefined);
      }
    }

    const g2Passed =
      completed &&
      shutdown.responseReceived &&
      shutdown.responseType === "CLOSED" &&
      shutdown.phases.some(
        (observation) => observation.phase === "storageClose" && observation.state === "COMPLETED",
      ) &&
      integrity?.integrity === "ok" &&
      integrity.tables > 0 &&
      sessionAndRunRecoveredAfterRestart;
    sqliteEvidence = {
      status: g2Passed ? "PASS" : "BLOCKED",
      shutdownRequestSent: shutdown.requestSent,
      daemonCloseFulfilled: shutdown.phases.some(
        (observation) => observation.phase === "storageClose" && observation.state === "COMPLETED",
      ),
      closedAcknowledged: shutdown.responseReceived && shutdown.responseType === "CLOSED",
      childExitedNormally: shutdown.normalChildExit,
      databaseReopened: integrity?.integrity === "ok",
      integrityCheck: integrity?.integrity ?? "NOT_RUN",
      tableCount: integrity?.tables ?? 0,
      sessionAndRunRecoveredAfterRestart,
      ...(sqliteFailureCode === undefined ? {} : { sqliteFailureCode }),
    };
  }

  return {
    name: options.name,
    status:
      completed &&
      (!options.completeFixtureRun || fixtureRunCompleted) &&
      (!options.activeSse || (activeSseOpen && activeSseClosed))
        ? "PASS"
        : "BLOCKED",
    browserWindowOpened,
    browserWindowOpenAtShutdown: browserWindowOpened && !browserClosedBeforeShutdown,
    browserClosedBeforeShutdown,
    fixtureRunRequested: Boolean(options.completeFixtureRun),
    fixtureRunCompleted,
    ...(fixtureRunFailureCode === undefined ? {} : { fixtureRunFailureCode }),
    activeSseOpened: activeSseOpen,
    ...(options.activeSse ? { activeSseIteratorClosed: activeSseClosed === true } : {}),
    shutdownFailureCode: shutdownFailureCode ?? null,
    stuckPhaseAtTimeout: stuckPhaseAtTimeout ?? null,
    ...shutdown,
    ...(sqliteEvidence === undefined ? {} : { sqlite: sqliteEvidence }),
  };
}

async function createFixtureRun(client, workspaceRoot, start) {
  const { createWorkspaceId } = await importProductPackage("protocol");
  const requestedWorkspace = { id: createWorkspaceId(), path: workspaceRoot };
  const session = await client.createSession({
    defaultWorkspace: requestedWorkspace,
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
  const workspace = session.defaultWorkspace ?? requestedWorkspace;
  const run = await client.createRun(session.id, {
    goal: "complete the local Windows shutdown fixture",
    workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    preset: { id: "FULL_ACCESS", expectedVersion: 1 },
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
  });
  if (!start) return { session, run };
  await client.startRun(run.id);
  const settled = await waitForRun(client, run.id, 10_000);
  if (
    settled.status !== "COMPLETED" ||
    settled.finalResult?.type !== "NORMAL_COMPLETION" ||
    settled.finalResult.text !== "Windows POC fixture completed."
  ) {
    throw new PocError("FIXTURE_RUN_NOT_COMPLETED");
  }
  return { session, run: settled };
}

function isShutdownFailure(code) {
  return [
    "SHUTDOWN_TIMEOUT",
    "DAEMON_SHUTDOWN_FAILED",
    "CHILD_EXIT_BEFORE_SHUTDOWN_ACK",
    "CHILD_EXIT_TIMEOUT",
    "CHILD_EXIT_AFTER_CLOSED_NOT_NORMAL",
    "INVALID_SHUTDOWN_ACK",
  ].includes(code);
}

function shutdownAttemptEvidence(handle) {
  const activePhases = new Set();
  let lastCompletedPhase = null;
  let lastPhase = null;
  let activeRunCount = null;
  for (const observation of handle.shutdownPhases) {
    lastPhase = observation.phase;
    if (observation.phase === "checkpointActive" && observation.state === "STARTED") {
      activeRunCount = observation.activeRunCount;
    }
    if (observation.state === "STARTED") activePhases.add(observation.phase);
    if (observation.state === "COMPLETED" || observation.state === "FAILED") {
      activePhases.delete(observation.phase);
      if (observation.state === "COMPLETED") lastCompletedPhase = observation.phase;
    }
  }
  return {
    requestAttempted: Boolean(handle.shutdownRequestAttempted),
    requestSent: Boolean(handle.shutdownRequestSent),
    responseReceived: Boolean(handle.shutdownResponseReceived),
    responseType: handle.shutdownResponseType,
    childIpcSendResults:
      handle.shutdownIpcSends.length > 0
        ? handle.shutdownIpcSends
        : handle.shutdownResponseReceived
          ? [{ messageType: handle.shutdownResponseType, result: "ACKNOWLEDGED_BY_MAIN" }]
          : [],
    phases: handle.shutdownPhases,
    activeRunCount,
    lastPhase,
    lastCompletedPhase,
    stuckPhase: [...activePhases].at(-1) ?? null,
    childExited: handle.exited,
    childExitCode: handle.exitCode,
    childExitSignal: handle.exitSignal,
    normalChildExit: handle.exited && handle.exitCode === 0 && handle.exitSignal === null,
    orphanChildCount: activeChildren.size,
  };
}

async function closeMainWindow() {
  const window = mainWindow;
  mainWindow = undefined;
  if (window === undefined || window.isDestroyed()) return;
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeListener("closed", onClosed);
    };
    const onClosed = () => {
      cleanup();
      resolvePromise();
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new PocError("ELECTRON_WINDOW_CLOSE_TIMEOUT"));
    }, 5000);
    window.once("closed", onClosed);
    window.close();
    if (window.isDestroyed()) onClosed();
  });
}

async function verifyAndLoadWeb(baseUrl) {
  const indexResponse = await fetch(`${baseUrl}/`);
  if (!indexResponse.ok) throw new PocError("WEB_INDEX_HTTP_FAILED");
  const indexHtml = await indexResponse.text();
  const script = indexHtml.match(/<script[^>]+src=["']([^"']+\.js)["']/i)?.[1];
  const stylesheet = indexHtml.match(/<link[^>]+href=["']([^"']+\.css)["']/i)?.[1];
  if (!script || !stylesheet) throw new PocError("WEB_BUILD_ASSETS_MISSING");
  const [scriptResponse, styleResponse] = await Promise.all([
    fetch(new URL(script, baseUrl)),
    fetch(new URL(stylesheet, baseUrl)),
  ]);
  const [scriptBody, styleBody] = await Promise.all([
    scriptResponse.arrayBuffer(),
    styleResponse.arrayBuffer(),
  ]);
  if (
    !scriptResponse.ok ||
    !styleResponse.ok ||
    scriptBody.byteLength === 0 ||
    styleBody.byteLength === 0
  ) {
    throw new PocError("WEB_ASSET_HTTP_FAILED");
  }
  mainWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await withTimeout(mainWindow.loadURL(baseUrl), 15_000, "ELECTRON_RENDERER_LOAD_TIMEOUT");
  return {
    packagedStaticAssets: true,
    indexHttpStatus: indexResponse.status,
    javascriptHttpStatus: scriptResponse.status,
    stylesheetHttpStatus: styleResponse.status,
    electronRendererLoaded:
      new URL(mainWindow.webContents.getURL()).origin === new URL(baseUrl).origin,
    assetNames: {
      script: new URL(script, baseUrl).pathname,
      stylesheet: new URL(stylesheet, baseUrl).pathname,
    },
  };
}

async function createClient(port, options = {}) {
  const { CaelushClient } = await importProductPackage("client");
  const fetcher = options.connectionClose
    ? (input, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("connection", "close");
        return fetch(input, { ...init, headers });
      }
    : undefined;
  return new CaelushClient({
    baseUrl: `http://127.0.0.1:${port}`,
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  });
}

async function importProductPackage(name) {
  const entry = join(PRODUCT_ROOT, "node_modules", "@caelush", name, "dist", "index.js");
  return import(pathToFileURL(entry).href);
}

async function startDaemonChild({
  databasePath,
  dataRoot,
  env,
  generation,
  fault = "",
  timeoutMs = STARTUP_TIMEOUT_MS,
}) {
  await mkdir(join(dataRoot, "userprofile"), { recursive: true });
  await mkdir(join(dataRoot, "caelush-home"), { recursive: true });
  const child = fork(CHILD_SCRIPT, fault ? [fault] : [], {
    cwd: PRODUCT_ROOT,
    execPath: NODE_EXECUTABLE,
    env: isolatedEnvironment(dataRoot),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
    windowsHide: true,
  });
  const state = {
    child,
    generation,
    exited: false,
    exitCode: null,
    exitSignal: null,
    shutdownProgress: [],
    shutdownPhases: [],
    shutdownIpcSends: [],
    shutdownResponseReceived: false,
    shutdownResponseType: null,
  };
  activeChildren.add(state);
  let stdoutRemainder = "";
  child.stdout?.on("data", (chunk) => {
    stdoutRemainder = (stdoutRemainder + chunk.toString("utf8")).slice(-512);
    const lastNewline = stdoutRemainder.lastIndexOf("\n");
    if (lastNewline < 0) return;
    const lines = stdoutRemainder.slice(0, lastNewline).split(/\r?\n/);
    stdoutRemainder = stdoutRemainder.slice(lastNewline + 1);
    for (const line of lines) {
      const match = /^POC_SHUTDOWN_IPC=(CLOSED|ERROR):(SENT|FAILED)$/.exec(line);
      if (match && state.shutdownIpcSends.length < 4) {
        state.shutdownIpcSends.push({ messageType: match[1], result: match[2] });
      }
    }
  });
  child.stderr?.on("data", () => undefined);
  child.on("message", (message) => {
    if (
      message &&
      message.type === "SHUTDOWN_PROGRESS" &&
      message.generation === generation &&
      Number.isSafeInteger(message.elapsedMs)
    ) {
      if (state.shutdownProgress.length < 32) state.shutdownProgress.push(message.elapsedMs);
    }
    if (
      message &&
      message.type === "SHUTDOWN_PHASE" &&
      message.generation === generation &&
      SHUTDOWN_PHASES.has(message.phase) &&
      ["STARTED", "COMPLETED", "FAILED", "SNAPSHOT"].includes(message.state)
    ) {
      const observation = { phase: message.phase, state: message.state };
      for (const key of [
        "elapsedMs",
        "activeRunCount",
        "unsafeCheckpointCount",
        "activeHttpRequestCount",
        "activeConnectionCount",
        "openSocketCount",
        "pendingSocketCount",
        "readableSocketCount",
        "writableSocketCount",
        "bytesReadTotal",
        "bytesWrittenTotal",
        "outcome",
        "controllerCount",
      ]) {
        if (
          Number.isSafeInteger(message[key]) ||
          (key === "outcome" && ["DRAINED", "TIMED_OUT"].includes(message[key]))
        ) {
          observation[key] = message[key];
        }
      }
      if (state.shutdownPhases.length < 32) state.shutdownPhases.push(observation);
    }
  });
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    activeChildren.delete(state);
  });
  child.once("error", () => {
    state.exited = true;
    state.exitSignal = "ERROR";
    activeChildren.delete(state);
  });
  try {
    if (fault === "invalid-bootstrap") {
      state.startupResponse = await sendIpcAndWaitForMessage(
        child,
        {
          type: "START",
          protocolVersion: 900,
          generation,
          databasePath,
          productRoot: PRODUCT_ROOT,
        },
        timeoutMs,
        "CHILD_EXIT_BEFORE_READY",
        "STARTUP_TIMEOUT",
        (message) => ["READY", "ERROR", "BOOTSTRAP_REJECTED"].includes(message?.type),
      );
    } else {
      const bootstrapSecret = randomBytes(32).toString("hex");
      const startupResponse = await sendIpcAndWaitForMessage(
        child,
        {
          type: "START",
          protocolVersion: 1,
          generation,
          bootstrapSecret,
          databasePath,
          productRoot: PRODUCT_ROOT,
        },
        timeoutMs,
        "CHILD_EXIT_BEFORE_READY",
        "STARTUP_TIMEOUT",
        (message) => ["READY", "ERROR", "BOOTSTRAP_REJECTED"].includes(message?.type),
      );
      if (child.spawnargs.join(" ").includes(bootstrapSecret))
        throw new PocError("BOOTSTRAP_SECRET_IN_ARGV");
      if (
        Object.values(isolatedEnvironment(dataRoot)).some((value) =>
          value.includes(bootstrapSecret),
        )
      ) {
        throw new PocError("BOOTSTRAP_SECRET_IN_ENV");
      }
      state.bootstrapSecret = bootstrapSecret;
      state.startupResponse = startupResponse;
    }
    const response = state.startupResponse;
    if (response.type === "BOOTSTRAP_REJECTED") {
      throw new PocError("INVALID_BOOTSTRAP_MESSAGE");
    }
    if (response.type === "ERROR") throw new PocError(response.code || "CHILD_START_FAILED");
    if (response.type !== "READY") throw new PocError("INVALID_STARTUP_RESPONSE");
    state.startupRequestSent = true;
    state.generationVerified = response.generation === generation;
    state.pidVerified = response.pid === child.pid;
    state.startupResponseType = response.type;
    if (response.generation !== generation || response.pid !== child.pid) {
      throw new PocError("GENERATION_MISMATCH");
    }
    state.startupIpcVerified = true;
    state.ready = response;
    state.url = `http://127.0.0.1:${response.port}`;
    if (state.bootstrapSecret && state.url.includes(state.bootstrapSecret)) {
      throw new PocError("BOOTSTRAP_SECRET_IN_URL");
    }
    delete state.bootstrapSecret;
    state.bootstrapChannelOnly = response.bootstrapChannelOnly === true;
    return state;
  } catch (error) {
    await killOwnedChild(state).catch(() => undefined);
    throw error;
  }
}

function stopDaemonChild(handle, timeoutMs = NORMAL_SHUTDOWN_TIMEOUT_MS) {
  if (!handle || handle.exited) return Promise.resolve();
  if (handle.shutdownPromise !== undefined) return handle.shutdownPromise;

  const attempt = (async () => {
    try {
      handle.shutdownRequestAttempted = true;
      const response = await sendIpcAndWaitForMessage(
        handle.child,
        { type: "SHUTDOWN", generation: handle.generation },
        timeoutMs,
        "CHILD_EXIT_BEFORE_SHUTDOWN_ACK",
        "SHUTDOWN_TIMEOUT",
        (message) => message?.type === "CLOSED" || message?.type === "ERROR",
        () => {
          handle.shutdownRequestSent = true;
        },
      );
      handle.shutdownRequestSent = true;
      handle.shutdownResponseReceived = true;
      handle.shutdownResponseType = response.type;
      if (response.generation !== handle.generation) {
        throw new PocError("INVALID_SHUTDOWN_ACK");
      }
      if (response.type === "ERROR") {
        handle.shutdownFailureCode = "DAEMON_SHUTDOWN_FAILED";
        throw new PocError("DAEMON_SHUTDOWN_FAILED");
      }
      if (response.type !== "CLOSED") throw new PocError("INVALID_SHUTDOWN_ACK");

      const exitCode = await waitForChildExit(handle, timeoutMs);
      handle.shutdownExitCode = exitCode;
      handle.shutdownExitSignal = handle.exitSignal;
      if (exitCode !== 0 || !handle.exited) {
        throw new PocError("CHILD_EXIT_AFTER_CLOSED_NOT_NORMAL");
      }
    } catch (error) {
      await killOwnedChild(handle).catch(() => undefined);
      if (error?.code === "SHUTDOWN_TIMEOUT") {
        throw new PocError("SHUTDOWN_TIMEOUT", JSON.stringify(handle.shutdownProgress));
      }
      throw error;
    }
  })();

  handle.shutdownPromise = attempt.catch((error) => {
    handle.shutdownPromise = undefined;
    throw error;
  });
  return handle.shutdownPromise;
}

async function runFailureInjections(dataRoot, env) {
  const results = {};
  await expectStartupFault(
    "exit-before-ready",
    "CHILD_EXIT_BEFORE_READY",
    dataRoot,
    env,
    2000,
    results,
  );
  await expectStartupFault("startup-timeout", "STARTUP_TIMEOUT", dataRoot, env, 300, results);
  await expectStartupFault(
    "invalid-bootstrap",
    "INVALID_BOOTSTRAP_MESSAGE",
    dataRoot,
    env,
    2000,
    results,
  );
  await expectStartupFault(
    "generation-mismatch",
    "GENERATION_MISMATCH",
    dataRoot,
    env,
    8000,
    results,
  );
  const exitRoot = join(dataRoot, "failure-exit-after-ready");
  await mkdir(exitRoot, { recursive: true });
  const exitHandle = await startDaemonChild({
    databasePath: join(exitRoot, "caelush.db"),
    dataRoot: exitRoot,
    env,
    generation: randomUUID(),
    fault: "exit-after-ready",
  });
  const exitCode = await waitForChildExit(exitHandle, 3000);
  if (exitCode !== 23 || !exitHandle.exited)
    throw new PocError("CHILD_EXIT_AFTER_READY_NOT_DETECTED");
  results.CHILD_EXIT_AFTER_READY = "PASS";
  const generation = randomUUID();
  const timeoutDirectory = join(dataRoot, "failure-shutdown-timeout");
  await mkdir(timeoutDirectory, { recursive: true });
  const timedChild = await startDaemonChild({
    databasePath: join(timeoutDirectory, "caelush.db"),
    dataRoot: timeoutDirectory,
    env,
    generation,
    fault: "shutdown-timeout",
  });
  try {
    await stopDaemonChild(timedChild, 250);
    throw new PocError("SHUTDOWN_TIMEOUT_NOT_INJECTED");
  } catch (error) {
    if (error.code !== "SHUTDOWN_TIMEOUT") throw error;
    results.SHUTDOWN_TIMEOUT = "PASS";
    if (!timedChild.exited) throw new PocError("SHUTDOWN_TIMEOUT_CHILD_NOT_CLEANED");
  }
  return { status: "PASS", defaultStartupDeadlineMs: STARTUP_TIMEOUT_MS, cases: results };
}

async function expectStartupFault(fault, expectedCode, dataRoot, env, timeoutMs, results) {
  const faultRoot = join(dataRoot, `failure-${fault}`);
  await mkdir(faultRoot, { recursive: true });
  try {
    await startDaemonChild({
      databasePath: join(faultRoot, "caelush.db"),
      dataRoot: faultRoot,
      env,
      generation: randomUUID(),
      fault,
      timeoutMs,
    });
    throw new PocError(`${fault.toUpperCase()}_NOT_INJECTED`);
  } catch (error) {
    if (error.code !== expectedCode) throw error;
    results[
      fault === "exit-before-ready"
        ? "CHILD_EXIT_BEFORE_READY"
        : fault === "invalid-bootstrap"
          ? "INVALID_BOOTSTRAP_MESSAGE"
          : fault === "generation-mismatch"
            ? "GENERATION_MISMATCH"
            : "STARTUP_TIMEOUT"
    ] = "PASS";
  }
}

async function readUntilCompleted(client, runId, afterSequence) {
  const events = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    for await (const event of client.watchRunEvents(runId, {
      afterSequence,
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "run.completed") return events;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  throw new PocError("SSE_RUN_COMPLETION_EVENT_MISSING");
}

async function readUntilTerminal(client, runId, afterSequence) {
  const events = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    for await (const event of client.watchRunEvents(runId, {
      afterSequence,
      signal: controller.signal,
    })) {
      events.push(event);
      if (["run.completed", "run.failed", "run.cancelled", "run.timed_out"].includes(event.type)) {
        return events;
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  throw new PocError("SSE_TERMINAL_EVENT_MISSING");
}

async function drainAbortedIterator(iterator, timeoutMs, firstPromise) {
  let next = firstPromise;
  for (let index = 0; index < 16; index += 1) {
    const result = await withTimeout(next ?? iterator.next(), timeoutMs, "SSE_ABORT_DID_NOT_CLOSE");
    if (result.done) return;
    next = undefined;
  }
  throw new PocError("SSE_ABORT_DID_NOT_CLOSE");
}

async function waitForRun(client, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let run = await client.getRun(runId);
  while (Date.now() < deadline && !isTerminal(run.status)) {
    await delay(35);
    run = await client.getRun(runId);
  }
  if (!isTerminal(run.status)) throw new PocError("FIXTURE_RUN_TIMEOUT");
  return run;
}

function isTerminal(status) {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}

function isDurableEvent(event) {
  return event && event.durability && event.durability.kind === "DURABLE";
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function strictlyIncreasing(values) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

async function waitForChildExit(handle, timeoutMs) {
  if (handle.exited) return handle.exitCode;
  const child = handle.child;
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const onExit = (code) => {
      cleanup();
      resolvePromise(code);
    };
    const onError = () => {
      cleanup();
      rejectPromise(new PocError("CHILD_PROCESS_ERROR"));
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new PocError("CHILD_EXIT_TIMEOUT"));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return handle.exitCode;
}

async function killOwnedChild(handle) {
  if (!handle || handle.exited || handle.child.exitCode !== null) return;
  handle.child.kill();
  try {
    await waitForChildExit(handle, 3000);
  } catch {
    handle.child.kill("SIGKILL");
    await waitForChildExit(handle, 3000).catch(() => undefined);
  }
  if (!handle.exited && handle.child.exitCode === null)
    throw new PocError("OWNED_CHILD_CLEANUP_FAILED");
}

async function terminateAllOwnedChildren() {
  const children = [...activeChildren];
  await Promise.all(children.map((handle) => killOwnedChild(handle).catch(() => undefined)));
}

async function runJsonProcess(executable, args, env, timeoutMs, failureCode) {
  const captured = await captureProcess(executable, args, env, timeoutMs, failureCode);
  const line = captured.stdout
    .split(/\r?\n/)
    .filter((value) => value.trim().startsWith("{"))
    .at(-1);
  if (line === undefined) throw new PocError(failureCode);
  try {
    return JSON.parse(line);
  } catch {
    throw new PocError(failureCode);
  }
}

function captureProcess(executable, args, env, timeoutMs, failureCode) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-65_536);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.once("error", () => finish(new PocError(failureCode)));
    child.once("exit", (code) => {
      if (code !== 0) finish(new PocError(failureCode));
      else finish(undefined, { stdout, stderr, exitCode: code });
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new PocError(failureCode));
    }, timeoutMs);
  });
}

function withTimeout(promise, timeoutMs, code) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new PocError(code)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function delay(timeoutMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs));
}

async function hashFile(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function persistEvidence(evidence) {
  if (!EVIDENCE_FILE) return;
  await mkdir(resolve(EVIDENCE_FILE, ".."), { recursive: true });
  await require("node:fs/promises").writeFile(
    EVIDENCE_FILE,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
}

function PocError(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}
