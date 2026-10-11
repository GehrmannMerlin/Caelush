import { describe, expect, it } from "vitest";
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
} from "../scripts/windows-d6-acceptance-helpers.mjs";

describe("D6 installed lifecycle evidence helpers", () => {
  it("uses an explicitly persistent secure cookie for restart preservation checks", () => {
    expect(buildPersistentBrowserFixtureCookie("fixture-value", 1_700_000_000_000)).toEqual({
      name: "caelush_d6_profile_fixture",
      value: "fixture-value",
      url: "https://example.com/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      expires: 1_700_003_600,
    });
  });
  it("requires the durable COMPLETED state after the provider's final text has arrived", () => {
    const running = { session: { id: "session" }, latestRun: { id: "run", status: "RUNNING" } };
    const completed = { ...running, latestRun: { id: "run", status: "COMPLETED" } };
    expect(findCompletedInstalledSession({ items: [running] })).toBeNull();
    expect(findCompletedInstalledSession({ items: [] })).toBeNull();
    expect(findCompletedInstalledSession({ items: [completed] })).toBe(completed);
    expect(() =>
      findCompletedInstalledSession({
        items: [{ ...running, latestRun: { id: "run", status: "FAILED" } }],
      }),
    ).toThrow("INSTALLED_RUN_TERMINAL_FAILURE:FAILED");
  });
  it("waits on the login page's account projection before calling Agent-only panel IPC", () => {
    expect(
      isInstalledAgentEntryReady({
        status: "AUTHENTICATED_ONLINE",
        agentEntry: { available: true },
      }),
    ).toBe(true);
    expect(
      isInstalledAgentEntryReady({ status: "AUTHORIZED_OFFLINE", agentEntry: { available: true } }),
    ).toBe(true);
    expect(
      isInstalledAgentEntryReady({
        status: "AUTHENTICATED_ONLINE",
        agentEntry: { available: false, reason: "DAEMON_STARTING" },
      }),
    ).toBe(false);
    expect(
      isInstalledAgentEntryReady({ status: "ANONYMOUS", agentEntry: { available: true } }),
    ).toBe(false);
    expect(isInstalledAgentEntryReady({ available: true })).toBe(false);
    expect(isInstalledAgentEntryReady(null)).toBe(false);
  });
  it("keeps a known D5 Test Main security-component gap non-gating and explicit", () => {
    const output = [
      "RUN_COMPLETED_SSE_DISCONNECT_REPLAY=PASS",
      "NODE_24_NODE_PTY_CONPTY_UTF8_RESIZE_CTRL_C_RUN_ISOLATION=PASS",
      "WEB_CONTENTS_VIEW_HTTPS_HISTORY_SANDBOX_PROFILE_A=PASS",
      "WORKSPACE_SWITCH_AND_TERMINAL_PROCESS_CLEANUP=PASS",
      "D5_FAILURE_STAGE=PROFILE_SWITCH_AND_BROWSER_ISOLATION",
      "未加载 Windows 安全组件",
    ].join("\n");

    expect(classifyD5TestMainSmokeResult(1, output)).toBe(
      "PROFILE_SWITCH_NOT_RUN_SECURITY_COMPONENT_UNAVAILABLE",
    );
    expect(classifyD5TestMainSmokeResult(1, "D5_FAILURE_STAGE=INITIALIZE")).toBe("FAIL");
    expect(classifyD5TestMainSmokeResult(0, "D5_WINDOWS_ELECTRON_SMOKE=PASS")).toBe("PASS");
  });

  it("matches Electron Builder 26.17's fixed App ID registry keys", () => {
    expect(desktopInstallRegistryKey()).toBe("Software\\4f2e1d14-f6c3-5409-8788-02b7daa8ae11");
    expect(desktopUninstallRegistryKey()).toBe(
      "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\4f2e1d14-f6c3-5409-8788-02b7daa8ae11",
    );
  });
  it("distinguishes a missing registry key from missing fields", () => {
    expect(() =>
      assertInstallRegistration({ install: null, uninstall: null }, "D:\\Caelush"),
    ).toThrow("REGISTRY_KEY_MISSING");
    expect(() =>
      assertInstallRegistration(
        {
          install: { scope: "HKCU", keyPath: desktopInstallRegistryKey() },
          uninstall: {
            scope: "HKCU",
            keyPath: desktopUninstallRegistryKey(),
            DisplayName: "Caelush 0.1.0",
            DisplayVersion: "0.1.0",
            UninstallString: '"D:\\Caelush\\Uninstall Caelush.exe" /currentuser',
          },
        },
        "D:\\Caelush",
      ),
    ).toThrow("REGISTRY_FIELD_MISSING");
  });

  it("binds install and uninstall keys to the current-user installation root", () => {
    expect(
      assertInstallRegistration(
        {
          install: {
            scope: "HKCU",
            keyPath: desktopInstallRegistryKey(),
            InstallLocation: "D:\\Caelush",
          },
          uninstall: {
            scope: "HKCU",
            keyPath: desktopUninstallRegistryKey(),
            DisplayName: "Caelush 0.1.0",
            DisplayVersion: "0.1.0",
            UninstallString: '"D:\\Caelush\\Uninstall Caelush.exe" /currentuser',
          },
        },
        "D:\\Caelush",
      ),
    ).toEqual({ scope: "HKCU", installRoot: "D:\\Caelush" });
  });

  it("normalizes Electron Builder PowerShell registry JSON field casing", () => {
    const powershellSnapshot = {
      install: {
        Scope: "HKCU",
        KeyPath: desktopInstallRegistryKey(),
        InstallLocation: "D:\\开发\\Caelush App",
      },
      uninstall: {
        Scope: "HKCU",
        KeyPath: desktopUninstallRegistryKey(),
        DisplayName: "Caelush 0.1.0",
        DisplayVersion: "0.1.0",
        UninstallString: '"D:\\开发\\Caelush App\\Uninstall Caelush.exe" /currentuser',
      },
    };
    const snapshot = normalizeRegistryRegistrationSnapshot(powershellSnapshot);

    expect(snapshot).toEqual({
      install: {
        scope: "HKCU",
        keyPath: desktopInstallRegistryKey(),
        InstallLocation: "D:\\开发\\Caelush App",
      },
      uninstall: {
        scope: "HKCU",
        keyPath: desktopUninstallRegistryKey(),
        DisplayName: "Caelush 0.1.0",
        DisplayVersion: "0.1.0",
        UninstallString: '"D:\\开发\\Caelush App\\Uninstall Caelush.exe" /currentuser',
      },
    });
    expect(assertInstallRegistration(snapshot, "D:\\开发\\Caelush App")).toEqual({
      scope: "HKCU",
      installRoot: "D:\\开发\\Caelush App",
    });
  });

  it("rejects mismatched scope and paths", () => {
    const snapshot = {
      install: {
        scope: "HKCU",
        keyPath: desktopInstallRegistryKey(),
        InstallLocation: "D:\\Other",
      },
      uninstall: {
        scope: "HKLM",
        keyPath: desktopUninstallRegistryKey(),
        DisplayName: "Caelush 0.1.0",
        DisplayVersion: "0.1.0",
        UninstallString: '"D:\\Caelush\\Uninstall Caelush.exe" /currentuser',
      },
    };
    expect(() => assertInstallRegistration(snapshot, "D:\\Caelush")).toThrow(
      "REGISTRY_PATH_MISMATCH",
    );
  });

  it.each(["D:\\Caelush", "D:\\Caelush App", "D:\\开发\\Caelush App"])(
    "keeps NSIS /D last and unquoted for %s",
    (installRoot) => {
      const launch = buildNsisInstallArguments(installRoot);
      expect(launch.args).toEqual(["/S", "/currentuser", `/D=${installRoot}`]);
      expect(launch.args.at(-1)).not.toContain('"');
      expect(launch.windowsVerbatimArguments).toBe(true);
    },
  );

  it.each(["D:\\Caelush", "D:\\Caelush App", "D:\\开发\\Caelush App"])(
    "keeps current-user NSIS uninstall arguments explicit for %s",
    (installRoot) => {
      const launch = buildNsisUninstallArguments(installRoot);
      expect(launch.args).toEqual(["/S", "/currentuser", `_?=${installRoot}`]);
      expect(launch.args.at(-1)).not.toContain('"');
      expect(launch.windowsVerbatimArguments).toBe(true);
    },
  );

  it("uses rootId and relativePath consistently for the DPAPI vault snapshot", () => {
    expect(
      createPersistentSnapshotRecord(
        "userData",
        "D:\\test-user-data",
        "D:\\test-user-data\\credentials.dpapi",
        "a".repeat(64),
      ),
    ).toEqual({
      rootId: "userData",
      relativePath: "credentials.dpapi",
      fileHash: "a".repeat(64),
    });
  });

  it("rejects nonzero exits and failed shutdown prerequisites", () => {
    expect(() => assertSuccessfulProcessExit(1, "Electron")).toThrow("PROCESS_EXIT_NONZERO");
    expect(() =>
      assertSuccessfulShutdown({
        closeCompleted: false,
        daemonExitCode: 0,
        persistenceVerified: true,
      }),
    ).toThrow("DAEMON_GRACEFUL_CLOSE_FAILED");
    expect(() =>
      assertSuccessfulShutdown({
        closeCompleted: true,
        daemonExitCode: 0,
        persistenceVerified: false,
      }),
    ).toThrow("PERSISTENCE_CHECK_FAILED");
    expect(() =>
      assertSuccessfulShutdown({
        closeCompleted: true,
        daemonExitCode: 7,
        persistenceVerified: true,
      }),
    ).toThrow("DAEMON_EXIT_NONZERO");
    expect(() => assertSuccessfulProcessExit(0, "Electron")).not.toThrow();
  });
});
