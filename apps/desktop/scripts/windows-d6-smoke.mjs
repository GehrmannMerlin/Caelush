import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyDesktopResourceFiles } from "../src/shared/resource-manifest.mjs";
import {
  assertInstallRegistration,
  assertSuccessfulProcessExit,
  assertSuccessfulShutdown,
  buildNsisInstallArguments,
  buildNsisUninstallArguments,
  buildPersistentBrowserFixtureCookie,
  classifyD5TestMainSmokeResult,
  createPersistentSnapshotRecord,
  desktopInstallRegistryKey,
  desktopUninstallRegistryKey,
  findCompletedInstalledSession,
  isInstalledAgentEntryReady,
  normalizeRegistryRegistrationSnapshot,
} from "./windows-d6-acceptance-helpers.mjs";
import { startD6ProviderFixture, startInternalCloudFixture } from "./windows-d6-fixtures.mjs";
import { startLocalUpdateFixture } from "./local-update-fixture.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("D6 installed smoke requires Windows x64.");
}

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(APP_ROOT, "..", "..");
const RUN_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
const D72_INPUT = process.env.CAELUSH_D72_SMOKE_INPUT
  ? JSON.parse(await readFile(process.env.CAELUSH_D72_SMOKE_INPUT, "utf8"))
  : null;
const OUTPUT_ROOT = path.resolve(
  process.env.CAELUSH_DESKTOP_OUTPUT_ROOT ?? path.join("D:\\", `Caelush D6 Recovery ${RUN_ID}`),
);
const INSTALLER_PATH = path.resolve(
  process.env.CAELUSH_D6_INSTALLER_PATH ??
    path.join(OUTPUT_ROOT, "Caelush-0.1.0-dev-win-x64-Setup.exe"),
);
const TEST_ROOT = path.join(OUTPUT_ROOT, `D6 Test Data ${RUN_ID}`);
const INSTALL_ROOT = path.join(OUTPUT_ROOT, `D6 安装目录 With Spaces ${RUN_ID}`);
const USER_DATA_ROOT = path.join(TEST_ROOT, "electron-user-data");
const USER_APP_DATA_ROOT = path.join(TEST_ROOT, "roaming-app-data");
const LOCAL_APP_DATA_ROOT = path.join(TEST_ROOT, "local-app-data");
const USER_TEMP_ROOT = path.join(TEST_ROOT, "temp");
const USER_PROFILE_ROOT = path.join(TEST_ROOT, "user-profile");
const LEGACY_HOME = path.join(TEST_ROOT, "legacy-caelush-home");
const INSTALLER_TEMP_ROOT = path.join(OUTPUT_ROOT, ".nsis-temp");
const INTERNAL_TEST_IDENTITY_PATH = path.join(OUTPUT_ROOT, ".d6-internal-test-identity.json");
const BUILD_IDENTITY_SEED_PATH = path.join(OUTPUT_ROOT, ".d6-build-input-identity.json");
const ELECTRON_RUNTIME_STAGE_ROOT = path.join(TEST_ROOT, `electron-runtime-stage-${RUN_ID}`);
const LOG_PATH = path.join(OUTPUT_ROOT, `D6 Windows Smoke ${RUN_ID}.log`);
const INSTALLED_EXECUTABLE = path.join(INSTALL_ROOT, "Caelush.exe");
const RESOURCE_ROOT = path.join(INSTALL_ROOT, "resources");
const USER_ENV = {
  ...process.env,
  APPDATA: USER_APP_DATA_ROOT,
  LOCALAPPDATA: LOCAL_APP_DATA_ROOT,
  TEMP: USER_TEMP_ROOT,
  TMP: USER_TEMP_ROOT,
  USERPROFILE: USER_PROFILE_ROOT,
  HOME: USER_PROFILE_ROOT,
  CAELUSH_D6_DIAGNOSTICS: "1",
};
const INSTALLER_ENV = {
  ...process.env,
  APPDATA: USER_ENV.APPDATA,
  LOCALAPPDATA: LOCAL_APP_DATA_ROOT,
  TEMP: INSTALLER_TEMP_ROOT,
  TMP: INSTALLER_TEMP_ROOT,
};
const evidence = [];
let installed = false;
let retainTestDataOnFailure = true;
let startMenuShortcutStatus = "NOT_RUN";
let internalTestIdentity;
let localCloudFixture;
let providerFixture;
let currentRuntime;
let nextCdpCommandId = 0;
let installedFixture;
let updateFixture;
let cleanupBlocked = false;

assert.equal(path.parse(OUTPUT_ROOT).root.toLowerCase(), "d:\\");
assert.ok(
  !isPathInside(OUTPUT_ROOT, REPOSITORY_ROOT),
  "D6 build and test output must stay outside the source workspace.",
);
assert.equal(existsSync(TEST_ROOT), false, "The isolated D6 data directory already exists.");
assert.equal(
  existsSync(INSTALL_ROOT),
  false,
  "The isolated D6 installation directory already exists.",
);
await mkdir(TEST_ROOT, { recursive: false });
await mkdir(USER_ENV.APPDATA, { recursive: true });
await mkdir(USER_DATA_ROOT, { recursive: true });
await mkdir(LOCAL_APP_DATA_ROOT, { recursive: true });
await mkdir(USER_TEMP_ROOT, { recursive: true });
await mkdir(USER_PROFILE_ROOT, { recursive: true });
await mkdir(INSTALLER_TEMP_ROOT, { recursive: true });
assertExactChild(TEST_ROOT, OUTPUT_ROOT, path.basename(TEST_ROOT));
assertExactChild(INSTALL_ROOT, OUTPUT_ROOT, path.basename(INSTALL_ROOT));

try {
  const installer = await stat(INSTALLER_PATH);
  assert.ok(
    installer.isFile() && installer.size > 5 * 1024 * 1024,
    "NSIS installer is missing or implausibly small.",
  );
  const installerSha512 = await hashFile(INSTALLER_PATH, "sha512");
  assert.equal(path.parse(INSTALLER_PATH).root.toLowerCase(), "d:\\");
  record(`INSTALLER=${INSTALLER_PATH}`);
  record(`INSTALLER_BYTES=${installer.size}`);
  record(`INSTALLER_SHA512=${installerSha512}`);

  internalTestIdentity = await loadInternalTestIdentity();
  if (D72_INPUT) {
    updateFixture = await startLocalUpdateFixture(
      D72_INPUT.updateIdentity,
      D72_INPUT.versionBInstaller,
    );
    record(`D72_VERSION_A=0.1.0 VERSION_B=0.1.1`);
    record(`D72_REAL_UPDATE_BYTES=${updateFixture.artifactSize}`);
    record(`D72_REAL_UPDATE_SHA512=${updateFixture.sha512}`);
  }
  record(`INTERNAL_TEST_KEY_ID=${internalTestIdentity.keyId}`);
  record(`INTERNAL_TEST_CLOUD_ORIGIN=http://127.0.0.1:${internalTestIdentity.cloudPort}`);
  if (process.env.CAELUSH_D6_CLOUD_FIXTURE_PARENT !== "1") {
    localCloudFixture = await startInternalCloudFixture(internalTestIdentity, updateFixture);
  }

  const existingEntries = await readCaelushUninstallEntries();
  const existingShortcuts = await findCaelushShortcuts();
  const runningInstall = await findRunningCaelushProcesses();
  const existingMachineEntries = await readMachineWideCaelushEntries();
  const existingCurrentUserInstall = await readCurrentUserInstallKey();
  assert.equal(
    existingEntries.length,
    0,
    "An existing Caelush application registration was found; refusing to replace another installation during isolated D6 validation.",
  );
  assert.equal(
    existingShortcuts.length,
    0,
    "An existing Caelush Start Menu or desktop shortcut was found; refusing to replace it during isolated D6 validation.",
  );
  assert.equal(
    runningInstall.length,
    0,
    "A Caelush application process is already running; refusing to collide with its installation identity.",
  );
  assert.equal(
    existingMachineEntries.length,
    0,
    "An existing machine-wide Caelush registration was found; refusing to alter that installation during D6 validation.",
  );
  assert.equal(
    existingCurrentUserInstall,
    null,
    "A current-user Caelush installation key already exists; refusing to replace it during isolated D6 validation.",
  );

  await runInstaller(INSTALLER_PATH, INSTALL_ROOT, INSTALLER_ENV);
  installed = true;
  const registration = await waitForUninstallEntry(INSTALL_ROOT);
  assert.equal(registration.DisplayName, "Caelush 0.1.0");
  assert.equal(registration.DisplayVersion, "0.1.0");
  assert.equal(registration.Scope, "HKCU");
  assert.equal(registration.InstallScope, "HKCU");
  assert.equal(normalizePath(registration.InstallLocation), normalizePath(INSTALL_ROOT));
  record("NSIS_INSTALL_SCOPE=HKCU");
  record(`NSIS_INSTALL_REGISTRY_KEY=${registration.InstallKeyPath}`);
  record(`NSIS_UNINSTALL_REGISTRY_KEY=${registration.UninstallKeyPath}`);
  record("NSIS_SHELL_CONTEXT=CurrentUser");
  record(`NSIS_UNINSTALLER=${registration.ResolvedUninstallerPath}`);
  assert.ok(existsSync(INSTALLED_EXECUTABLE));
  assert.ok(existsSync(path.join(RESOURCE_ROOT, "app.asar")));
  assert.ok(existsSync(path.join(RESOURCE_ROOT, "daemon", "node.exe")));
  assert.ok(existsSync(path.join(RESOURCE_ROOT, "web", "desktop", "index.html")));
  assert.ok(existsSync(path.join(RESOURCE_ROOT, "sandbox-runner", "caelush-sandbox-runner.exe")));
  assert.ok(existsSync(path.join(RESOURCE_ROOT, "daemon", "runtime", "dist", "desktop-entry.js")));
  await assertNoMachineWideRegistration();
  startMenuShortcutStatus = "RUNNING";
  const shortcuts = await findCaelushShortcuts(INSTALLED_EXECUTABLE);
  const startMenuShortcut = shortcuts.find((shortcut) => shortcut.Scope === "StartMenu");
  assert.ok(
    startMenuShortcut,
    "The Start Menu shortcut was not found in the Windows Known Folder.",
  );
  assert.equal(normalizePath(startMenuShortcut.TargetPath), normalizePath(INSTALLED_EXECUTABLE));
  assert.equal(startMenuShortcut.Arguments, "");
  assert.equal(normalizePath(startMenuShortcut.WorkingDirectory), normalizePath(INSTALL_ROOT));
  assert.ok(isPathInside(startMenuShortcut.FullName, startMenuShortcut.KnownFolderPath));
  startMenuShortcutStatus = "PASS";
  record(
    `START_MENU_KNOWN_FOLDER=${shortcuts.find((shortcut) => shortcut.Scope === "StartMenu").KnownFolder}`,
  );
  record("START_MENU_SHORTCUT=PASS");
  record("INSTALL_CURRENT_USER_REGISTRATION_SHORTCUTS=PASS");
  record(`INSTALL_DIRECTORY=${INSTALL_ROOT}`);

  const resourceManifest = JSON.parse(
    await readFile(path.join(RESOURCE_ROOT, "desktop-resource-manifest.json"), "utf8"),
  );
  const resourceVerification = await verifyDesktopResourceFiles(resourceManifest, RESOURCE_ROOT);
  assert.ok(resourceManifest.resourceFiles.some((file) => file.path === "app.asar"));
  assert.equal(resourceManifest.productVersion, "0.1.0");
  assert.equal(resourceManifest.channel, "dev");
  assert.equal(resourceManifest.platform, "win32");
  assert.equal(resourceManifest.architecture, "x64");
  record(`INSTALLED_RESOURCE_MANIFEST_FILES=${resourceVerification.verifiedFiles}`);
  record(`INSTALLED_RESOURCE_SET_SHA256=${resourceVerification.resourceSetDigest}`);
  const buildIdentitySeed = JSON.parse(await readFile(BUILD_IDENTITY_SEED_PATH, "utf8"));
  assert.equal(resourceVerification.resourceSetDigest, buildIdentitySeed.resourceSetSha256);
  record(`INSTALLED_EXECUTABLE_SHA256=${await hashFile(INSTALLED_EXECUTABLE, "sha256")}`);

  providerFixture = await startD6ProviderFixture();
  let backupFixtureLocalAppData = path.join(TEST_ROOT, "d5-harness", "local-app-data");
  if (process.env.CAELUSH_D6_BACKUP_FIXTURE_LOCAL_APP_DATA === undefined) {
    await runPackagedD5Smoke();
  } else {
    backupFixtureLocalAppData = path.resolve(process.env.CAELUSH_D6_BACKUP_FIXTURE_LOCAL_APP_DATA);
    const priorHarnessRoot = path.dirname(backupFixtureLocalAppData);
    const priorTestRoot = path.dirname(priorHarnessRoot);
    assert.match(path.basename(priorTestRoot), /^D6 Test Data [0-9]+-[0-9a-f]{8}$/u);
    assertExactChild(priorTestRoot, OUTPUT_ROOT, path.basename(priorTestRoot));
    assertExactChild(priorHarnessRoot, priorTestRoot, "d5-harness");
    assertExactChild(backupFixtureLocalAppData, priorHarnessRoot, "local-app-data");
    await assertSafeFixtureTree(backupFixtureLocalAppData);
    record("PACKAGED_D5_TEST_MAIN=NOT_RUN_REUSED_BACKUP_SEED_ONLY");
  }
  await prepareInstalledBackupFixture(backupFixtureLocalAppData);
  const firstRuntime = await launchInstalledApplication(INSTALLED_EXECUTABLE, {
    ...USER_ENV,
    CAELUSH_HOME: LEGACY_HOME,
  });
  currentRuntime = firstRuntime;
  record(`INSTALLED_LOGIN_PROTOCOL=${firstRuntime.url}`);
  record(`INSTALLED_LOGIN_UI=${firstRuntime.loginUi ? "PASS" : "FAIL"}`);
  assert.equal(firstRuntime.loginUi, true);
  await authenticateInstalledApplication(firstRuntime, "d6-internal@example.invalid");
  await runInstalledMainSmoke(firstRuntime, providerFixture);
  await closeInstalledApplication(firstRuntime);
  currentRuntime = undefined;
  const completedRunState = inspectFixtureDatabase(LOCAL_APP_DATA_ROOT);
  assert.ok(completedRunState.databasePath.length > 0);
  assert.ok(
    completedRunState.completedRuns > 0,
    "The packaged Agent fixture has no completed Run.",
  );
  assert.ok(
    completedRunState.durableEvents > 0,
    "The packaged Agent fixture has no durable replay events.",
  );
  assert.ok(
    completedRunState.messages > 0,
    "The packaged Agent fixture has no durable conversation records.",
  );
  record(`PACKAGED_AGENT_RUNS_COMPLETED=${completedRunState.completedRuns}`);
  record(`PACKAGED_AGENT_DURABLE_EVENTS=${completedRunState.durableEvents}`);
  record(`PACKAGED_AGENT_MESSAGES=${completedRunState.messages}`);
  assert.ok(
    completedRunState.privateReplays > 0,
    "The installed Native Replay fixture was not persisted.",
  );
  record(`INSTALLED_ENCRYPTED_NATIVE_REPLAY_ROWS=${completedRunState.privateReplays}`);

  const profileRoot = path.dirname(completedRunState.databasePath);
  const backupFixture = path.join(profileRoot, "backups", installedFixture.backupId);
  assert.ok(existsSync(path.join(backupFixture, "manifest.json")));
  assert.ok(
    readdirSync(path.join(backupFixture, "files")).some((file) => file.endsWith(".gcm")),
    "The protected Profile backup contains no encrypted payloads.",
  );
  const retainedBeforeReinstall = await snapshotPersistentData(USER_DATA_ROOT, LOCAL_APP_DATA_ROOT);
  assert.ok(
    retainedBeforeReinstall.some(
      (record) => record.rootId === "userData" && record.relativePath === "credentials.dpapi",
    ),
  );
  assert.ok(
    retainedBeforeReinstall.some(
      (record) =>
        record.rootId === "localAppData" &&
        record.relativePath ===
          createRelativePath(LOCAL_APP_DATA_ROOT, path.join(backupFixture, "manifest.json")),
    ),
  );
  assert.ok(
    retainedBeforeReinstall.some(
      (record) =>
        record.rootId === "localAppData" &&
        record.relativePath ===
          createRelativePath(LOCAL_APP_DATA_ROOT, completedRunState.databasePath),
    ),
  );
  assert.ok(
    retainedBeforeReinstall.some(
      (record) =>
        record.rootId === "localAppData" && record.relativePath.toLowerCase().includes("/browser/"),
    ),
    "The Browser Guest did not persist test Profile data under the browser directory.",
  );
  assert.ok(existsSync(path.join(profileRoot, "browser")));
  assert.ok(existsSync(path.join(profileRoot, "private-replay-keys")));
  record(`PERSISTENT_DATA_FILES=${retainedBeforeReinstall.length}`);

  if (D72_INPUT) await runVerifiedVersionUpgrade();
  else {
    await runInstaller(INSTALLER_PATH, INSTALL_ROOT, INSTALLER_ENV);
    const retainedAfterReinstall = await snapshotPersistentData(
      USER_DATA_ROOT,
      LOCAL_APP_DATA_ROOT,
    );
    assert.deepEqual(retainedAfterReinstall, retainedBeforeReinstall);
  }
  const registrationAfterReinstall = await waitForUninstallEntry(
    INSTALL_ROOT,
    20000,
    D72_INPUT ? "0.1.1" : "0.1.0",
  );
  assert.equal(registrationAfterReinstall.DisplayVersion, D72_INPUT ? "0.1.1" : "0.1.0");
  assert.equal(registrationAfterReinstall.Scope, "HKCU");
  assert.equal(
    normalizePath(registrationAfterReinstall.InstallLocation),
    normalizePath(INSTALL_ROOT),
  );
  const shortcutsAfterReinstall = await findCaelushShortcuts(INSTALLED_EXECUTABLE);
  const startMenuAfterReinstall = shortcutsAfterReinstall.find(
    (shortcut) => shortcut.Scope === "StartMenu",
  );
  assert.ok(startMenuAfterReinstall, "The same-version reinstall lost its Start Menu shortcut.");
  assert.equal(
    normalizePath(startMenuAfterReinstall.TargetPath),
    normalizePath(INSTALLED_EXECUTABLE),
  );
  record(
    D72_INPUT
      ? "D72_VERSION_UPGRADE_DATA_RETAINED=PASS"
      : "SAME_VERSION_REINSTALL_DATA_RETAINED=PASS",
  );

  const reopenedRunState = inspectFixtureDatabase(LOCAL_APP_DATA_ROOT);
  if (D72_INPUT) {
    assert.ok(reopenedRunState.completedRuns >= completedRunState.completedRuns);
    assert.ok(reopenedRunState.durableEvents >= completedRunState.durableEvents);
    assert.ok(reopenedRunState.messages >= completedRunState.messages);
  } else {
    assert.equal(reopenedRunState.completedRuns, completedRunState.completedRuns);
    assert.equal(reopenedRunState.durableEvents, completedRunState.durableEvents);
    assert.equal(reopenedRunState.messages, completedRunState.messages);
  }
  record("RESTART_RESTORED_SQLITE_SESSION_RUN_EVENTS=PASS");

  const secondRuntime = await launchInstalledApplication(INSTALLED_EXECUTABLE, {
    ...USER_ENV,
    CAELUSH_HOME: LEGACY_HOME,
  });
  currentRuntime = secondRuntime;
  await assertRestoredInstalledSession(secondRuntime);
  await closeInstalledApplication(secondRuntime);
  currentRuntime = undefined;

  const retainedBeforeUninstall = await snapshotPersistentData(USER_DATA_ROOT, LOCAL_APP_DATA_ROOT);
  await runUninstaller(registrationAfterReinstall, INSTALL_ROOT, INSTALLER_ENV);
  await waitFor(
    async () => {
      const files = await listRegularFiles(INSTALL_ROOT);
      return (
        files.length <= 1 &&
        files.every((filePath) => path.basename(filePath) === "Uninstall Caelush.exe")
      );
    },
    "installed Caelush application files to be removed",
    30_000,
  );
  const uninstallResidualFiles = await listRegularFiles(INSTALL_ROOT);
  assert.ok(
    uninstallResidualFiles.length === 0 ||
      (uninstallResidualFiles.length === 1 &&
        path.basename(uninstallResidualFiles[0]) === "Uninstall Caelush.exe"),
    "Unexpected files remain in the isolated installation directory after uninstall.",
  );
  record(
    uninstallResidualFiles.length === 0
      ? "UNINSTALL_INSTALL_DIRECTORY_EMPTY=PASS"
      : "UNINSTALL_INSTALL_DIRECTORY_ONLY_NSIS_SELF_UNINSTALLER_REMAINS=EXPECTED",
  );
  installed = false;
  assert.equal((await readCaelushUninstallEntries()).length, 0);
  assert.equal(await readCurrentUserInstallKey(), null);
  assert.equal((await findCaelushShortcuts()).length, 0);
  const retainedAfterUninstall = await snapshotPersistentData(USER_DATA_ROOT, LOCAL_APP_DATA_ROOT);
  assert.deepEqual(retainedAfterUninstall, retainedBeforeUninstall);
  assert.ok(existsSync(path.join(USER_DATA_ROOT, "credentials.dpapi")));
  assert.ok(existsSync(completedRunState.databasePath));
  assert.ok(existsSync(backupFixture));
  record("UNINSTALL_APP_FILES_REGISTRY_SHORTCUTS_REMOVED=PASS");
  record("UNINSTALL_USER_DATA_VAULT_PROFILE_BACKUP_RETAINED=PASS");
  await writeFinalBuildIdentity(buildIdentitySeed, installerSha512);
  record("D6_WINDOWS_INSTALLER_SMOKE=PASS");
  if (D72_INPUT) record("D72_WINDOWS_VERIFIED_VERSION_UPGRADE_SMOKE=PASS");
  retainTestDataOnFailure = false;
} catch (error) {
  if (startMenuShortcutStatus === "RUNNING") startMenuShortcutStatus = "FAIL";
  record(`D6_WINDOWS_INSTALLER_SMOKE=FAIL`);
  record(`D6_FAILURE=${safeError(error)}`);
  throw error;
} finally {
  if (startMenuShortcutStatus === "NOT_RUN") {
    record("START_MENU_SHORTCUT=NOT_RUN");
  } else if (startMenuShortcutStatus === "FAIL") {
    record("START_MENU_SHORTCUT=FAIL");
  }
  if (currentRuntime !== undefined) {
    await closeInstalledApplication(currentRuntime, { cleanup: true }).catch(async (error) => {
      record(`D6_APP_CLEANUP=FAIL ${safeError(error)}`);
      if (D72_INPUT) {
        cleanupBlocked = true;
        record("D72_CLEANUP_WAITING_SAFE_SHUTDOWN=RETAINED");
      } else await terminateProcessTree(currentRuntime.child.pid);
    });
  }
  if (D72_INPUT && (await findRunningCaelushProcesses()).length > 0) {
    cleanupBlocked = true;
    record("D72_CLEANUP_RUNNING_DESKTOP_RETAINED=PASS");
  }
  if (installed && !cleanupBlocked) {
    try {
      const registration = await waitForUninstallEntry(INSTALL_ROOT, 3_000);
      if (registration !== undefined)
        await runUninstaller(registration, INSTALL_ROOT, INSTALLER_ENV);
    } catch (error) {
      record(`D6_CLEANUP_UNINSTALL=BLOCKED ${safeError(error)}`);
    }
  }
  if (providerFixture !== undefined) await providerFixture.close();
  if (localCloudFixture !== undefined) await localCloudFixture.close();
  if (updateFixture !== undefined) await updateFixture.close();
  await writeFile(LOG_PATH, `${evidence.join("\n")}\n`, "utf8");
  process.stdout.write(`${evidence.join("\n")}\nD6_EVIDENCE_LOG=${LOG_PATH}\n`);
  if (!retainTestDataOnFailure && !cleanupBlocked) {
    await rm(TEST_ROOT, { recursive: true, force: true });
    await rm(INSTALL_ROOT, { recursive: true, force: true });
  }
}

async function runInstaller(installerPath, installDirectory, environment) {
  assert.equal(path.parse(installerPath).root.toLowerCase(), "d:\\");
  assert.equal(path.parse(installDirectory).root.toLowerCase(), "d:\\");
  const launch = buildNsisInstallArguments(installDirectory);
  const result = await runProcess(installerPath, launch.args, environment, 600_000, {
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  assert.equal(result.code, 0, `The NSIS installer exited with ${result.code}.`);
  await waitFor(() => existsSync(INSTALLED_EXECUTABLE), "Caelush.exe to be installed", 30_000);
}

/** Uses installed Main + Preload, real TLS bytes, native confirmation and the real NSIS helper. */
async function runVerifiedVersionUpgrade() {
  const runtime = await launchInstalledApplication(INSTALLED_EXECUTABLE, {
    ...USER_ENV,
    CAELUSH_HOME: LEGACY_HOME,
  });
  currentRuntime = runtime;
  await waitFor(
    async () => {
      const state = JSON.parse(
        await evaluateRenderer(
          runtime,
          "window.caelushDesktop.account.getState().then(JSON.stringify)",
        ),
      );
      return state.agentEntry.available ? state : null;
    },
    "A Profile ready before update",
    60000,
  );
  await waitForRenderer(
    runtime,
    "document.querySelector('.desktop-update-panel')?.textContent.includes('Caelush 0.1.0')",
    "installed update UI current version",
  );
  record("D72_INSTALLED_ACCOUNT_UPDATE_UI=PASS");
  await navigateRenderer(runtime, "caelush-app://app/agent/");
  await waitForRenderer(runtime, "window.caelushDesktop !== undefined", "Agent update bridge");
  const updateState = async () =>
    JSON.parse(
      await evaluateRenderer(
        runtime,
        "window.caelushDesktop.update.getState().then(JSON.stringify)",
      ),
    );
  await evaluateRenderer(runtime, "window.caelushDesktop.update.check().then(JSON.stringify)");
  await waitFor(
    async () => {
      const state = await updateState();
      if (state.status === "ERROR") throw new Error(`Update check ${state.errorCode}`);
      return state.status === "UPDATE_AVAILABLE" ? state : null;
    },
    "signed update discovered",
    20000,
  );
  await evaluateRenderer(runtime, "window.caelushDesktop.update.download().then(JSON.stringify)");
  await waitFor(
    async () => {
      const state = await updateState();
      if (state.status === "ERROR") throw new Error(`Update download ${state.errorCode}`);
      return state.status === "READY_TO_INSTALL" ? state : null;
    },
    "real verified NSIS download",
    300000,
  );
  record("D72_MAIN_PINNED_ED25519_HTTPS_STREAM_SIZE_SHA512=PASS");
  await evaluateRenderer(
    runtime,
    `window.caelushDesktop.workspace.terminal.create({workspaceId:${JSON.stringify(installedFixture.workspaceId)},cols:80,rows:24}).then(JSON.stringify)`,
  );
  const liveBrowserBounds = await prepareStableBrowserBounds(runtime);
  await evaluateRenderer(
    runtime,
    `window.caelushDesktop.browser.createLease({bounds:${JSON.stringify(liveBrowserBounds)}}).then(JSON.stringify)`,
  );
  const oldRun = await agentApi(runtime, `/api/v1/runs/${installedFixture.runId}`);
  const capabilities = await agentApi(runtime, "/api/v1/security/capabilities");
  const full = capabilities.value.presets.find((p) => p.id === "FULL_ACCESS");
  const holdScript = path.join(oldRun.value.workspace.path, "d72-held-tool.mjs");
  const toolStarted = path.join(oldRun.value.workspace.path, "d72-tool-started");
  const releaseTool = path.join(oldRun.value.workspace.path, "d72-release-tool");
  await writeFile(
    holdScript,
    `import {writeFile,access} from 'node:fs/promises';\nawait writeFile('d72-tool-started','started');\nconst deadline=Date.now()+25000;\nwhile(Date.now()<deadline){try{await access('d72-release-tool');break;}catch{}await new Promise(r=>setTimeout(r,100));}\nconsole.log('d72-safe-effect-finished');\n`,
    { flag: "wx" },
  );
  providerFixture.queueTool("node ./d72-held-tool.mjs");
  try {
    const count = providerFixture.requests.length;
    const held = await agentApi(runtime, `/api/v1/sessions/${installedFixture.sessionId}/runs`, {
      method: "POST",
      body: {
        goal: "D7-2 controlled safe shutdown pending Tool effect",
        workspace: oldRun.value.workspace,
        model: oldRun.value.model,
        runtime: oldRun.value.runtime,
        preset: { id: "FULL_ACCESS", expectedVersion: full.version },
        ...(oldRun.value.resourcePolicy
          ? { resourcePolicy: oldRun.value.resourcePolicy }
          : { limits: oldRun.value.limits }),
      },
    });
    assert.equal(held.status, 201);
    await agentApi(runtime, `/api/v1/runs/${held.value.id}/start`, { method: "POST" });
    await waitFor(
      () => providerFixture.requests.length > count,
      "held real Agent model turn",
      20000,
    );
    await waitFor(() => existsSync(toolStarted), "real Tool effect started", 20000);
    await evaluateRenderer(runtime, "window.caelushDesktop.update.install().then(JSON.stringify)");
    await clickNativeInstallConfirmation(runtime.child.pid);
    await waitFor(
      async () => {
        const state = await updateState();
        if (state.status === "ERROR") throw new Error(`Safe shutdown ${state.errorCode}`);
        return state.status === "WAITING_FOR_SAFE_SHUTDOWN" &&
          state.message.includes("not confirmed")
          ? state
          : null;
      },
      "real SAFE_CHECKPOINT_PENDING update wait",
      30000,
    );
    const updatesRoot = path.join(LOCAL_APP_DATA_ROOT, "Caelush", "shared", "updates");
    assert.equal(
      (await readdir(updatesRoot)).some(
        (name) => name.endsWith(".handoff.json") || name.endsWith(".receipt.json"),
      ),
      false,
    );
    record("D72_REAL_SAFE_CHECKPOINT_PENDING_NO_INSTALLER=PASS");
    record("D72_ACTIVE_BROWSER_USER_TERMINAL_CONTROLLED_SHUTDOWN=PASS");
    await writeFile(releaseTool, "release", { flag: "wx" });
    await waitFor(
      () => {
        const info = inspectFixtureDatabase(LOCAL_APP_DATA_ROOT);
        const db = new DatabaseSync(info.databasePath, { readOnly: true });
        try {
          return (
            db.prepare("SELECT status FROM agent_runs WHERE id=?").get(held.value.id)?.status ===
            "COMPLETED"
          );
        } finally {
          db.close();
        }
      },
      "held Agent completes through canonical authority",
      30000,
    );
    record("D72_PENDING_TOOL_FINISHES_RUN_COMPLETED=PASS");
    await evaluateRenderer(
      runtime,
      "window.caelushDesktop.update.deferInstall().then(JSON.stringify)",
    );
    await waitFor(
      async () => {
        const state = await updateState();
        return state.status === "INSTALL_DEFERRED";
      },
      "deferred install restores Agent",
      30000,
    );
    await evaluateRenderer(runtime, "window.caelushDesktop.update.install().then(JSON.stringify)");
    await clickNativeInstallConfirmation(runtime.child.pid);
    await waitFor(
      async () => {
        if (runtime.child.exitCode !== null) return true;
        const state = await updateState().catch(() => null);
        if (state?.status === "ERROR")
          throw new Error(`Update install rejected: ${state.errorCode} ${state.message}`);
        return false;
      },
      "old Desktop exits after verified handoff",
      60000,
    );
    assert.equal(runtime.child.exitCode, 0);
    record("D72_OLD_DESKTOP_SAFE_SHUTDOWN_EXIT=PASS");
    currentRuntime = undefined;
    const target = await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/json/list`).catch(
          () => null,
        );
        if (!response?.ok) return null;
        const targets = await response.json();
        return (
          targets.find(
            (t) => t.type === "page" && t.url === "caelush-login://app/" && t.webSocketDebuggerUrl,
          ) ?? null
        );
      },
      "NSIS relaunches real B Desktop",
      300000,
    );
    const newRuntime = { ...runtime, target };
    const completed = await waitFor(
      async () => {
        const state = JSON.parse(
          await evaluateRenderer(
            newRuntime,
            "window.caelushDesktop.update.getState().then(JSON.stringify)",
          ),
        );
        if (state.status === "ERROR")
          throw new Error(`Post-install ${state.errorCode}: ${state.message}`);
        return state.status === "COMPLETED" ? state : null;
      },
      "B runtime Profile post-install completion",
      60000,
    );
    assert.equal(completed.currentVersion, "0.1.1");
    const version = JSON.parse(
      await evaluateRenderer(
        newRuntime,
        "window.caelushDesktop.window.getPlatform().then(JSON.stringify)",
      ),
    );
    assert.equal(version.version, "0.1.1");
    const pending = JSON.parse(await readFile(path.join(updatesRoot, "state.json"), "utf8")).data
      .pending;
    assert.equal(pending.step, "COMPLETED");
    const receipt = JSON.parse(
      await readFile(path.join(updatesRoot, `${pending.transactionId}.receipt.json`), "utf8"),
    );
    assert.equal(receipt.exitCode, 0);
    assert.ok(receipt.installerPid > 0);
    const manifest = JSON.parse(
      await readFile(path.join(RESOURCE_ROOT, "desktop-resource-manifest.json"), "utf8"),
    );
    assert.equal(manifest.productVersion, "0.1.1");
    assert.equal(manifest.daemonVersion, "0.1.1");
    await verifyDesktopResourceFiles(manifest, RESOURCE_ROOT);
    record(`D72_NSIS_EXIT=${receipt.exitCode} PID=${receipt.installerPid}`);
    record("D72_B_DESKTOP_DAEMON_MANIFEST_PROFILE_VAULT_BROWSER_BACKUP_VERIFIED=PASS");
    await assertRestoredInstalledSession(newRuntime);
    await navigateRenderer(newRuntime, "caelush-login://app/");
    await evaluateRenderer(newRuntime, "window.caelushDesktop.window.close().then(()=>true)");
    await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/json/list`).catch(
          () => null,
        );
        return response === null;
      },
      "B graceful close",
      60000,
    );
    record("D72_REAL_UPGRADE_NATIVE_REPLAY_CONTINUATION=PASS");
  } finally {
    if (!existsSync(releaseTool)) await writeFile(releaseTool, "release", { flag: "wx" });
  }
}

async function clickNativeInstallConfirmation(processId) {
  const script = String.raw`
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public class D72Dialog {
public delegate bool EnumProc(IntPtr h,IntPtr p);
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc cb,IntPtr p);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr h,EnumProc cb,IntPtr p);
[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
}
'@
$found=$false;$deadline=[DateTime]::UtcNow.AddSeconds(20)
while(-not $found -and [DateTime]::UtcNow -lt $deadline){
  [D72Dialog]::EnumWindows({param($h,$p)
    [uint32]$owner=0;[void][D72Dialog]::GetWindowThreadProcessId($h,[ref]$owner)
    $text=New-Object Text.StringBuilder 256;[void][D72Dialog]::GetWindowText($h,$text,256)
    if($owner -eq [uint32]$env:CAELUSH_D72_DIALOG_PID -and $text.ToString() -eq 'Install Caelush update'){
      [D72Dialog]::EnumChildWindows($h,{param($button,$unused)
        $name=New-Object Text.StringBuilder 256;[void][D72Dialog]::GetWindowText($button,$name,256)
        if($name.ToString().Replace('&','') -eq 'Install and restart'){[void][D72Dialog]::SendMessage($button,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);$script:found=$true}
        return $true
      },[IntPtr]::Zero)|Out-Null
    };return $true
  },[IntPtr]::Zero)|Out-Null
  Start-Sleep -Milliseconds 100
}
if(-not $found){throw 'Native update confirmation was not found'}
`;
  const result = await runProcess(
    path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { ...USER_ENV, CAELUSH_D72_DIALOG_PID: String(processId) },
    30000,
    { captureOutput: true },
  );
  assert.equal(result.code, 0, `Native update confirmation failed: ${result.output}`);
}

async function loadInternalTestIdentity() {
  const identity = JSON.parse(await readFile(INTERNAL_TEST_IDENTITY_PATH, "utf8"));
  assert.ok(/^d6_test_[0-9a-f-]{36}$/u.test(identity.keyId));
  assert.ok(/^[A-Za-z0-9_-]{43}$/u.test(identity.publicKey));
  assert.ok(Number.isInteger(identity.cloudPort) && identity.cloudPort >= 1024);
  if (D72_INPUT) {
    assert.equal(identity.privateKeyPath, D72_INPUT.accountIdentity.privateKeyPath);
    assertExactChild(
      identity.privateKeyPath,
      path.dirname(OUTPUT_ROOT),
      "offline-test-private.pem",
    );
  } else
    assertExactChild(identity.privateKeyPath, OUTPUT_ROOT, path.basename(identity.privateKeyPath));
  await readFile(identity.privateKeyPath);
  return identity;
}

async function writeFinalBuildIdentity(seed, installerSha512) {
  const installerStat = await stat(INSTALLER_PATH);
  assert.equal(await hashFile(INSTALLER_PATH, "sha512"), installerSha512);
  const harnessInputs = [
    "windows-d6-smoke.mjs",
    "windows-d6-fixtures.mjs",
    "windows-d6-acceptance-helpers.mjs",
    "windows-d6-electron-path-probe.mjs",
  ];
  const harnessDigest = createHash("sha256");
  for (const input of harnessInputs) {
    harnessDigest.update(
      `${input}\0${await hashFile(path.join(APP_ROOT, "scripts", input), "sha256")}\n`,
    );
  }
  const identity = {
    ...seed,
    productVersion: "0.1.0",
    installerPath: INSTALLER_PATH,
    installerSizeBytes: installerStat.size,
    installerSha512,
    installRoot: INSTALL_ROOT,
    validationHarnessSha256: harnessDigest.digest("hex"),
  };
  const identityPath = path.join(OUTPUT_ROOT, "d6-build-identity.final.json");
  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  record(`D6_BUILD_IDENTITY=${identityPath}`);
  record(`D6_BUILD_BASE_SHA=${identity.baseGitSha}`);
  record(`D6_BUILD_INPUT_DIGEST=${identity.dirtyBuildInputDigest}`);
  record(`D6_BUILDER_CONFIG_DIGEST=${identity.electronBuilderConfigDigest}`);
  record(`D6_FINAL_RESOURCE_SET_SHA256=${identity.resourceSetSha256}`);
  record(`D6_INSTALLER_SHA512=${installerSha512}`);
  record(`D6_VALIDATION_HARNESS_SHA256=${identity.validationHarnessSha256}`);
}

async function closeInstalledApplication(runtime, options = {}) {
  // Window-control IPC is Login-only. Returning to that trusted page preserves the active
  // account and Daemon while allowing the product's ordinary graceful window close.
  await navigateRenderer(runtime, "caelush-login://app/");
  await waitForRenderer(
    runtime,
    "window.caelushDesktop !== undefined",
    "Login Preload before close",
  );
  const socket = await openWebSocket(runtime.target.webSocketDebuggerUrl);
  try {
    const result = await cdpRequest(socket, "Runtime.evaluate", {
      expression: "window.caelushDesktop.window.close().then(()=>true)",
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(result.exceptionDetails, undefined);
  } finally {
    socket.close();
  }
  const exitCode = await waitForExit(runtime.child, 45_000);
  assertSuccessfulProcessExit(exitCode, "Caelush Electron");
  const stageRecords = readMainStageRecords(runtime.getOutput());
  const stages = stageRecords.map((record) => record.stage);
  const completedClose = stageRecords.find(
    (record) => record.stage === "DAEMON_GRACEFUL_CLOSE_COMPLETED",
  );
  const daemonExitCode = completedClose?.daemonExitCode;
  assert.ok(stages.includes("DAEMON_GRACEFUL_CLOSE_STARTED"));
  assert.ok(stages.includes("DAEMON_GRACEFUL_CLOSE_COMPLETED"));
  const persisted = inspectFixtureDatabase(LOCAL_APP_DATA_ROOT);
  const persistenceVerified =
    persisted.completedRuns > 0 && persisted.durableEvents > 0 && persisted.messages > 0;
  if (options.cleanup === true) {
    assert.equal(daemonExitCode === null || daemonExitCode === 0, true);
    record("D6_APP_CLEANUP_GRACEFUL_EXIT=PASS");
    return;
  }
  assertSuccessfulShutdown({
    closeCompleted: stages.includes("DAEMON_GRACEFUL_CLOSE_COMPLETED"),
    daemonExitCode,
    persistenceVerified,
  });
  record("INSTALLED_DAEMON_GRACEFUL_EXIT=PASS");
  record(`INSTALLED_DAEMON_EXIT_CODE=${daemonExitCode}`);
  record(`INSTALLED_ELECTRON_EXIT_CODE=${exitCode}`);
  record("INSTALLED_PERSISTENCE_AFTER_CLOSE=PASS");
}

async function runUninstaller(registration, installDirectory, environment) {
  const uninstall = extractUninstallerPath(registration.UninstallString);
  assert.equal(normalizePath(path.dirname(uninstall)), normalizePath(installDirectory));
  assert.ok(existsSync(uninstall), "The registered NSIS uninstaller is missing.");
  const { args, windowsVerbatimArguments } = buildNsisUninstallArguments(installDirectory);
  const result = await runProcess(uninstall, args, environment, 600_000, {
    windowsVerbatimArguments,
  });
  assert.equal(result.code, 0, `The NSIS uninstaller exited with ${result.code}.`);
}

async function runPackagedD5Smoke() {
  const d5TestRoot = path.join(TEST_ROOT, "d5-harness");
  await mkdir(d5TestRoot, { recursive: true });
  const script = path.join(APP_ROOT, "scripts", "windows-d5-smoke.mjs");
  const result = await runProcess(
    process.execPath,
    [script],
    {
      ...USER_ENV,
      CAELUSH_D6_TEST_ROOT: d5TestRoot,
      CAELUSH_D6_RESOURCE_ROOT: RESOURCE_ROOT,
      CAELUSH_D6_ELECTRON_RUNTIME_ROOT: ELECTRON_RUNTIME_STAGE_ROOT,
    },
    300_000,
    { captureOutput: true },
  );
  const smokeResult = classifyD5TestMainSmokeResult(result.code, result.output);
  if (smokeResult === "PROFILE_SWITCH_NOT_RUN_SECURITY_COMPONENT_UNAVAILABLE") {
    for (const marker of [
      "RUN_COMPLETED_SSE_DISCONNECT_REPLAY=PASS",
      "NODE_24_NODE_PTY_CONPTY_UTF8_RESIZE_CTRL_C_RUN_ISOLATION=PASS",
      "WEB_CONTENTS_VIEW_HTTPS_HISTORY_SANDBOX_PROFILE_A=PASS",
      "WORKSPACE_SWITCH_AND_TERMINAL_PROCESS_CLEANUP=PASS",
    ]) {
      assert.ok(
        result.output.includes(marker),
        `The packaged D5 account A fixture missed ${marker}.`,
      );
      record(marker);
    }
    record("PACKAGED_D5_TEST_MAIN_PROFILE_SWITCH=NOT_RUN_SECURITY_COMPONENT_UNAVAILABLE");
    record("PACKAGED_D5_TEST_MAIN=PARTIAL_ACCOUNT_A_FIXTURE");
    return d5TestRoot;
  }
  assert.equal(result.code, 0, `Packaged D5 desktop smoke failed.\n${result.output}`);
  assert.ok(result.output.includes("D5_WINDOWS_ELECTRON_SMOKE=PASS"));
  for (const marker of [
    "RUN_COMPLETED_SSE_DISCONNECT_REPLAY=PASS",
    "NODE_24_NODE_PTY_CONPTY_UTF8_RESIZE_CTRL_C_RUN_ISOLATION=PASS",
    "WEB_CONTENTS_VIEW_HTTPS_HISTORY_SANDBOX_PROFILE_A=PASS",
    "WORKSPACE_SWITCH_AND_TERMINAL_PROCESS_CLEANUP=PASS",
    "ACCOUNT_PROFILE_GENERATION_REVOKE_AND_BROWSER_COOKIE_ISOLATION=PASS",
  ]) {
    assert.ok(result.output.includes(marker), `The packaged D5 smoke did not report ${marker}.`);
    record(marker);
  }
  record("PACKAGED_D5_RUNTIME_FIXTURE=PASS");
  return d5TestRoot;
}

async function prepareInstalledBackupFixture(d5LocalAppData) {
  const d5Run = inspectFixtureDatabase(d5LocalAppData);
  assert.ok(d5Run.completedRuns > 0, "The D5 fixture has no completed source Run.");
  const sourceProfileRoot = path.dirname(d5Run.databasePath);
  await mkdir(LEGACY_HOME, { recursive: false });
  const databaseMetadata = await lstat(d5Run.databasePath);
  assert.equal(databaseMetadata.isSymbolicLink(), false);
  assert.equal(databaseMetadata.isFile(), true);
  assert.equal(databaseMetadata.nlink, 1);
  await copyFile(d5Run.databasePath, path.join(LEGACY_HOME, "caelush.db"));
  let copiedFiles = 1;
  for (const directoryName of ["runs", "run", "private-replay-keys"]) {
    const source = path.join(sourceProfileRoot, directoryName);
    if (!existsSync(source)) continue;
    await assertSafeFixtureTree(source);
    await cp(source, path.join(LEGACY_HOME, directoryName), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    copiedFiles += await countRegularFiles(source);
  }
  assert.ok(copiedFiles > 0);
  record(`INSTALLED_BACKUP_SOURCE_FIXTURE_FILES=${copiedFiles}`);
}

async function launchInstalledApplication(executablePath, environment) {
  const port = await reserveTcpPort();
  const launchEnvironment = { ...environment };
  delete launchEnvironment.CAELUSH_PROVIDER_API_KEY;
  delete launchEnvironment.CAELUSH_DEFAULT_PROVIDER;
  delete launchEnvironment.CAELUSH_DEFAULT_MODEL;
  const child = spawn(
    executablePath,
    [`--user-data-dir=${USER_DATA_ROOT}`, `--remote-debugging-port=${port}`],
    {
      cwd: INSTALL_ROOT,
      env: {
        ...launchEnvironment,
        CAELUSH_D6_DIAGNOSTICS: "1",
        CAELUSH_PROVIDER_ID: providerFixture.providerId,
        CAELUSH_PROVIDER_BASE_URL: providerFixture.origin,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  record(`INSTALLED_LAUNCH_PATH=${executablePath}`);
  record(`INSTALLED_CWD=${INSTALL_ROOT}`);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-24 * 1024);
    });
  }
  try {
    await waitFor(
      () =>
        [
          "MAIN_MODULE",
          "APP_WHEN_READY",
          "MANIFEST_VERIFIED",
          "APP_PROTOCOL_REGISTERED",
          "BROWSER_WINDOW_CREATED",
          "RENDERER_LOAD_FINISHED",
          "ACCOUNT_INITIALIZATION_COMPLETED",
        ].every((stage) => readMainStages(output).includes(stage)),
      "installed production Main, manifest, Preload and Renderer stages",
      60_000,
    );
    const targets = await waitFor(
      async () => {
        if (child.exitCode !== null)
          throw new Error(`Caelush exited early (${child.exitCode}). ${output}`);
        const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
        if (response === null || !response.ok) return null;
        const value = await response.json().catch(() => null);
        return Array.isArray(value)
          ? (value.find(
              (target) =>
                target.type === "page" &&
                target.url === "caelush-login://app/" &&
                String(target.title ?? "").length > 0 &&
                target.webSocketDebuggerUrl,
            ) ?? null)
          : null;
      },
      "loaded installed Caelush login renderer",
      30_000,
    );
    assert.ok(targets?.webSocketDebuggerUrl);
    const login = await inspectRenderer(targets.webSocketDebuggerUrl);
    assert.ok(
      login.url.startsWith("caelush-login://app/"),
      `Unexpected installed login origin: ${login.url}`,
    );
    assert.ok(login.bodyText.length > 0, "The installed login page is blank.");
    assert.equal(login.hasDesktopBridge, true, "The installed Preload bridge did not load.");
    record(`INSTALLED_ELECTRON_SHA256=${await hashFile(executablePath, "sha256")}`);
    record(
      `INSTALLED_RESOURCE_SET_SHA256=${JSON.parse(await readFile(path.join(RESOURCE_ROOT, "desktop-resource-manifest.json"), "utf8")).resourceSetDigest}`,
    );
    record(`INSTALLED_MAIN_STAGES=${readMainStages(output).join(",")}`);
    return {
      url: login.url,
      loginUi: true,
      child,
      port,
      target: targets,
      getOutput: () => output,
    };
  } catch (error) {
    await terminateProcessTree(child.pid);
    const stages = readMainStages(output);
    const classification = !stages.includes("MAIN_MODULE")
      ? "NATIVE_CRASH_BEFORE_MAIN"
      : stages.includes("MANIFEST_REJECT")
        ? "MANIFEST_REJECT"
        : stages.includes("RENDERER_LOAD_FAILED")
          ? "RENDERER_LOAD_FAILURE"
          : stages.includes("RENDERER_LOAD_FINISHED")
            ? "RENDERER_POST_LOAD_INSPECTION_FAILURE"
            : "MAIN_INITIALIZATION_FAILURE";
    record(`INSTALLED_STARTUP_FAILURE_CLASS=${classification}`);
    record(`INSTALLED_STARTUP_FAILURE_STAGES=${stages.join(",")}`);
    throw new Error(`Installed Caelush runtime smoke failed. ${safeError(error)} ${output}`, {
      cause: error,
    });
  }
}

async function inspectRenderer(webSocketUrl) {
  const socket = await openWebSocket(webSocketUrl);
  try {
    const result = await cdpRequest(socket, "Runtime.evaluate", {
      expression:
        "JSON.stringify({url:location.href,title:document.title,bodyText:document.body?.innerText?.slice(0,1200)??'',hasDesktopBridge:typeof window.caelushDesktop==='object'})",
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return JSON.parse(result.result.value);
  } finally {
    socket.close();
  }
}

async function authenticateInstalledApplication(runtime, email) {
  const result = await evaluateRenderer(
    runtime,
    `window.caelushDesktop.account.login({email:${JSON.stringify(email)},password:${JSON.stringify("d6-internal-fixture-password")}}).then(async()=>JSON.stringify(await window.caelushDesktop.account.getState()))`,
  );
  const accountState = JSON.parse(result);
  assert.equal(accountState.status, "AUTHENTICATED_ONLINE");
  assert.equal(accountState.account.email, email);
  assert.ok(accountState.offlineGrant, "The signed internal offline Grant was not accepted.");
  record("INSTALLED_CLOUD_LOGIN_AND_SIGNED_OFFLINE_GRANT=PASS");
  return accountState;
}

async function runInstalledMainSmoke(runtime) {
  const initialState = JSON.parse(
    await evaluateRenderer(
      runtime,
      "window.caelushDesktop.account.getState().then(JSON.stringify)",
    ),
  );
  assert.equal(initialState.status, "AUTHENTICATED_ONLINE");
  const userId = initialState.account.userId;
  const profileId = `u_${createHash("sha256")
    .update("caelush-desktop-profile-v1\0", "utf8")
    .update(userId.toLowerCase(), "utf8")
    .digest("hex")}`;

  const backupResult = await exerciseInstalledBackupRestore(runtime, userId, profileId);

  await waitFor(
    async () => {
      const state = await evaluateRenderer(
        runtime,
        "window.caelushDesktop.account.getState().then(JSON.stringify)",
      );
      return isInstalledAgentEntryReady(JSON.parse(state));
    },
    "the installed Main's authenticated Daemon and Host Token channel",
    60_000,
  );
  record("INSTALLED_DAEMON_HOST_TOKEN_HEALTH_INFO=PASS");

  await navigateRenderer(runtime, "caelush-app://app/agent/");
  await waitForRenderer(runtime, "window.caelushDesktop !== undefined", "installed Agent Preload");
  const panelAvailability = JSON.parse(
    await evaluateRenderer(
      runtime,
      "window.caelushDesktop.workspace.getAvailability().then(JSON.stringify)",
    ),
  );
  assert.equal(panelAvailability.available, true);
  await waitForRenderer(
    runtime,
    "document.querySelector('textarea[aria-label=\"任务输入\"]') !== null",
    "installed Agent UI",
  );
  const daemonInfo = await agentApi(runtime, "/api/v1/info");
  assert.equal(daemonInfo.value.daemonVersion, "0.1.0");
  assert.equal(daemonInfo.value.apiVersion, "v1");
  assert.equal(daemonInfo.value.protocolVersion, 1);
  for (const capability of [
    "desktopHostAuthV1",
    "desktopProfileBindingV1",
    "desktopLocalProxyV1",
    "sessionTranscript",
    "runExecution",
    "sseReplay",
  ])
    assert.equal(daemonInfo.value.capabilities[capability], true);
  record("INSTALLED_DAEMON_VERSION_API_PROTOCOL_CAPABILITIES=PASS:0.1.0/v1/1");
  const importedWorkspaces = await agentApi(runtime, "/api/v1/workspaces");
  assert.ok(
    importedWorkspaces.value.items.length > 0,
    "The protected backup restore did not recover its Workspace through the installed API.",
  );
  record("INSTALLED_PROTECTED_BACKUP_RESTORED_WORKSPACE_API=PASS");

  const workspacePath = path.join(TEST_ROOT, "workspace");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await writeFile(
    path.join(workspacePath, "src", "installed-main.ts"),
    "export const d6 = '安装版';\n",
    "utf8",
  );

  const providerResponse = await agentApi(
    runtime,
    `/api/v1/ai/providers/${providerFixture.providerId}/connect`,
    {
      method: "POST",
      body: { apiKey: providerFixture.apiKey },
    },
  );
  assert.equal(providerResponse.status, 200);
  assert.equal(JSON.stringify(providerResponse.value).includes(providerFixture.apiKey), false);
  record("INSTALLED_PROVIDER_VAULT_WRITE_NO_SECRET_PROJECTION=PASS");
  await agentApi(runtime, "/api/v1/ai/default-selection", {
    method: "PUT",
    body: { provider: providerFixture.providerId, model: providerFixture.modelId },
  });
  await navigateRenderer(runtime, "caelush-app://app/agent/");
  await waitForRenderer(
    runtime,
    "document.querySelector('textarea[aria-label=\"任务输入\"]') !== null",
    "installed Agent UI with the persisted fixture model selection",
  );

  const workspace = await agentApi(runtime, "/api/v1/workspaces", {
    method: "POST",
    body: { path: workspacePath, displayName: "D6 Installed Main Workspace" },
  });
  assert.equal(workspace.status, 201);
  assert.equal(normalizePath(workspace.value.canonicalPath), normalizePath(workspacePath));
  await navigateRenderer(runtime, "caelush-app://app/agent/");
  await waitForRenderer(
    runtime,
    `([...document.querySelectorAll('.workspace-list-button')].some(button=>button.textContent?.includes('D6 Installed Main Workspace')))`,
    "installed Main workspace in production Agent UI",
  );
  await clickRenderer(
    runtime,
    `(()=>{const button=[...document.querySelectorAll('.workspace-list-button')].find(item=>item.textContent?.includes('D6 Installed Main Workspace'));button?.click();return Boolean(button)})()`,
    "registered D6 workspace",
  );
  await evaluateRenderer(
    runtime,
    `window.caelushDesktop.workspace.activate({workspaceId:${JSON.stringify(workspace.value.id)}}).then(JSON.stringify)`,
  );
  const filePage = JSON.parse(
    await evaluateRenderer(
      runtime,
      `window.caelushDesktop.workspace.listEntries({workspaceId:${JSON.stringify(workspace.value.id)},relativePath:'',offset:0,limit:200}).then(JSON.stringify)`,
    ),
  );
  assert.ok(filePage.items.some((entry) => entry.name === "src"));
  const filePreview = JSON.parse(
    await evaluateRenderer(
      runtime,
      `window.caelushDesktop.workspace.previewText({workspaceId:${JSON.stringify(workspace.value.id)},relativePath:'src/installed-main.ts'}).then(JSON.stringify)`,
    ),
  );
  assert.match(filePreview.text, /安装版/u);
  record("INSTALLED_FILES_WORKSPACE_READ_PREVIEW=PASS");

  await confirmInstalledAgentPermission(runtime);
  await clickRenderer(
    runtime,
    "(()=>{const button=document.querySelector('.workspace-list-item--selected .workspace-new-session-button');button?.click();return Boolean(button)})()",
    "New Session button",
  );
  await waitForRenderer(
    runtime,
    "document.querySelector('button[aria-label=\"发送任务\"]')?.disabled === false",
    "installed Agent composer readiness",
  );
  await setInstalledComposer(runtime, "D6 installed production Main scripted Provider run");
  await clickRenderer(
    runtime,
    "(()=>{document.querySelector('button[aria-label=\"发送任务\"]')?.click();return true})()",
    "Send Run button",
  );
  await waitForRenderer(
    runtime,
    `document.body.innerText.includes(${JSON.stringify("The installed D6 Agent fixture run completed.")})`,
    "installed Agent SSE completion from the Scripted Provider",
    90_000,
  );
  const sessionSummary = await waitFor(
    async () => {
      const response = await agentApi(
        runtime,
        `/api/v1/workspaces/${encodeURIComponent(workspace.value.id)}/sessions`,
      );
      return findCompletedInstalledSession(response.value);
    },
    "the installed Run's authoritative durable COMPLETED state",
    60_000,
  );
  assert.ok(sessionSummary?.latestRun, "The installed Main did not persist a completed Run.");
  const sessionId = sessionSummary.session.id;
  const runId = sessionSummary.latestRun.id;
  const run = await agentApi(runtime, `/api/v1/runs/${encodeURIComponent(runId)}`);
  assert.equal(run.value.status, "COMPLETED");
  assert.deepEqual(run.value.model, {
    provider: providerFixture.providerId,
    model: providerFixture.modelId,
  });
  const sseReplay = await readInstalledRunReplay(runtime, runId);
  assert.ok(sseReplay.secondSequence > sseReplay.firstSequence);
  assert.ok(providerFixture.requests.includes("CHAT_COMPLETION"));
  record("INSTALLED_AGENT_COMPLETED_SSE_DISCONNECT_REPLAY=PASS");

  const editors = JSON.parse(
    await evaluateRenderer(
      runtime,
      `window.caelushDesktop.workspace.listEditors({workspaceId:${JSON.stringify(workspace.value.id)}}).then(JSON.stringify)`,
    ),
  );
  assert.ok(Array.isArray(editors));
  assert.ok(editors.every((editor) => ["vscode", "cursor"].includes(editor.id)));
  record(`INSTALLED_IDE_DETECTION=${editors.length > 0 ? "PASS:AVAILABLE" : "PASS:UNAVAILABLE"}`);

  await verifyInstalledTerminal(runtime, workspace.value.id);
  const browserCookieValue = await verifyInstalledBrowserGuest(runtime);
  installedFixture = {
    userId,
    profileId,
    workspaceId: workspace.value.id,
    sessionId,
    runId,
    backupId: backupResult.backupId,
    browserCookieValue,
  };

  const profileDirectory = path.join(LOCAL_APP_DATA_ROOT, "Caelush", "profiles", profileId);
  const profileMetadata = JSON.parse(
    await readFile(path.join(profileDirectory, "profile.json"), "utf8"),
  );
  assert.equal(profileMetadata.profileId, profileId);
  assert.ok(existsSync(path.join(profileDirectory, "browser")));
  assert.ok(existsSync(path.join(USER_DATA_ROOT, "credentials.dpapi")));
  record("INSTALLED_PROFILE_ID_BINDING_DPAPI_VAULT_BROWSER_PROFILE=PASS");

  await navigateRenderer(runtime, "caelush-login://app/");
  const logoutState = JSON.parse(
    await evaluateRenderer(
      runtime,
      "window.caelushDesktop.account.logout().then(()=>window.caelushDesktop.account.getState()).then(JSON.stringify)",
    ),
  );
  assert.equal(logoutState.status, "LOGIN_REQUIRED");
  assert.equal(logoutState.agentEntry.available, false);
  assert.equal(logoutState.agentEntry.reason, "ACCOUNT_NOT_AUTHORIZED");
  record("INSTALLED_LOGOUT_REVOKES_PROFILE_ACCESS=PASS");
  await authenticateInstalledApplication(runtime, "d6-internal@example.invalid");
  await waitFor(
    async () => {
      const state = await evaluateRenderer(
        runtime,
        "window.caelushDesktop.account.getState().then(JSON.stringify)",
      );
      return isInstalledAgentEntryReady(JSON.parse(state));
    },
    "the same account's Profile and Daemon after reauthentication",
    60_000,
  );
  record("INSTALLED_PROFILE_REAUTHENTICATION=PASS");
}

async function exerciseInstalledBackupRestore(runtime, userId, profileId) {
  const summary = JSON.parse(
    await evaluateRenderer(
      runtime,
      "window.caelushDesktop.legacyData.inspect().then(JSON.stringify)",
      60_000,
    ),
  );
  assert.equal(summary.pendingRecovery, false);
  const candidate = summary.sources.find(
    (source) => source.sourceKind === "CUSTOM_HOME" && source.importable,
  );
  assert.ok(
    candidate,
    `The isolated D5 backup source was not accepted by installed Main: ${JSON.stringify(summary)}`,
  );
  const result = JSON.parse(
    await evaluateRenderer(
      runtime,
      `window.caelushDesktop.legacyData.import({candidateId:${JSON.stringify(candidate.candidateId)},confirmed:true}).then(JSON.stringify)`,
      240_000,
    ),
  );
  assert.equal(result.state, "COMMITTED");
  assert.equal(result.profileId, profileId);
  assert.ok(result.backupId);
  assert.ok(result.imported.runs > 0);
  assert.equal(JSON.stringify(result).includes(LEGACY_HOME), false);
  record("INSTALLED_MAIN_PROTECTED_PROFILE_BACKUP_CREATE_VERIFY_DECRYPT_RESTORE=PASS");
  record(`INSTALLED_PROTECTED_BACKUP_ID=${result.backupId}`);
  return result;
}

async function confirmInstalledAgentPermission(runtime) {
  await evaluateRenderer(
    runtime,
    `(()=>{const select=document.querySelector('select[aria-label="选择权限"]');if(!select)throw new Error('permission selector missing');select.value='FULL_ACCESS';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
  );
  await waitForRenderer(
    runtime,
    "[...document.querySelectorAll('[role=dialog] button')].some(button=>button.textContent?.includes('确认使用完全权限'))",
    "isolated text-only fixture permission confirmation",
  );
  await clickRenderer(
    runtime,
    "(()=>{const button=[...document.querySelectorAll('[role=dialog] button')].find(item=>item.textContent?.includes('确认使用完全权限'));button?.click();return Boolean(button)})()",
    "confirm text-only fixture permission",
  );
  await waitForRenderer(
    runtime,
    "document.querySelector('select[aria-label=\"选择权限\"]')?.value==='FULL_ACCESS'",
    "confirmed fixture permission preset",
  );
  record("INSTALLED_AGENT_PERMISSION=PASS:TEXT_ONLY_SCRIPTED_PROVIDER");
}

async function verifyInstalledTerminal(runtime, workspaceId) {
  const expression = `((async()=>{
    const api=window.caelushDesktop;
    const terminal=await api.workspace.terminal.create({workspaceId:${JSON.stringify(workspaceId)},cols:80,rows:24});
    let output='';let unsubscribe;let timer;let cursorReplies=0;let phase='RESIZE';
    try {
      await api.workspace.terminal.resize({terminalId:terminal.terminalId,cols:100,rows:30});
      phase='SUBSCRIBE';
      let resolveOutput;let rejectOutput;
      const received=new Promise((resolve,reject)=>{resolveOutput=resolve;rejectOutput=reject});
      received.catch(()=>undefined);
      timer=setTimeout(()=>rejectOutput(new Error('terminal output timed out')),15000);
      unsubscribe=await api.workspace.terminal.subscribeOutput(terminal.terminalId,(chunk)=>{
        if(chunk.data){
          output=(output+chunk.data).slice(-16384);
          // Emulate xterm's cursor-position reply required by conptyInheritCursor.
          if(chunk.data.includes('\u001b[6n')){
            cursorReplies++;
            void api.workspace.terminal.write({terminalId:terminal.terminalId,data:'\u001b[1;1R'}).catch(rejectOutput);
          }
          void api.workspace.terminal.acknowledgeOutput({terminalId:terminal.terminalId,bytes:new TextEncoder().encode(chunk.data).byteLength}).catch(rejectOutput);
          if(output.includes('D6_TERMINAL_你好')) resolveOutput(output);
        }
        if(chunk.errorCode) rejectOutput(new Error('terminal output error: '+chunk.errorCode));
        if(chunk.exitCode!==undefined) rejectOutput(new Error('terminal exited before output: '+chunk.exitCode));
      });
      phase='WRITE';
      await api.workspace.terminal.write({terminalId:terminal.terminalId,data:${JSON.stringify("Write-Output ('D6_TERMINAL_' + [char]0x4f60 + [char]0x597d)\r")}});
      phase='OUTPUT';
      const value=await received;
      return JSON.stringify({terminalId:terminal.terminalId,output:value,cursorReplies,resize:{cols:100,rows:30}});
    } catch(error) {
      throw new Error('TERMINAL_PROBE_'+phase+': '+String(error?.message??error)+' output='+JSON.stringify(output.slice(-600)),{cause:error});
    } finally {
      clearTimeout(timer);unsubscribe?.();await api.workspace.terminal.close({terminalId:terminal.terminalId});
    }
  })())`;
  const value = JSON.parse(await evaluateRenderer(runtime, expression, 45_000));
  assert.match(value.terminalId, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(value.output, /D6_TERMINAL_你好/u);
  assert.deepEqual(value.resize, { cols: 100, rows: 30 });
  record(`INSTALLED_CONPTY_CURSOR_POSITION_REPLIES=${value.cursorReplies}`);
  record("INSTALLED_NODE24_USER_TERMINAL_POWERSHELL_UTF8_RESIZE_CLOSE=PASS");
}

async function prepareStableBrowserBounds(runtime) {
  await clickRenderer(
    runtime,
    "(()=>{const button=document.querySelector('.desktop-panel-toggle');if(!button)return false;if(button.getAttribute('aria-expanded')!=='true')button.click();return true})()",
    "expand the production Desktop workspace panel",
  );
  await waitForRenderer(
    runtime,
    "document.querySelector('.desktop-panel-tabs') !== null",
    "Desktop panel tabs",
  );
  await clickRenderer(
    runtime,
    "(()=>{const button=[...document.querySelectorAll('.desktop-panel-tabs button')].find(item=>item.textContent?.includes('浏览器'));button?.click();return Boolean(button)})()",
    "production Browser panel tab",
  );
  await waitForRenderer(
    runtime,
    "(()=>{const toggle=document.querySelector('.desktop-panel-toggle');if(toggle?.getAttribute('aria-expanded')==='false'){toggle.click();return false}const tab=[...document.querySelectorAll('.desktop-panel-tabs button')].find(item=>item.textContent?.includes('浏览器'));if(tab&&tab.getAttribute('aria-selected')!=='true'){tab.click();return false}const viewport=document.querySelector('.desktop-browser-viewport');const rect=viewport?.getBoundingClientRect();return viewport?.closest('[hidden]')===null&&rect?.width>=140&&rect?.height>=120})()",
    "visible production Browser viewport",
  );
  let previous;
  let stableSamples = 0;
  return waitFor(
    async () => {
      const serialized = await evaluateRenderer(
        runtime,
        "(()=>{const r=document.querySelector('.desktop-browser-viewport').getBoundingClientRect();const x=Math.ceil(r.left),y=Math.ceil(r.top);return JSON.stringify({x,y,width:Math.floor(Math.min(r.right,innerWidth)-x)-1,height:Math.floor(Math.min(r.bottom,innerHeight)-y)-1})})()",
      );
      stableSamples = serialized === previous ? stableSamples + 1 : 0;
      previous = serialized;
      const bounds = JSON.parse(serialized);
      return stableSamples >= 3 && bounds.width >= 140 && bounds.height >= 120 ? bounds : null;
    },
    "stable Browser panel bounds after the width transition",
    10000,
  );
}

async function verifyInstalledBrowserGuest(runtime, options = {}) {
  const bounds = await prepareStableBrowserBounds(runtime);
  record(`INSTALLED_BROWSER_PANEL_BOUNDS=${JSON.stringify(bounds)}`);
  const targetUrl = "https://example.com/";
  const expression = `((async()=>{const api=window.caelushDesktop;const lease=await api.browser.createLease({bounds:${JSON.stringify(bounds)}});let timer;let unsubscribe;try{const settled=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Browser Guest navigation timed out')),30000);unsubscribe=api.browser.subscribeState((state)=>{if(state.leaseId===lease.leaseId&&state.url===${JSON.stringify(targetUrl)}&&!state.loading)resolve(state)})});settled.catch(()=>undefined);const state=await api.browser.navigate({leaseId:lease.leaseId,url:${JSON.stringify(targetUrl)}});if(!state.loading&&!state.errorCode) return JSON.stringify(state);const final=await settled;return JSON.stringify(final)}finally{clearTimeout(timer);unsubscribe?.()}})())`;
  const state = JSON.parse(await evaluateRenderer(runtime, expression, 45_000));
  assert.equal(state.url, targetUrl);
  assert.equal(state.loading, false);
  assert.equal(state.errorCode, undefined);
  const target = await waitForBrowserGuestTarget(runtime, targetUrl);
  const cookieValue = options.expectedCookieValue ?? `d6-${randomUUID()}`;
  const socket = await openWebSocket(target.webSocketDebuggerUrl);
  let controlledFixtureResponseCount = 0;
  let controlledFixtureFailure;
  let resolveControlledFixture;
  let rejectControlledFixture;
  const controlledFixtureResponse = new Promise((resolve, reject) => {
    resolveControlledFixture = resolve;
    rejectControlledFixture = reject;
  });
  void controlledFixtureResponse.catch(() => undefined);
  const controlledFixtureUrl = `${targetUrl}?caelush-d6-fixture=${randomUUID()}`;
  const controlledFixtureMarker = `CAELUSH_D6_CONTROLLED_HTTPS_${randomUUID()}`;
  const controlledFixtureHtml = Buffer.from(
    `<!doctype html><html><head><meta charset="utf-8"><title>Caelush D6 HTTPS Fixture</title></head><body><main>${controlledFixtureMarker}</main></body></html>`,
    "utf8",
  ).toString("base64");
  const onFetchRequestPaused = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method !== "Fetch.requestPaused") return;
    const request = message.params;
    if (
      options.expectedCookieValue === undefined &&
      request.resourceType === "Document" &&
      request.request.url === controlledFixtureUrl &&
      request.responseStatusCode === 200
    ) {
      controlledFixtureResponseCount += 1;
      void cdpRequest(socket, "Fetch.fulfillRequest", {
        requestId: request.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "content-type", value: "text/html; charset=utf-8" },
          { name: "cache-control", value: "no-store" },
        ],
        body: controlledFixtureHtml,
      }).then(resolveControlledFixture, (error) => {
        controlledFixtureFailure = error;
        rejectControlledFixture(error);
      });
      return;
    }
    void cdpRequest(socket, "Fetch.continueRequest", { requestId: request.requestId }).catch(
      (error) => {
        controlledFixtureFailure = error;
        rejectControlledFixture(error);
      },
    );
  };
  try {
    await cdpRequest(socket, "Network.enable", {});
    if (options.expectedCookieValue === undefined) {
      const setResult = await cdpRequest(
        socket,
        "Network.setCookie",
        buildPersistentBrowserFixtureCookie(cookieValue),
      );
      assert.equal(setResult.success, true);
    }
    const cookies = await cdpRequest(socket, "Network.getCookies", { urls: [targetUrl] });
    assert.ok(
      cookies.cookies.some(
        (cookie) =>
          cookie.name === "caelush_d6_profile_fixture" &&
          cookie.value === cookieValue &&
          cookie.session === false &&
          cookie.expires > Date.now() / 1000,
      ),
      "The Profile's unexpired persistent Browser cookie was not recovered.",
    );
    if (options.expectedCookieValue === undefined) {
      socket.addEventListener("message", onFetchRequestPaused);
      await cdpRequest(socket, "Fetch.enable", {
        patterns: [{ urlPattern: "https://example.com/*", requestStage: "Response" }],
      });
      const fixtureNavigation = await evaluateRenderer(
        runtime,
        `window.caelushDesktop.browser.navigate({leaseId:${JSON.stringify(state.leaseId)},url:${JSON.stringify(controlledFixtureUrl)}}).then(JSON.stringify)`,
        45_000,
      );
      const fixtureState = JSON.parse(fixtureNavigation);
      assert.equal(fixtureState.url, controlledFixtureUrl);
      assert.equal(fixtureState.errorCode, undefined);
      let fixtureTimer;
      try {
        await Promise.race([
          controlledFixtureResponse,
          new Promise((_, reject) => {
            fixtureTimer = setTimeout(
              () => reject(new Error("Controlled HTTPS fixture response timed out.")),
              30_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(fixtureTimer);
      }
      assert.equal(controlledFixtureFailure, undefined);
      assert.equal(controlledFixtureResponseCount, 1);
    }
    const page = await cdpRequest(socket, "Runtime.evaluate", {
      expression:
        "JSON.stringify({url:location.href,protocol:location.protocol,secure:window.isSecureContext,title:document.title,bodyText:document.body?.innerText?.slice(0,256)??'',node:typeof process,require:typeof require})",
      returnByValue: true,
    });
    assert.equal(page.exceptionDetails, undefined);
    const pageState = JSON.parse(page.result.value);
    assert.ok(pageState.bodyText.length > 0);
    assert.equal(pageState.protocol, "https:");
    assert.equal(pageState.secure, true);
    assert.equal(pageState.node, "undefined");
    assert.equal(pageState.require, "undefined");
    if (options.expectedCookieValue === undefined) {
      assert.equal(pageState.url, controlledFixtureUrl);
      assert.equal(pageState.title, "Caelush D6 HTTPS Fixture");
      assert.equal(pageState.bodyText, controlledFixtureMarker);
    }
  } finally {
    socket.removeEventListener("message", onFetchRequestPaused);
    await cdpRequest(socket, "Fetch.disable", {}).catch(() => undefined);
    socket.close();
    await evaluateRenderer(
      runtime,
      `window.caelushDesktop.browser.closeLease({leaseId:${JSON.stringify(state.leaseId)}}).then(()=>true)`,
    );
  }
  record(
    options.expectedCookieValue === undefined
      ? "INSTALLED_BROWSER_GUEST_CONTROLLED_HTTPS_FIXTURE_SANDBOXED_SOURCE=PASS"
      : "INSTALLED_BROWSER_GUEST_HTTPS_SANDBOXED_SOURCE=PASS",
  );
  record("INSTALLED_BROWSER_PROFILE_COOKIE_PERSISTED=PASS");
  return cookieValue;
}

async function waitForBrowserGuestTarget(runtime, expectedUrl) {
  return waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/json/list`).catch(() => null);
      if (response === null || !response.ok) return null;
      const targets = await response.json().catch(() => null);
      return Array.isArray(targets)
        ? (targets.find((target) => target.url === expectedUrl && target.webSocketDebuggerUrl) ??
            null)
        : null;
    },
    "the isolated Browser Guest DevTools target",
    30_000,
  );
}

async function assertRestoredInstalledSession(runtime) {
  const state = await waitFor(
    async () => {
      const current = JSON.parse(
        await evaluateRenderer(
          runtime,
          "window.caelushDesktop.account.getState().then(JSON.stringify)",
        ),
      );
      return current.status === "AUTHENTICATED_ONLINE" && current.agentEntry.available === true
        ? current
        : null;
    },
    "the restored installed account and Profile Daemon",
    60_000,
  );
  assert.equal(state.status, "AUTHENTICATED_ONLINE");
  assert.equal(state.account.userId, installedFixture.userId);
  assert.equal(state.agentEntry.available, true);
  await navigateRenderer(runtime, "caelush-app://app/agent/");
  await waitForRenderer(runtime, "window.caelushDesktop !== undefined", "restarted Agent Preload");
  const models = await agentApi(runtime, `/api/v1/ai/providers/${D6_TEST_PROVIDER_ID()}/models`);
  assert.equal(models.status, 200);
  const run = await agentApi(runtime, `/api/v1/runs/${encodeURIComponent(installedFixture.runId)}`);
  assert.equal(run.value.status, "COMPLETED");
  const replay = await readInstalledRunReplay(runtime, installedFixture.runId);
  assert.ok(replay.secondSequence > replay.firstSequence);
  const capabilities = await agentApi(runtime, "/api/v1/security/capabilities");
  const fullAccess = capabilities.value.presets.find((preset) => preset.id === "FULL_ACCESS");
  assert.ok(fullAccess);
  const priorNativeReplayRequests = providerFixture.requests.filter(
    (entry) => entry === "NATIVE_REPLAY_RESTORED",
  ).length;
  const continuation = await agentApi(
    runtime,
    `/api/v1/sessions/${encodeURIComponent(installedFixture.sessionId)}/runs`,
    {
      method: "POST",
      body: {
        goal: "D6 restored Native Replay continuation after installed application restart",
        workspace: run.value.workspace,
        model: run.value.model,
        runtime: run.value.runtime,
        preset: { id: "FULL_ACCESS", expectedVersion: fullAccess.version },
        ...(run.value.resourcePolicy === undefined
          ? { limits: run.value.limits }
          : { resourcePolicy: run.value.resourcePolicy }),
      },
    },
  );
  assert.equal(continuation.status, 201);
  await agentApi(runtime, `/api/v1/runs/${encodeURIComponent(continuation.value.id)}/start`, {
    method: "POST",
  });
  await waitFor(
    async () => {
      const next = await agentApi(
        runtime,
        `/api/v1/runs/${encodeURIComponent(continuation.value.id)}`,
      );
      if (next.value.status === "COMPLETED") return true;
      assert.equal(
        ["FAILED", "CANCELLED", "TIMEOUT", "MAX_STEPS_REACHED", "BUDGET_EXCEEDED"].includes(
          next.value.status,
        ),
        false,
        "The restarted Native Replay continuation failed.",
      );
      return false;
    },
    "the restored Native Replay model turn",
    90_000,
  );
  assert.ok(
    providerFixture.requests.filter((entry) => entry === "NATIVE_REPLAY_RESTORED").length >
      priorNativeReplayRequests,
    "The restarted Provider request did not use decrypted Native Replay.",
  );
  const transcript = await agentApi(
    runtime,
    `/api/v1/sessions/${encodeURIComponent(installedFixture.sessionId)}/transcript`,
  );
  assert.ok(transcript.value.items.some((item) => item.runId === installedFixture.runId));
  assert.ok(transcript.value.items.some((item) => item.runId === continuation.value.id));
  record("INSTALLED_NATIVE_REPLAY_DECRYPTED_AND_USED_AFTER_RESTART=PASS");
  record("INSTALLED_PROVIDER_KEY_RESTORED_WITHOUT_ENVIRONMENT_CREDENTIAL=PASS");
  record("INSTALLED_HISTORY_READ_FROM_PRODUCTION_API_AFTER_RESTART=PASS");
  const browserCookieValue = await verifyInstalledBrowserGuest(runtime, {
    expectedCookieValue: installedFixture.browserCookieValue,
  });
  assert.equal(browserCookieValue, installedFixture.browserCookieValue);
  record("DPAPI_CLOUD_REFRESH_PROVIDER_KEY_REPLAY_AND_RUN_RESTORED_AFTER_RESTART=PASS");
}

async function readInstalledRunReplay(runtime, runId) {
  const route = `caelush-app://app/api/v1/runs/${encodeURIComponent(runId)}/events`;
  const expression = `(async()=>{async function next(last){const headers=last===undefined?{}:{'last-event-id':String(last)};const response=await fetch(${JSON.stringify(route)},{headers});if(!response.ok||!response.body)throw new Error('SSE replay request failed');const reader=response.body.getReader();let buffer='';const deadline=Date.now()+15000;try{while(Date.now()<deadline){const value=await reader.read();if(value.done)break;buffer+=new TextDecoder().decode(value.value,{stream:true}).replace(/\\r\\n/gu,'\\n');let split;while((split=buffer.indexOf('\\n\\n'))>=0){const block=buffer.slice(0,split);buffer=buffer.slice(split+2);const line=block.split('\\n').find((item)=>item.startsWith('id:'));if(line){const sequence=Number(line.slice(3).trim());if(Number.isSafeInteger(sequence))return sequence}}}throw new Error('No durable SSE event received')}finally{await reader.cancel().catch(()=>{})}}const first=await next(undefined);const second=await next(first);return JSON.stringify({firstSequence:first,secondSequence:second})})()`;
  return JSON.parse(await evaluateRenderer(runtime, expression));
}

async function agentApi(runtime, route, options = {}) {
  const url = `caelush-app://app${route}`;
  const expression = `(async()=>{const response=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(options.method ?? "GET")},headers:${JSON.stringify(options.body === undefined ? {} : { "content-type": "application/json" })},...( ${options.body === undefined ? "false" : "true"} ? {body:${JSON.stringify(options.body === undefined ? "" : JSON.stringify(options.body))}} : {})});const text=await response.text();let value=null;if(text.length)value=JSON.parse(text);if(!response.ok)throw new Error('Agent API request failed ('+response.status+'): '+text.slice(0,400));return JSON.stringify({status:response.status,value})})()`;
  return JSON.parse(await evaluateRenderer(runtime, expression));
}

async function navigateRenderer(runtime, url) {
  const socket = await openWebSocket(runtime.target.webSocketDebuggerUrl);
  try {
    await cdpRequest(socket, "Page.navigate", { url });
  } finally {
    socket.close();
  }
}

async function evaluateRenderer(runtime, expression, timeoutMs = 10_000) {
  const socket = await openWebSocket(runtime.target.webSocketDebuggerUrl);
  try {
    const result = await cdpRequest(
      socket,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    );
    assert.equal(result.exceptionDetails, undefined, "Installed Renderer evaluation failed.");
    return result.result.value;
  } finally {
    socket.close();
  }
}

async function waitForRenderer(runtime, expression, label, timeoutMs = 30_000) {
  await waitFor(
    async () => {
      const result = await evaluateRenderer(runtime, expression).catch(() => "false");
      return result === true || result === "true";
    },
    label,
    timeoutMs,
  );
}

async function clickRenderer(runtime, expression, label) {
  const clicked = await evaluateRenderer(runtime, expression);
  assert.equal(clicked, true, `Installed Renderer control was missing: ${label}`);
}

async function setInstalledComposer(runtime, value) {
  const expression = `(()=>{const element=document.querySelector('textarea[aria-label="任务输入"]');if(!element)return false;const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;setter?.call(element,${JSON.stringify(value)});element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(value)}}));element.dispatchEvent(new Event('change',{bubbles:true}));return true})()`;
  assert.equal(await evaluateRenderer(runtime, expression), true);
}

function D6_TEST_PROVIDER_ID() {
  return "deepseek";
}

async function openWebSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DevTools WebSocket open timed out.")), 10_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("DevTools WebSocket could not be opened."));
      },
      { once: true },
    );
  });
  return socket;
}

async function cdpRequest(socket, method, params, timeoutMs = 10_000) {
  const id = ++nextCdpCommandId;
  return new Promise((resolve, reject) => {
    let timer;
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error !== undefined) reject(new Error(`DevTools rejected ${method}.`));
      else resolve(message.result);
    };
    timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`DevTools command timed out: ${method}`));
    }, timeoutMs);
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function assertSafeFixtureTree(root) {
  const metadata = await lstat(root);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.isDirectory(), true);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const item = await lstat(target);
    assert.equal(item.isSymbolicLink(), false);
    if (item.isDirectory()) await assertSafeFixtureTree(target);
    else {
      assert.equal(item.isFile(), true);
      assert.equal(item.nlink, 1);
    }
  }
}

async function countRegularFiles(root) {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) count += await countRegularFiles(target);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function inspectFixtureDatabase(localAppDataRoot) {
  const databases = findFiles(
    localAppDataRoot,
    (file) => path.basename(file).toLowerCase() === "caelush.db",
  );
  const results = [];
  for (const databasePath of databases) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      if (!tables.has("agent_runs") || !tables.has("agent_events") || !tables.has("agent_messages"))
        continue;
      const completedRuns = Number(
        database
          .prepare("SELECT count(*) AS count FROM agent_runs WHERE status = 'COMPLETED'")
          .get().count,
      );
      const durableEvents = Number(
        database.prepare("SELECT count(*) AS count FROM agent_events").get().count,
      );
      const messages = Number(
        database.prepare("SELECT count(*) AS count FROM agent_messages").get().count,
      );
      const privateReplays = tables.has("private_replays")
        ? Number(database.prepare("SELECT count(*) AS count FROM private_replays").get().count)
        : 0;
      results.push({ databasePath, completedRuns, durableEvents, messages, privateReplays });
    } finally {
      database.close();
    }
  }
  results.sort((left, right) => right.completedRuns - left.completedRuns);
  return (
    results[0] ?? {
      databasePath: "",
      completedRuns: 0,
      durableEvents: 0,
      messages: 0,
      privateReplays: 0,
    }
  );
}

async function snapshotPersistentData(userDataRoot, localAppDataRoot) {
  const entries = [];
  for (const [rootId, root] of [
    ["userData", userDataRoot],
    ["localAppData", localAppDataRoot],
  ]) {
    await collectPersistentFiles(rootId, root, root, entries);
  }
  entries.sort((left, right) =>
    `${left.rootId}/${left.relativePath}`.localeCompare(`${right.rootId}/${right.relativePath}`),
  );
  return entries;
}

async function collectPersistentFiles(rootId, root, directory, entries) {
  if (!existsSync(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const metadata = await lstat(filePath);
    assert.equal(
      metadata.isSymbolicLink(),
      false,
      `Unexpected test data reparse point: ${filePath}`,
    );
    if (metadata.isDirectory()) {
      await collectPersistentFiles(rootId, root, filePath, entries);
      continue;
    }
    if (!metadata.isFile() || !isPersistentDataPath(rootId, root, filePath)) continue;
    entries.push(
      createPersistentSnapshotRecord(rootId, root, filePath, await hashFile(filePath, "sha256")),
    );
  }
}

function isPersistentDataPath(rootId, root, filePath) {
  const relative = path
    .relative(root, filePath)
    .split(path.sep)
    .map((part) => part.toLowerCase());
  if (rootId === "userData") return relative.length === 1 && relative[0] === "credentials.dpapi";
  if (
    relative.length < 4 ||
    relative[0] !== "caelush" ||
    relative[1] !== "profiles" ||
    !/^u_[0-9a-f]{64}$/u.test(relative[2])
  ) {
    return false;
  }
  const profileRelative = relative.slice(3);
  if (profileRelative.length === 1) {
    return profileRelative[0] === "caelush.db" || profileRelative[0] === "profile.json";
  }
  return ["backups", "browser", "downloads", "private-replay-keys", "run", "runs"].includes(
    profileRelative[0],
  );
}

function findFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(filePath, predicate));
    else if (entry.isFile() && predicate(filePath)) found.push(filePath);
  }
  return found;
}

async function listRegularFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const metadata = await lstat(target);
      assert.equal(metadata.isSymbolicLink(), false, "Unexpected install-path reparse point.");
      if (metadata.isDirectory()) await visit(target);
      else if (metadata.isFile()) files.push(target);
      else throw new Error("Unexpected object remained in the isolated install directory.");
    }
  }
  await visit(root);
  return files;
}

async function readCaelushUninstallEntries() {
  const script = String.raw`
  $base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  $items = @(Get-ChildItem -LiteralPath $base -ErrorAction SilentlyContinue | ForEach-Object { $item = Get-ItemProperty -LiteralPath $_.PSPath; if ($item.DisplayName -like 'Caelush*') { [pscustomobject]@{ Scope = 'HKCU'; KeyPath = $_.Name -replace '^HKEY_CURRENT_USER\\', ''; DisplayName = $item.DisplayName; DisplayVersion = $item.DisplayVersion; UninstallString = $item.UninstallString; PSChildName = $_.PSChildName } } })
ConvertTo-Json -InputObject $items -Compress -Depth 5
`;
  const value = await runPowerShellJson(script);
  return Array.isArray(value) ? value : value === null ? [] : [value];
}

async function readCurrentUserInstallKey() {
  const script = String.raw`
$path = Join-Path -Path 'HKCU:\' -ChildPath $env:CAELUSH_D6_INSTALL_REGISTRY_KEY
if (!(Test-Path -LiteralPath $path)) { ConvertTo-Json -InputObject $null -Compress; exit }
$item = Get-ItemProperty -LiteralPath $path
[pscustomobject]@{ Scope = 'HKCU'; KeyPath = $env:CAELUSH_D6_INSTALL_REGISTRY_KEY; InstallLocation = $item.InstallLocation } | ConvertTo-Json -Compress -Depth 4
`;
  return runPowerShellJson(script, registryEnvironment(USER_ENV));
}

async function readCurrentUserRegistrationSnapshot() {
  const script = String.raw`
$installPath = Join-Path -Path 'HKCU:\' -ChildPath $env:CAELUSH_D6_INSTALL_REGISTRY_KEY
$uninstallPath = Join-Path -Path 'HKCU:\' -ChildPath $env:CAELUSH_D6_UNINSTALL_REGISTRY_KEY
$install = $null
if (Test-Path -LiteralPath $installPath) {
  $item = Get-ItemProperty -LiteralPath $installPath
  $install = [pscustomobject]@{ Scope = 'HKCU'; KeyPath = $env:CAELUSH_D6_INSTALL_REGISTRY_KEY; InstallLocation = $item.InstallLocation }
}
if (!(Test-Path -LiteralPath $uninstallPath)) {
  $uninstall = $null
} else {
  $item = Get-ItemProperty -LiteralPath $uninstallPath
  $uninstall = [pscustomobject]@{ Scope = 'HKCU'; KeyPath = $env:CAELUSH_D6_UNINSTALL_REGISTRY_KEY; DisplayName = $item.DisplayName; DisplayVersion = $item.DisplayVersion; UninstallString = $item.UninstallString }
}
[pscustomobject]@{ install = $install; uninstall = $uninstall } | ConvertTo-Json -Compress -Depth 5
`;
  return normalizeRegistryRegistrationSnapshot(
    await runPowerShellJson(script, registryEnvironment(USER_ENV)),
  );
}

async function waitForUninstallEntry(
  expectedInstallRoot,
  timeoutMs = 20_000,
  expectedVersion = "0.1.0",
) {
  let lastFailure = "REGISTRY_KEY_MISSING";
  try {
    return await waitFor(
      async () => {
        let snapshot;
        try {
          snapshot = await readCurrentUserRegistrationSnapshot();
        } catch (error) {
          lastFailure = `REGISTRY_QUERY_FAILED:${safeError(error)}`;
          return null;
        }
        if (snapshot === null) return null;
        try {
          const identity = assertInstallRegistration(
            snapshot,
            expectedInstallRoot,
            expectedVersion,
          );
          const uninstallPath = extractUninstallerPath(snapshot.uninstall.UninstallString);
          return {
            ...snapshot.uninstall,
            InstallLocation: snapshot.install.InstallLocation,
            Scope: identity.scope,
            InstallScope: snapshot.install.scope,
            InstallKeyPath: snapshot.install.keyPath,
            UninstallKeyPath: snapshot.uninstall.keyPath,
            ResolvedUninstallerPath: uninstallPath,
          };
        } catch (error) {
          lastFailure = safeError(error);
          return null;
        }
      },
      "the current-user install and uninstall registry keys",
      timeoutMs,
    );
  } catch {
    throw new Error(lastFailure);
  }
}

async function findCaelushShortcuts(expectedExecutable) {
  const script = String.raw`
$expected = $env:CAELUSH_D6_EXPECTED_EXE
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class D6KnownFolders {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  private static extern void SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint flags, IntPtr token, out IntPtr path);
  public static string Get(string id) {
    IntPtr result;
    SHGetKnownFolderPath(new Guid(id), 0, IntPtr.Zero, out result);
    try { return Marshal.PtrToStringUni(result); } finally { Marshal.FreeCoTaskMem(result); }
  }
}
'@
$roots = @(
  @{ Scope = 'StartMenu'; KnownFolder = 'FOLDERID_Programs'; Path = [D6KnownFolders]::Get('A77F5D77-2E2B-44C3-A6A2-ABA601054A51') },
  @{ Scope = 'Desktop'; KnownFolder = 'FOLDERID_Desktop'; Path = [D6KnownFolders]::Get('B4BFCC3A-DB2C-424C-B029-7FE99A87C641') }
)
$shell = New-Object -ComObject WScript.Shell
$items = @()
foreach ($root in $roots) {
  if (!(Test-Path -LiteralPath $root.Path)) { continue }
  Get-ChildItem -LiteralPath $root.Path -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $shortcut = $shell.CreateShortcut($_.FullName)
    $target = $shortcut.TargetPath
    if ([IO.Path]::GetFileName($target) -ieq 'Caelush.exe' -and ($expected -eq '' -or [IO.Path]::GetFullPath($target) -ieq [IO.Path]::GetFullPath($expected))) {
      $items += [pscustomobject]@{ Scope = $root.Scope; KnownFolder = $root.KnownFolder; FullName = $_.FullName; KnownFolderPath = $root.Path; TargetPath = $target; Arguments = $shortcut.Arguments; WorkingDirectory = $shortcut.WorkingDirectory }
    }
  }
}
ConvertTo-Json -InputObject $items -Compress -Depth 5
`;
  const value = await runPowerShellJson(script, {
    ...process.env,
    CAELUSH_D6_EXPECTED_EXE: expectedExecutable ?? "",
  });
  return Array.isArray(value) ? value : value === null ? [] : [value];
}

async function findRunningCaelushProcesses() {
  const script = String.raw`
$items = @(Get-Process -Name 'Caelush' -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, Path)
ConvertTo-Json -InputObject $items -Compress -Depth 5
`;
  const value = await runPowerShellJson(script);
  return Array.isArray(value) ? value : value === null ? [] : [value];
}

async function assertNoMachineWideRegistration() {
  const entries = await readMachineWideCaelushEntries();
  assert.equal(entries.length, 0, "The D6 installer registered a machine-wide installation.");
}

async function readMachineWideCaelushEntries() {
  const script = String.raw`
$installPath = Join-Path -Path 'HKLM:\' -ChildPath $env:CAELUSH_D6_INSTALL_REGISTRY_KEY
$base = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$items = @(Get-ChildItem -LiteralPath $base -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -like 'Caelush*' } | Select-Object DisplayName, DisplayVersion, InstallLocation)
if (Test-Path -LiteralPath $installPath) { $items += [pscustomobject]@{ DisplayName = 'INSTALL_REGISTRY_KEY'; InstallLocation = (Get-ItemProperty -LiteralPath $installPath).InstallLocation } }
ConvertTo-Json -InputObject $items -Compress -Depth 4
`;
  const value = await runPowerShellJson(script, registryEnvironment(USER_ENV));
  return Array.isArray(value) ? value : value === null ? [] : [value];
}

async function runPowerShellJson(script, environment = USER_ENV) {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ${script}`,
    ],
    { encoding: "utf8", env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (output.length === 0) return null;
  return JSON.parse(output);
}

function registryEnvironment(environment) {
  return {
    ...environment,
    CAELUSH_D6_INSTALL_REGISTRY_KEY: desktopInstallRegistryKey(),
    CAELUSH_D6_UNINSTALL_REGISTRY_KEY: desktopUninstallRegistryKey(),
  };
}

function extractUninstallerPath(value) {
  const match = /^\s*"([^"]+\.exe)"|^\s*([^\s]+\.exe)/iu.exec(value ?? "");
  const executable = match?.[1] ?? match?.[2];
  assert.ok(executable, "The registered uninstaller command is invalid.");
  return executable;
}

async function runProcess(executable, args, environment, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: OUTPUT_ROOT,
      env: environment,
      stdio: options.captureOutput === true ? ["ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments === true,
    });
    let output = "";
    if (options.captureOutput === true) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output = `${output}${String(chunk)}`.slice(-64 * 1024);
          (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
        });
      }
    }
    const timer = setTimeout(() => {
      void terminateProcessTree(child.pid).finally(() =>
        reject(new Error(`Process timed out after ${timeoutMs} ms: ${path.basename(executable)}`)),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === null)
        reject(new Error(`${path.basename(executable)} exited with ${signal}. ${output}`));
      else resolve({ code, output });
    });
  });
}

async function reserveTcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null && child.stdout?.closed === true && child.stderr?.closed === true) {
    return child.exitCode;
  }
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === null) reject(new Error(`Caelush exited from ${signal}.`));
          else resolve(code);
        });
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Caelush did not shut down cleanly.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(condition, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function terminateProcessTree(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return;
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  try {
    execFileSync(taskkill, ["/PID", String(processId), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // The process may have exited while cleanup was being requested.
  }
}

async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizePath(value) {
  return path
    .resolve(value)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

function createRelativePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/gu, "/");
}

function assertExactChild(target, parent, name) {
  const resolvedTarget = path.resolve(target);
  const resolvedParent = path.resolve(parent);
  if (
    path.dirname(resolvedTarget).toLowerCase() !== resolvedParent.toLowerCase() ||
    path.basename(resolvedTarget) !== name
  ) {
    throw new Error("Refusing to mutate an unexpected D6 test path.");
  }
}

function record(line) {
  evidence.push(line);
  process.stdout.write(`${line}\n`);
}

function safeError(error) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 1600);
}

function readMainStages(output) {
  return readMainStageRecords(output).map((record) => record.stage);
}

function readMainStageRecords(output) {
  const stages = [];
  for (const line of output.split(/\r?\n/u)) {
    const marker = /D6_MAIN_STAGE=(\{.*\})/u.exec(line);
    if (marker === null) continue;
    try {
      const parsed = JSON.parse(marker[1]);
      if (typeof parsed.stage === "string") stages.push(parsed);
    } catch {
      stages.push({ stage: "INVALID_STAGE_RECORD" });
    }
  }
  return stages;
}

function isPathInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
