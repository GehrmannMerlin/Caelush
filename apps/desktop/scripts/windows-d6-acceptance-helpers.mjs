import path from "node:path";
import { createHash } from "node:crypto";

const PRODUCT_NAME = "Caelush";
const PRODUCT_VERSION = "0.1.0";
const APP_ID = "com.caelush.desktop";
const INSTALL_REGISTRY_KEY = `Software\\${electronBuilderAppGuid(APP_ID)}`;
const UNINSTALL_REGISTRY_KEY_PREFIX = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\";

export function buildPersistentBrowserFixtureCookie(value, nowMs = Date.now()) {
  return Object.freeze({
    name: "caelush_d6_profile_fixture",
    value,
    url: "https://example.com/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: nowMs / 1000 + 3600,
  });
}

export function isInstalledAgentEntryReady(state) {
  return (
    state !== null &&
    typeof state === "object" &&
    (state.status === "AUTHENTICATED_ONLINE" || state.status === "AUTHORIZED_OFFLINE") &&
    state.agentEntry?.available === true
  );
}

export function findCompletedInstalledSession(response) {
  if (!Array.isArray(response?.items)) throw new Error("INSTALLED_SESSION_RESPONSE_INVALID");
  for (const item of response.items) {
    const status = item.latestRun?.status;
    if (["FAILED", "CANCELLED", "ABANDONED"].includes(status)) {
      throw new Error(`INSTALLED_RUN_TERMINAL_FAILURE:${status}`);
    }
    if (status === "COMPLETED") return item;
  }
  return null;
}

export function assertInstallRegistration(
  snapshot,
  expectedInstallRoot,
  expectedVersion = PRODUCT_VERSION,
) {
  if (snapshot?.install === null || snapshot?.install === undefined) {
    throw new Error("REGISTRY_KEY_MISSING:INSTALL");
  }
  if (snapshot?.uninstall === null || snapshot?.uninstall === undefined) {
    throw new Error("REGISTRY_KEY_MISSING:UNINSTALL");
  }

  const { install, uninstall } = snapshot;
  const requiredInstallFields = ["scope", "keyPath", "InstallLocation"];
  const requiredUninstallFields = [
    "scope",
    "keyPath",
    "DisplayName",
    "DisplayVersion",
    "UninstallString",
  ];
  assertRequiredFields(install, requiredInstallFields, "INSTALL");
  assertRequiredFields(uninstall, requiredUninstallFields, "UNINSTALL");

  if (
    install.scope !== "HKCU" ||
    uninstall.scope !== "HKCU" ||
    install.scope !== uninstall.scope ||
    normalizeRegistryPath(install.keyPath) !== normalizeRegistryPath(INSTALL_REGISTRY_KEY) ||
    normalizeRegistryPath(uninstall.keyPath) !==
      normalizeRegistryPath(`${UNINSTALL_REGISTRY_KEY_PREFIX}${electronBuilderAppGuid(APP_ID)}`)
  ) {
    throw new Error("REGISTRY_PATH_MISMATCH:SCOPE_OR_KEY");
  }

  if (
    uninstall.DisplayName !== `${PRODUCT_NAME} ${expectedVersion}` ||
    uninstall.DisplayVersion !== expectedVersion
  ) {
    throw new Error("REGISTRY_PATH_MISMATCH:PRODUCT_IDENTITY");
  }

  const expected = normalizeWindowsPath(expectedInstallRoot);
  const installLocation = normalizeWindowsPath(install.InstallLocation);
  const uninstallerPath = extractUninstallerPath(uninstall.UninstallString);
  if (
    installLocation !== expected ||
    normalizeWindowsPath(path.win32.dirname(uninstallerPath)) !== expected
  ) {
    throw new Error("REGISTRY_PATH_MISMATCH:INSTALL_ROOT");
  }
  return Object.freeze({ scope: "HKCU", installRoot: expectedInstallRoot });
}

export function buildNsisInstallArguments(installRoot) {
  assertAbsoluteWindowsPath(installRoot, "NSIS install root");
  if (installRoot.includes('"')) throw new Error("NSIS_INSTALL_ROOT_CONTAINS_QUOTE");
  const args = ["/S", "/currentuser", `/D=${installRoot}`];
  if (args.at(-1) !== `/D=${installRoot}` || args.at(-1).includes('"')) {
    throw new Error("NSIS_D_PARAMETER_MUST_BE_LAST_AND_UNQUOTED");
  }
  return Object.freeze({ args: Object.freeze(args), windowsVerbatimArguments: true });
}

export function buildNsisUninstallArguments(installRoot) {
  assertAbsoluteWindowsPath(installRoot, "NSIS uninstall root");
  if (installRoot.includes('"')) throw new Error("NSIS_INSTALL_ROOT_CONTAINS_QUOTE");
  const args = ["/S", "/currentuser", `_?=${installRoot}`];
  if (args.at(-1) !== `_?=${installRoot}` || args.at(-1).includes('"')) {
    throw new Error("NSIS_INSTALL_ROOT_PARAMETER_MUST_BE_LAST_AND_UNQUOTED");
  }
  return Object.freeze({ args: Object.freeze(args), windowsVerbatimArguments: true });
}

export function createPersistentSnapshotRecord(rootId, root, filePath, fileHash) {
  assertAbsoluteWindowsPath(root, "Persistent data root");
  assertAbsoluteWindowsPath(filePath, "Persistent data file");
  if (!/^[a-f0-9]{64}$/u.test(fileHash)) throw new Error("PERSISTENT_FILE_HASH_INVALID");
  const relativePath = path.win32.relative(path.win32.resolve(root), path.win32.resolve(filePath));
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new Error("PERSISTENT_FILE_OUTSIDE_ROOT");
  }
  return Object.freeze({
    rootId,
    relativePath: relativePath.replace(/\\/gu, "/"),
    fileHash,
  });
}

export function desktopInstallRegistryKey() {
  return INSTALL_REGISTRY_KEY;
}

export function desktopUninstallRegistryKey() {
  return `${UNINSTALL_REGISTRY_KEY_PREFIX}${electronBuilderAppGuid(APP_ID)}`;
}

export function normalizeRegistryRegistrationSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") {
    return { install: undefined, uninstall: undefined };
  }

  return {
    install: normalizeRegistryEntry(snapshot.install, ["scope", "keyPath", "InstallLocation"]),
    uninstall: normalizeRegistryEntry(snapshot.uninstall, [
      "scope",
      "keyPath",
      "DisplayName",
      "DisplayVersion",
      "UninstallString",
    ]),
  };
}

export function classifyD5TestMainSmokeResult(exitCode, output) {
  if (exitCode === 0 && output.includes("D5_WINDOWS_ELECTRON_SMOKE=PASS")) return "PASS";
  const requiredEarlierStages = [
    "RUN_COMPLETED_SSE_DISCONNECT_REPLAY=PASS",
    "NODE_24_NODE_PTY_CONPTY_UTF8_RESIZE_CTRL_C_RUN_ISOLATION=PASS",
    "WEB_CONTENTS_VIEW_HTTPS_HISTORY_SANDBOX_PROFILE_A=PASS",
    "WORKSPACE_SWITCH_AND_TERMINAL_PROCESS_CLEANUP=PASS",
  ];
  if (
    exitCode !== 0 &&
    output.includes("D5_FAILURE_STAGE=PROFILE_SWITCH_AND_BROWSER_ISOLATION") &&
    output.includes("未加载 Windows 安全组件") &&
    requiredEarlierStages.every((marker) => output.includes(marker))
  ) {
    return "PROFILE_SWITCH_NOT_RUN_SECURITY_COMPONENT_UNAVAILABLE";
  }
  return "FAIL";
}

export function assertSuccessfulProcessExit(exitCode, processName) {
  if (exitCode !== 0) {
    throw new Error(`PROCESS_EXIT_NONZERO:${processName}:${String(exitCode)}`);
  }
}

export function assertSuccessfulShutdown({ closeCompleted, daemonExitCode, persistenceVerified }) {
  if (!closeCompleted) throw new Error("DAEMON_GRACEFUL_CLOSE_FAILED");
  if (daemonExitCode !== 0) throw new Error("DAEMON_EXIT_NONZERO");
  if (!persistenceVerified) throw new Error("PERSISTENCE_CHECK_FAILED");
}

function assertRequiredFields(value, fields, keyName) {
  for (const field of fields) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      throw new Error(`REGISTRY_FIELD_MISSING:${keyName}:${field}`);
    }
  }
}

function normalizeRegistryEntry(entry, fields) {
  if (entry === null || entry === undefined) return entry;
  const normalized = {};
  for (const field of fields) {
    const match = Object.entries(entry).find(
      ([name]) => name.toLowerCase() === field.toLowerCase(),
    );
    normalized[field] = match?.[1];
  }
  return normalized;
}

function extractUninstallerPath(value) {
  const quoted = /^\s*"([^"]+\.exe)"/iu.exec(value);
  const unquoted = /^\s*([^\s]+\.exe)(?:\s|$)/iu.exec(value);
  const result = quoted?.[1] ?? unquoted?.[1];
  if (result === undefined || !path.win32.isAbsolute(result)) {
    throw new Error("REGISTRY_FIELD_MISSING:UNINSTALL:UninstallerPath");
  }
  return path.win32.resolve(result);
}

function normalizeWindowsPath(value) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value)) {
    throw new Error("REGISTRY_PATH_MISMATCH:ABSOLUTE_PATH_REQUIRED");
  }
  return path.win32
    .resolve(value)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

function normalizeRegistryPath(value) {
  return String(value)
    .replace(/\//gu, "\\")
    .replace(/[\\]+$/u, "")
    .toLowerCase();
}

function electronBuilderAppGuid(appId) {
  const namespace = Buffer.from("50e065bc313411e69bab38c9862bdaf3", "hex");
  const digest = createHash("sha1").update(namespace).update(appId, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertAbsoluteWindowsPath(value, label) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value)) {
    throw new Error(`${label.toUpperCase().replace(/\s+/gu, "_")}_MUST_BE_ABSOLUTE`);
  }
}
