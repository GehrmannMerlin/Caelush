import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, safeStorage } from "electron";
import { DpapiVault } from "../src/main/credentials/vault.js";
import { ProviderCredentialVault } from "../src/main/credentials/provider-credential-vault.js";
import { DesktopProviderCredentialMigrator } from "../src/main/migration/provider-credential-migration.js";
import { DesktopLegacyDataImporter } from "../src/main/migration/legacy-data-import.js";
import { ProfileBackupStore } from "../src/main/backup/profile-backup.js";
import { DesktopDaemonSupervisor } from "../src/main/daemon/supervisor.js";
import { DesktopLocalProxy } from "../src/main/protocol/local-proxy.js";
import {
  ProfileManager,
  WindowsProfilePermissions,
  profileIdForUser,
} from "../src/main/profiles/profile-manager.js";
import type { AccountState } from "../src/main/account/state.js";

const USER_A = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
const USER_B = "3657e5a0-275c-4ae6-950f-511646d3f647";
const INITIAL_KEY = "fixture-initial-provider-key";
const REPLACEMENT_KEY = "fixture-replacement-provider-key";
const ENVIRONMENT_KEY = "fixture-environment-only-key";
const LEGACY_KEY = "fixture-legacy-import-provider-key";
const PROVIDER_ID = "deepseek";
const MODEL_ID = "deepseek-chat";
const REPLAY_MODEL_ID = "deepseek-reasoner";

const testRoot = requiredEnvironment("CAELUSH_D4_TEST_ROOT");
const appRoot = requiredEnvironment("CAELUSH_D4_DESKTOP_APP_ROOT");
const localAppDataDirectory = requiredEnvironment("LOCALAPPDATA");
const markerPath = path.join(testRoot, "d4-2-smoke.marker");
const workspacePath = path.join(testRoot, "workspace");
const calls: Array<{ readonly path: string; readonly key: string | null; readonly body: string }> =
  [];
let completedLegacyToolTurnStarted = false;
let nativeReplayToolTurnStarted = false;
let fixture: ReturnType<typeof createServer> | undefined;
let supervisor: DesktopDaemonSupervisor | undefined;
let diagnosticProfiles: ProfileManager | undefined;
let diagnosticUserId = USER_A;
let failureStage = "INITIALIZE";
let proxyFetchFailure = "NONE";

app.whenReady().then(async () => {
  try {
    await mkdir(workspacePath, { recursive: true });
    await mkdir(localAppDataDirectory, { recursive: true });
    await mkdir(path.join(testRoot, "home"), { recursive: true });
    await writeFile(
      path.join(workspacePath, "fixture.txt"),
      "legacy workspace file fixture\n",
      "utf8",
    );
    await appendFile(markerPath, "ELECTRON_READY\n", "utf8");

    fixture = createServer((request, response) => {
      void handleFixtureRequest(request, response);
    });
    await listen(fixture);
    const address = fixture.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;

    const vault = new DpapiVault(path.join(app.getPath("userData"), "credentials.dpapi"), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptStringAsync: (value) => safeStorage.encryptStringAsync(value),
      decryptStringAsync: async (value) =>
        (await safeStorage.decryptStringAsync(Buffer.from(value))).result,
    });
    await vault.initialize();
    const credentialVault = new ProviderCredentialVault(vault);
    const profileManager = new ProfileManager({
      localAppDataDirectory,
      platform: "win32",
      permissions: new WindowsProfilePermissions("win32", process.env),
    });
    diagnosticProfiles = profileManager;
    const credentialMigrator = new DesktopProviderCredentialMigrator({
      vault,
      credentials: credentialVault,
    });
    const onlineState = createOnlineState();

    process.env.CAELUSH_PROVIDER_ID = PROVIDER_ID;
    process.env.CAELUSH_PROVIDER_BASE_URL = endpoint;
    process.env.CAELUSH_DEFAULT_PROVIDER = PROVIDER_ID;
    process.env.CAELUSH_DEFAULT_MODEL = MODEL_ID;
    process.env.CAELUSH_PROVIDER_API_KEY = ENVIRONMENT_KEY;

    supervisor = new DesktopDaemonSupervisor({
      profileManager,
      credentialVault,
      credentialMigrator,
      resolveResources: async () => ({
        nodeExecutablePath: path.join(appRoot, ".stage", "daemon", "node.exe"),
        daemonEntryPath: path.resolve(appRoot, "..", "daemon", "dist", "desktop-entry.js"),
      }),
      productVersion: "0.1.0",
      processEnvironment: process.env,
    });
    const proxy = new DesktopLocalProxy({
      acquireLease: (signal) => supervisor!.acquireProxyLease(signal),
      fetcher: async (input, init) => {
        try {
          return await globalThis.fetch(input, init);
        } catch (error) {
          const record = error as NodeJS.ErrnoException;
          const cause = record.cause as NodeJS.ErrnoException | undefined;
          const errorClass =
            record.message === "fetch failed"
              ? "FETCH_FAILED"
              : record.message.toLowerCase().includes("duplex")
                ? "DUPLEX"
                : record.message.toLowerCase().includes("stream")
                  ? "STREAM"
                  : "OTHER";
          proxyFetchFailure = `${error instanceof Error ? error.name : "UNKNOWN"}_${record.code ?? "NO_CODE"}_${cause?.code ?? "NO_CAUSE_CODE"}_${errorClass}`;
          throw error;
        }
      },
    });

    await supervisor.synchronizeAccountState(onlineState);
    assert.equal(supervisor.getAgentEntry(onlineState).available, true);
    failureStage = "PRECONNECT_LIST";
    await appendFile(markerPath, "PROFILE_DAEMON_READY\n", "utf8");

    const beforeConnect = await api(proxy, "/api/v1/ai/providers");
    assert.equal(provider(beforeConnect.value, PROVIDER_ID).credentialSource, "NONE");

    failureStage = "CONNECT_CANDIDATE";
    const connected = await api(proxy, `/api/v1/ai/providers/${PROVIDER_ID}/connect`, {
      method: "POST",
      body: { apiKey: INITIAL_KEY },
    });
    failureStage = "CONNECT_RESPONSE_STATUS";
    assert.equal(provider(connected.value, PROVIDER_ID).credentialSource, "LOCAL");
    assert.equal(JSON.stringify(connected.value).includes(INITIAL_KEY), false);
    failureStage = "INVALID_REPLACEMENT";
    await appendFile(markerPath, "PROVIDER_CONNECTED_IN_VAULT\n", "utf8");

    const rejectedReplacement = await api(proxy, `/api/v1/ai/providers/${PROVIDER_ID}/connect`, {
      method: "POST",
      body: { apiKey: "fixture-invalid-provider-key" },
      allowFailure: true,
    });
    assert.equal(rejectedReplacement.status, 401);
    assert.equal(
      provider((await api(proxy, "/api/v1/ai/providers")).value, PROVIDER_ID).credentialSource,
      "LOCAL",
    );
    assert.equal(
      await credentialVault.resolve(USER_A, profileIdForUser(USER_A), PROVIDER_ID),
      INITIAL_KEY,
    );
    failureStage = "INITIAL_MODEL_RUN";
    await appendFile(markerPath, "INVALID_REPLACEMENT_PRESERVED_OLD_KEY\n", "utf8");

    const workspace = await api(proxy, "/api/v1/workspaces", {
      method: "POST",
      body: { path: workspacePath, displayName: "D4-2 Fixture Workspace" },
    });
    const workspaceRef = { id: workspace.value.id, path: workspacePath };
    const session = await api(proxy, "/api/v1/sessions", {
      method: "POST",
      body: {
        defaultWorkspace: workspaceRef,
        defaultModel: { provider: PROVIDER_ID, model: MODEL_ID },
      },
    });
    await runToCompletion(
      proxy,
      session.value.id,
      workspaceRef,
      "initial-key fixture run",
      "INITIAL_RUN",
    );
    assert.ok(
      calls.some((call) => call.path === "/v1/chat/completions" && call.key === INITIAL_KEY),
    );
    await assertNoCredentialInSQLite(profileManager, USER_A, [
      INITIAL_KEY,
      REPLACEMENT_KEY,
      ENVIRONMENT_KEY,
    ]);
    await appendFile(markerPath, "MODEL_RUN_COMPLETED_WITH_VAULT_KEY\n", "utf8");

    const replaySession = await api(proxy, "/api/v1/sessions", {
      method: "POST",
      body: {
        defaultWorkspace: workspaceRef,
        defaultModel: { provider: PROVIDER_ID, model: REPLAY_MODEL_ID },
      },
    });
    const completedToolRunId = await runToCompletion(
      proxy,
      session.value.id,
      workspaceRef,
      "successful imported tool fixture: inspect fixture.txt",
      "LEGACY_TOOL_RUN",
      MODEL_ID,
    );
    const replayRunId = await runToCompletion(
      proxy,
      replaySession.value.id,
      workspaceRef,
      "legacy native replay fixture: inspect fixture.txt",
      "NATIVE_REPLAY_RUN",
      REPLAY_MODEL_ID,
      "FAILED",
    );
    await assertNativeReplayWasStored(profileManager, USER_A, replayRunId);

    failureStage = "REPLACEMENT_CONNECT";
    const replaced = await api(proxy, `/api/v1/ai/providers/${PROVIDER_ID}/connect`, {
      method: "POST",
      body: { apiKey: REPLACEMENT_KEY },
    });
    failureStage = "REPLACEMENT_STATUS";
    assert.equal(provider(replaced.value, PROVIDER_ID).credentialSource, "LOCAL");
    const requestStart = calls.length;
    await runToCompletion(
      proxy,
      session.value.id,
      workspaceRef,
      "replacement-key fixture run",
      "REPLACEMENT_RUN",
    );
    failureStage = "REPLACEMENT_CALL_ASSERT";
    const replacementCalls = calls
      .slice(requestStart)
      .filter((call) => call.path === "/v1/chat/completions");
    assert.ok(replacementCalls.length >= 1);
    assert.ok(replacementCalls.every((call) => call.key === REPLACEMENT_KEY));
    failureStage = "OFFLINE_RUN";
    await appendFile(markerPath, "KEY_REPLACEMENT_USED_ON_NEXT_MODEL_TURN\n", "utf8");

    const offlineState = createOfflineState(onlineState);
    await supervisor.synchronizeAccountState(offlineState);
    assert.equal(
      provider((await api(proxy, "/api/v1/ai/providers")).value, PROVIDER_ID).credentialSource,
      "LOCAL",
    );
    const offlineStart = calls.length;
    await runToCompletion(
      proxy,
      session.value.id,
      workspaceRef,
      "offline fixture run",
      "OFFLINE_RUN",
    );
    assert.ok(
      calls
        .slice(offlineStart)
        .some((call) => call.path === "/v1/chat/completions" && call.key === REPLACEMENT_KEY),
    );
    await appendFile(markerPath, "OFFLINE_LOCAL_CREDENTIAL_USED\n", "utf8");

    failureStage = "RESTART_RUN";
    const profileBeforeRestart = await profileManager.selectForUser(USER_A);
    await supervisor.beginAccountBoundary();
    await supervisor.synchronizeAccountState(onlineState);
    assert.equal(supervisor.getAgentEntry(onlineState).available, true);
    const profileAfterRestart = await profileManager.selectForUser(USER_A);
    assert.equal(profileAfterRestart.profileId, profileBeforeRestart.profileId);
    assert.equal(
      provider((await api(proxy, "/api/v1/ai/providers")).value, PROVIDER_ID).credentialSource,
      "LOCAL",
    );
    const restartStart = calls.length;
    await runToCompletion(
      proxy,
      session.value.id,
      workspaceRef,
      "restart fixture run",
      "RESTART_RUN",
    );
    assert.ok(
      calls
        .slice(restartStart)
        .some((call) => call.path === "/v1/chat/completions" && call.key === REPLACEMENT_KEY),
    );
    await appendFile(markerPath, "RESTART_RESTORED_PROFILE_AND_MODEL_RUN\n", "utf8");

    failureStage = "DISCONNECT";
    assert.equal(
      await credentialVault.resolve(USER_B, profileIdForUser(USER_B), PROVIDER_ID),
      undefined,
    );
    const backup = await readFile(path.join(app.getPath("userData"), "credentials.dpapi"));
    for (const secret of [INITIAL_KEY, REPLACEMENT_KEY, ENVIRONMENT_KEY]) {
      assert.equal(backup.includes(Buffer.from(secret)), false);
    }

    await api(proxy, `/api/v1/ai/providers/${PROVIDER_ID}/credential`, { method: "DELETE" });
    assert.equal(
      provider((await api(proxy, "/api/v1/ai/providers")).value, PROVIDER_ID).credentialSource,
      "NONE",
    );
    assert.equal(
      await credentialVault.resolve(USER_A, profileIdForUser(USER_A), PROVIDER_ID),
      undefined,
    );
    await assertNoCredentialInSQLite(profileManager, USER_A, [
      INITIAL_KEY,
      REPLACEMENT_KEY,
      ENVIRONMENT_KEY,
    ]);
    await appendFile(markerPath, "DISCONNECT_REMOVED_VAULT_KEY\n", "utf8");

    failureStage = "LEGACY_SOURCE_SNAPSHOT";
    await supervisor.beginAccountBoundary();
    const legacySourceRoot = path.join(testRoot, "legacy-caelush-home");
    await createRealLegacyFixture(profileManager, legacySourceRoot, completedToolRunId);
    const legacyHashBefore = await hashTree(legacySourceRoot);
    const importer = new DesktopLegacyDataImporter({
      profileManager,
      vault,
      credentialMigrator,
      userProfileDirectory: path.join(testRoot, "home"),
      environment: { CAELUSH_HOME: legacySourceRoot },
      assertAuthorized: (userId) => assert.ok(userId === USER_A || userId === USER_B),
    });
    const preImportProfile = await profileManager.selectForUser(USER_B);
    const scanned = await importer.inspect(USER_B);
    const source = scanned.sources.find((item) => item.sourceKind === "CUSTOM_HOME");
    assert.ok(source);
    assert.equal(scanned.pendingRecovery, false);
    assert.equal(source.importable, true);
    assert.ok(source.workspaces >= 1);
    assert.ok(source.sessions >= 2);
    assert.ok(source.runs >= 6);
    assert.ok(source.messages >= source.runs * 2);
    assert.ok(source.durableEvents >= source.runs);
    assert.ok(source.contextCheckpoints >= 1);
    assert.ok(source.toolExecutions >= 1);
    assert.equal(source.providerCredentials, 1);
    assert.ok(source.privateReplayFiles >= 1);
    assert.equal(JSON.stringify(scanned).includes(LEGACY_KEY), false);

    failureStage = "LEGACY_IMPORT_STAGE";
    const prepared = await importer.stageImport(USER_B, source.candidateId, true);
    assert.equal(prepared.state, "DESTINATION_VERIFIED");
    assert.equal(prepared.credentialCount, 1);
    assert.equal(
      await credentialVault.resolve(USER_B, preImportProfile.profileId, PROVIDER_ID),
      LEGACY_KEY,
    );
    assert.equal(
      await credentialVault.resolve(USER_A, preImportProfile.profileId, PROVIDER_ID),
      undefined,
    );
    await assertNoCredentialInSQLite(profileManager, USER_B, [LEGACY_KEY]);
    assert.equal(await hashTree(legacySourceRoot), legacyHashBefore);
    await appendFile(markerPath, "LEGACY_IMPORT_STAGED_WITH_PROTECTED_CREDENTIAL\n", "utf8");

    failureStage = "LEGACY_DAEMON_START";
    const onlineUserB = createOnlineState(USER_B);
    diagnosticUserId = USER_B;
    await supervisor.synchronizeAccountState(onlineUserB);
    failureStage = "LEGACY_DAEMON_READY_CHECK";
    assert.equal(supervisor.getAgentEntry(onlineUserB).available, true);
    const importedProfile = await profileManager.selectForUser(USER_B);
    await assertImportedLegacyData(
      proxy,
      importedProfile,
      [session.value.id, replaySession.value.id],
      completedToolRunId,
      replayRunId,
      workspaceRef,
    );
    await importer.commitImport(USER_B, prepared);
    const repeatedScan = await importer.inspect(USER_B);
    const rejectedRepeat = repeatedScan.sources.find((item) => item.sourceKind === "CUSTOM_HOME");
    assert.ok(rejectedRepeat);
    assert.equal(rejectedRepeat.importable, false);
    assert.equal(rejectedRepeat.reason, "TARGET_NOT_EMPTY");
    await appendFile(markerPath, "LEGACY_HISTORY_AND_REPLAY_AVAILABLE\n", "utf8");

    failureStage = "LEGACY_BACKUP_RESTORE";
    const backupStore = new ProfileBackupStore({
      profileRootDirectory: importedProfile.rootDirectory,
      backupsDirectory: importedProfile.backupsDirectory,
      cloudUserId: USER_B,
      profileId: importedProfile.profileId,
      vault,
    });
    const importReceipt = await readFile(
      path.join(importedProfile.backupsDirectory, "legacy-import.json"),
      "utf8",
    );
    const backupId = String(JSON.parse(importReceipt).backupId);
    await supervisor.beginAccountBoundary();
    await backupStore.restore(backupId, { replaceExistingDatabase: true });
    await credentialMigrator.run(importedProfile, USER_B);
    await assertNoCredentialInSQLite(profileManager, USER_B, [LEGACY_KEY]);
    await supervisor.synchronizeAccountState(onlineUserB);
    assert.equal(supervisor.getAgentEntry(onlineUserB).available, true);
    await assertImportedLegacyData(
      proxy,
      importedProfile,
      [session.value.id, replaySession.value.id],
      completedToolRunId,
      replayRunId,
      workspaceRef,
    );
    assert.equal(
      provider((await api(proxy, "/api/v1/ai/providers")).value, PROVIDER_ID).credentialSource,
      "LOCAL",
    );
    const importedRunStart = calls.length;
    const postRestoreRunId = await runToCompletion(
      proxy,
      replaySession.value.id,
      workspaceRef,
      "continue imported account model configuration",
      "POST_RESTORE_RUN",
      MODEL_ID,
    );
    const importedCalls = calls
      .slice(importedRunStart)
      .filter((call) => call.path === "/v1/chat/completions");
    assert.ok(importedCalls.length > 0);
    assert.ok(importedCalls.every((call) => call.key === LEGACY_KEY));
    assert.equal((await api(proxy, `/api/v1/runs/${postRestoreRunId}`)).value.status, "COMPLETED");
    for (const call of calls) {
      for (const secret of [INITIAL_KEY, REPLACEMENT_KEY, ENVIRONMENT_KEY, LEGACY_KEY]) {
        assert.equal(call.body.includes(secret), false);
      }
    }
    await supervisor.closeForApplicationQuit();
    supervisor = undefined;
    await assertNoFixtureSecretsInLogs(
      profileManager,
      [USER_A, USER_B],
      [INITIAL_KEY, REPLACEMENT_KEY, ENVIRONMENT_KEY, LEGACY_KEY],
    );
    assert.equal(await hashTree(legacySourceRoot), legacyHashBefore);
    await appendFile(markerPath, "BACKUP_RESTORE_AND_RECOVERY_VERIFIED\n", "utf8");
    await appendFile(markerPath, "D4_2_WINDOWS_ELECTRON_FIXTURE=PASS\n", "utf8");
  } catch {
    await appendFile(markerPath, `D4_2_FAILURE_STAGE=${failureStage}\n`, "utf8").catch(
      () => undefined,
    );
    await appendFile(markerPath, `D4_2_PROXY_FETCH_FAILURE=${proxyFetchFailure}\n`, "utf8").catch(
      () => undefined,
    );
    const entry = supervisor?.getAgentEntry(createOnlineState(diagnosticUserId));
    await appendFile(
      markerPath,
      `D4_2_DAEMON_STATE=${entry?.available ? "READY" : (entry?.reason ?? "UNKNOWN")}\n`,
      "utf8",
    ).catch(() => undefined);
    await appendFile(markerPath, `D4_2_FIXTURE_REQUEST_COUNT=${calls.length}\n`, "utf8").catch(
      () => undefined,
    );
    await appendFile(markerPath, "D4_2_WINDOWS_ELECTRON_FIXTURE=FAIL\n", "utf8").catch(
      () => undefined,
    );
    process.exitCode = 1;
  } finally {
    await supervisor?.closeForApplicationQuit().catch(() => undefined);
    if (fixture !== undefined) await closeServer(fixture);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    app.quit();
  }
});

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  const key = request.headers.authorization?.replace(/^Bearer /u, "") ?? null;
  const pathname = request.url ?? "/";
  calls.push({ path: pathname, key, body });
  if (pathname === "/v1/models" && request.method === "GET") {
    if (key !== INITIAL_KEY && key !== REPLACEMENT_KEY && key !== LEGACY_KEY) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture authentication failed" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          { id: MODEL_ID, object: "model", owned_by: "fixture" },
          { id: REPLAY_MODEL_ID, object: "model", owned_by: "fixture" },
        ],
      }),
    );
    return;
  }
  if (pathname === "/v1/chat/completions" && request.method === "POST") {
    if (key !== INITIAL_KEY && key !== REPLACEMENT_KEY && key !== LEGACY_KEY) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture authentication failed" } }));
      return;
    }
    let isReview = false;
    try {
      isReview = JSON.stringify(JSON.parse(body)).includes("Review the supplied");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const text = isReview
      ? JSON.stringify({ verdict: "PASS", summary: "Fixture run output is acceptable." })
      : "The local Desktop fixture run completed.";
    const isCompletedToolFixture = body.includes("successful imported tool fixture");
    const isNativeReplayFixture = body.includes("legacy native replay fixture");
    if (
      !isReview &&
      ((isCompletedToolFixture && !completedLegacyToolTurnStarted) ||
        (isNativeReplayFixture && !nativeReplayToolTurnStarted))
    ) {
      if (isCompletedToolFixture) completedLegacyToolTurnStarted = true;
      if (isNativeReplayFixture) nativeReplayToolTurnStarted = true;
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({
          id: "caelush-d4-2-native-replay-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: isNativeReplayFixture ? REPLAY_MODEL_ID : MODEL_ID,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      const reasoning = isNativeReplayFixture
        ? chunk({ reasoning_content: "Inspect the requested fixture file." })
        : "";
      const toolCallId = isNativeReplayFixture
        ? "call_d4_native_replay_read"
        : "call_d4_legacy_read";
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.end(
        `${reasoning}${chunk({
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "fixture.txt" }) },
            },
          ],
        })}${chunk({}, "tool_calls")}data: [DONE]\n\n`,
      );
      return;
    }
    const chunk = (content: string, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id: "caelush-d4-2-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finishReason }],
      })}\n\n`;
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.end(`${chunk(text, null)}${chunk("", "stop")}data: [DONE]\n\n`);
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "fixture route not found" } }));
}

async function runToCompletion(
  proxy: DesktopLocalProxy,
  sessionId: string,
  workspace: { readonly id: string; readonly path: string },
  goal: string,
  label: string,
  modelId = MODEL_ID,
  expectedStatus: "COMPLETED" | "FAILED" = "COMPLETED",
): Promise<string> {
  failureStage = `${label}_CREATE`;
  const created = await api(proxy, `/api/v1/sessions/${sessionId}/runs`, {
    method: "POST",
    body: {
      goal,
      workspace,
      model: { provider: PROVIDER_ID, model: modelId },
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 45_000 },
    },
  });
  const runId = String(created.value.id);
  failureStage = `${label}_START`;
  await api(proxy, `/api/v1/runs/${runId}/start`, { method: "POST" });
  failureStage = `${label}_POLL`;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await api(proxy, `/api/v1/runs/${runId}`);
    if (current.value.status === expectedStatus) break;
    if (
      ["FAILED", "CANCELLED", "BUDGET_EXCEEDED", "TIMEOUT", "MAX_STEPS_REACHED"].includes(
        current.value.status,
      )
    ) {
      failureStage = await safeRunFailureStage(label, current.value.status, runId);
      throw new Error("fixture run did not complete");
    }
    if (attempt === 299) throw new Error("fixture run timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const current = await api(proxy, `/api/v1/runs/${runId}`);
  assert.equal(current.value.status, expectedStatus);
  failureStage = `${label}_TRANSCRIPT`;
  const transcript = await api(proxy, `/api/v1/sessions/${sessionId}/transcript?limit=50`);
  assert.ok(Array.isArray(transcript.value.items));
  return runId;
}

async function safeRunFailureStage(label: string, status: string, runId: string): Promise<string> {
  const profile = await diagnosticProfiles!.selectForUser(diagnosticUserId);
  const database = new DatabaseSync(profile.databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT data_json FROM agent_events WHERE run_id = ? AND event_type = 'run.failed' ORDER BY aggregate_sequence DESC LIMIT 1",
      )
      .get(runId) as { readonly data_json: string } | undefined;
    if (row === undefined) return `${label}_${status}_NO_FAILURE_EVENT`;
    const parsed = JSON.parse(row.data_json) as {
      readonly payload?: {
        readonly error?: {
          readonly code?: unknown;
          readonly message?: unknown;
          readonly details?: { readonly continuityReason?: unknown };
        };
      };
    };
    const error = parsed.payload?.error;
    const continuityReason = error?.details?.continuityReason;
    const reason = new Set([
      "LEGACY_REPLAY_MISSING",
      "REPLAY_DATA_UNAVAILABLE",
      "PROVIDER_INCOMPATIBLE",
      "MODEL_INCOMPATIBLE",
    ]).has(String(continuityReason))
      ? String(continuityReason)
      : "NO_CONTINUITY_REASON";
    const code = new Set([
      "MODEL_ERROR",
      "CONVERSATION_CONTINUITY_INCOMPATIBLE",
      "NETWORK_ERROR",
    ]).has(String(error?.code))
      ? String(error?.code)
      : "OTHER_ERROR";
    const safeMessage =
      error?.message === "Required native replay is unavailable for the selected conversation."
        ? "NATIVE_REPLAY_UNAVAILABLE"
        : error?.message ===
            "This conversation cannot safely continue with the selected model. Start a new session in the same workspace."
          ? "CONTINUITY_PRECHECK_FAILED"
          : "OTHER_MESSAGE";
    return `${label}_${status}_${reason}_${code}_${safeMessage}`;
  } finally {
    database.close();
  }
}

async function api(
  proxy: DesktopLocalProxy,
  route: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly allowFailure?: boolean;
  } = {},
): Promise<{ readonly status: number; readonly value: any; readonly text: string }> {
  const method = options.method ?? "GET";
  const serializedBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  const requestBody =
    serializedBody === undefined
      ? undefined
      : new Request("http://renderer.invalid/", { method, body: serializedBody }).body;
  const request = {
    url: `caelush-app://app${route}`,
    method,
    headers: new Headers(
      serializedBody === undefined ? {} : { "content-type": "application/json" },
    ),
    body: requestBody ?? null,
    signal: new AbortController().signal,
    referrer: "",
    initiatorOrigin: "caelush-app://app",
  } as Request;
  const response = await proxy.handle(request);
  const text = await response.text();
  let value: any = undefined;
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("local API response was invalid");
    }
  }
  if (!options.allowFailure && (response.status < 200 || response.status >= 300)) {
    const responseCode = value?.error?.code;
    failureStage = `HTTP_${method}_${response.status}_${
      typeof responseCode === "string" && /^[A-Z0-9_]{1,64}$/u.test(responseCode)
        ? responseCode
        : "NO_CODE"
    }`;
    throw new Error("local API request failed");
  }
  return { status: response.status, value, text };
}

function provider(payload: any, id: string): any {
  const item =
    payload.providers?.find((entry: any) => entry.id === id) ??
    (payload.provider?.id === id ? payload.provider : undefined);
  assert.ok(item);
  return item;
}

async function assertNoCredentialInSQLite(
  profileManager: ProfileManager,
  userId: string,
  secrets: readonly string[],
): Promise<void> {
  const profile = await profileManager.selectForUser(userId);
  const database = new DatabaseSync(profile.databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT provider_id, secret_value FROM ai_provider_credentials")
      .all() as Array<{ readonly secret_value: string }>;
    assert.equal(rows.length, 0);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    database.close();
  }
  const candidates = [
    profile.databasePath,
    `${profile.databasePath}-wal`,
    `${profile.databasePath}-shm`,
  ];
  for (const file of candidates) {
    const bytes = await readFile(file).catch(() => undefined);
    if (bytes === undefined) continue;
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
}

function createOnlineState(userId = USER_A): AccountState {
  return {
    status: "AUTHENTICATED_ONLINE",
    account: {
      userId,
      email: "d4-2-fixture@example.invalid",
      emailVerified: true,
      entitlements: [],
      createdAt: "2026-10-10T00:00:00.000Z",
    },
    lastError: null,
    notice: null,
    agentEntry: { available: false, reason: "DAEMON_STARTING" },
  };
}

async function createRealLegacyFixture(
  profileManager: ProfileManager,
  legacyRoot: string,
  checkpointRunId: string,
): Promise<void> {
  const profile = await profileManager.selectForUser(USER_A);
  await mkdir(legacyRoot, { recursive: true });
  const database = new DatabaseSync(profile.databasePath);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec("PRAGMA journal_mode = DELETE");
    const snapshotPath = path.join(legacyRoot, "caelush.db").replaceAll("'", "''");
    database.exec(`VACUUM INTO '${snapshotPath}'`);
  } finally {
    database.close();
  }
  for (const directory of ["runs", "run", "private-replay-keys"] as const) {
    const source = path.join(profile.rootDirectory, directory);
    const destination = path.join(legacyRoot, directory);
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  const legacy = new DatabaseSync(path.join(legacyRoot, "caelush.db"));
  try {
    legacy
      .prepare(
        "INSERT INTO ai_provider_credentials (provider_id, secret_value, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(PROVIDER_ID, LEGACY_KEY, Date.now(), Date.now());
    const legacyRun = legacy.prepare("SELECT id FROM agent_runs WHERE id = ?").get(checkpointRunId);
    assert.ok(legacyRun);
    const checkpoint = {
      version: 1,
      goal: "Imported context fixture checkpoint",
      constraints: ["Preserve local history"],
      completedWork: ["Read fixture.txt"],
      inProgress: [],
      blocked: [],
      importantDiscoveries: ["The legacy workspace remains available locally."],
      keyDecisions: ["Keep source data unchanged."],
      changedFiles: [],
      readFiles: ["fixture.txt"],
      recentErrors: [],
      verificationState: "Verified by local fixture run",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "No active processes",
      criticalReferences: ["fixture.txt"],
      nextIntent: "Continue the imported Session",
      sourceRange: { from: 1, to: 2, kind: "DURABLE_MESSAGE_SEQUENCE" },
    };
    legacy
      .prepare(
        `INSERT INTO context_checkpoints
         (id, run_id, previous_checkpoint_id, source_sequence_from, source_sequence_to,
          tokens_before, tokens_after, summary_version, model_ref_json, created_at_ms,
          data_json, read_file_refs_json, changed_file_refs_json)
         VALUES (?, ?, NULL, 1, 2, 100, 30, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        "context-fixture-imported",
        checkpointRunId,
        JSON.stringify({ providerId: PROVIDER_ID, modelId: REPLAY_MODEL_ID }),
        Date.now(),
        JSON.stringify(checkpoint),
        JSON.stringify(["fixture.txt"]),
        JSON.stringify([]),
      );
    legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.equal(legacy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    legacy.close();
  }
}

async function assertNativeReplayWasStored(
  profileManager: ProfileManager,
  userId: string,
  runId: string,
): Promise<void> {
  const profile = await profileManager.selectForUser(userId);
  const database = new DatabaseSync(profile.databasePath, { readOnly: true });
  try {
    const invocationCount = Number(
      (
        database
          .prepare("SELECT count(*) AS count FROM tool_invocations WHERE run_id = ?")
          .get(runId) as { count: number }
      ).count,
    );
    const replayCount = Number(
      (
        database
          .prepare("SELECT count(*) AS count FROM private_replays WHERE run_id = ?")
          .get(runId) as { count: number }
      ).count,
    );
    assert.ok(invocationCount >= 1);
    assert.ok(replayCount >= 1);
  } finally {
    database.close();
  }
  await readFile(path.join(profile.rootDirectory, "private-replay-keys", "master.v1.json"));
}

async function assertNoFixtureSecretsInLogs(
  profileManager: ProfileManager,
  userIds: readonly string[],
  secrets: readonly string[],
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await (
      await import("node:fs/promises")
    ).readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile()) {
        const content = await readFile(file);
        for (const secret of secrets) assert.equal(content.includes(Buffer.from(secret)), false);
      }
    }
  };
  for (const userId of userIds) {
    const profile = await profileManager.selectForUser(userId);
    await visit(profile.logsDirectory);
  }
}

async function assertImportedLegacyData(
  proxy: DesktopLocalProxy,
  profile: Awaited<ReturnType<ProfileManager["selectForUser"]>>,
  expectedSessionIds: readonly string[],
  expectedRunId: string,
  replayRunId: string,
  workspace: { readonly id: string; readonly path: string },
): Promise<void> {
  failureStage = "LEGACY_VERIFY_SESSION_LIST";
  const sessions = await api(proxy, "/api/v1/sessions?limit=50");
  for (const expectedSessionId of expectedSessionIds) {
    failureStage = "LEGACY_VERIFY_SESSION_ID";
    assert.ok(sessions.value.items.some((item: { id: string }) => item.id === expectedSessionId));
    failureStage = "LEGACY_VERIFY_TRANSCRIPT";
    const transcript = await api(
      proxy,
      `/api/v1/sessions/${expectedSessionId}/transcript?limit=50`,
    );
    assert.ok(transcript.value.items.length > 0);
  }
  failureStage = "LEGACY_VERIFY_RUN";
  const currentRun = await api(proxy, `/api/v1/runs/${expectedRunId}`);
  assert.equal(currentRun.value.status, "COMPLETED");
  failureStage = "LEGACY_VERIFY_REPLAY_RUN";
  const replayRun = await api(proxy, `/api/v1/runs/${replayRunId}`);
  assert.equal(replayRun.value.status, "FAILED");
  failureStage = "LEGACY_VERIFY_WORKSPACE";
  const workspaces = await api(proxy, "/api/v1/workspaces?limit=50");
  assert.ok(workspaces.value.items.some((item: { id: string }) => item.id === workspace.id));
  failureStage = "LEGACY_VERIFY_EVENT_REPLAY";
  await assertReplayRoute(proxy, expectedRunId);
  failureStage = "LEGACY_VERIFY_IMPORTED_TABLES";
  const database = new DatabaseSync(profile.databasePath, { readOnly: true });
  try {
    assert.ok(
      Number(
        (
          database
            .prepare("SELECT count(*) AS count FROM agent_events WHERE run_id = ?")
            .get(expectedRunId) as { count: number }
        ).count,
      ) > 0,
    );
    assert.ok(
      Number(
        (
          database
            .prepare("SELECT count(*) AS count FROM tool_invocations WHERE run_id = ?")
            .get(expectedRunId) as { count: number }
        ).count,
      ) > 0,
    );
    assert.ok(
      Number(
        (
          database
            .prepare("SELECT count(*) AS count FROM context_checkpoints WHERE run_id = ?")
            .get(expectedRunId) as { count: number }
        ).count,
      ) > 0,
    );
    assert.ok(
      Number(
        (
          database
            .prepare("SELECT count(*) AS count FROM private_replays WHERE run_id = ?")
            .get(replayRunId) as { count: number }
        ).count,
      ) > 0,
    );
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    database.close();
  }
  failureStage = "LEGACY_VERIFY_REPLAY_KEY";
  const replayKeyPath = path.join(profile.rootDirectory, "private-replay-keys", "master.v1.json");
  await readFile(replayKeyPath);
  const replayModulePath = path.resolve(
    appRoot,
    "..",
    "daemon",
    "dist",
    "replay",
    "replay-key-provider.js",
  );
  const replayModule = (await import(pathToFileURL(replayModulePath).href)) as {
    createWindowsReplayKeyProvider(keyFile: string): { current(): Promise<{ bytes: Buffer }> };
  };
  const replayKey = await replayModule.createWindowsReplayKeyProvider(replayKeyPath).current();
  replayKey.bytes.fill(0);
}

async function assertReplayRoute(proxy: DesktopLocalProxy, runId: string): Promise<void> {
  const request = {
    url: `caelush-app://app/api/v1/runs/${runId}/events?afterSequence=0`,
    method: "GET",
    headers: new Headers(),
    body: null,
    signal: new AbortController().signal,
    referrer: "",
    initiatorOrigin: "caelush-app://app",
  } as Request;
  const response = await proxy.handle(request);
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    await Promise.race([
      (async () => {
        for (let index = 0; index < 100; index += 1) {
          const part = await reader.read();
          if (part.done) break;
          output += decoder.decode(part.value, { stream: true });
          if (output.includes("run.completed")) return;
        }
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("event replay timeout")), 15_000),
      ),
    ]);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  assert.match(output, /id:\s*\d+/u);
  assert.ok(output.includes("run.completed"));
}

async function hashTree(root: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readdir, stat } = await import("node:fs/promises");
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const metadata = await stat(file);
      if (metadata.isDirectory()) await visit(file);
      else
        hash
          .update(path.relative(root, file).split(path.sep).join("/"))
          .update(await readFile(file));
    }
  };
  await visit(root);
  return hash.digest("hex");
}

function createOfflineState(online: AccountState): AccountState {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  return {
    ...online,
    status: "AUTHORIZED_OFFLINE",
    offlineGrant: { issuedAt, expiresAt, entitlements: [], remainingHours: 1 },
  };
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error("smoke configuration missing");
  return value;
}
