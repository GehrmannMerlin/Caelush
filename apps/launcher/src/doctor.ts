import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { CaelushClient } from "@caelush/client";
import { checkNodePtyLoadability, inspectMigrationAssets } from "@caelush/daemon/diagnostics";
import { resolveProductPaths, type ProductPaths } from "@caelush/daemon/paths";
import type { DaemonProbeClient } from "./daemon-discovery.js";
import { DEFAULT_DAEMON_URL } from "./daemon-discovery.js";
import { EXIT_CODES } from "./exit-codes.js";
import { currentPlatformLabel, isSupportedPlatform, nodeVersionInRange } from "./platform.js";
import { PRODUCT_VERSION } from "./version.js";

export type DoctorCheckStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly detail: string;
}

export interface DoctorResult {
  readonly exitCode: 0 | 1;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly productPaths?: ProductPaths;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly workspacePath?: string;
  readonly probeClient?: DaemonProbeClient;
  readonly nodePtyCheck?: () => Promise<{ readonly available: boolean }>;
  readonly migrationCheck?: () => { readonly available: boolean; readonly migrationCount: number };
  readonly executableCheck?: (executable: "git" | "rg") => Promise<boolean>;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const environment = options.environment ?? process.env;
  const paths = options.productPaths ?? resolveProductPaths({ environment });
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const checks: DoctorCheck[] = [];
  checks.push({ name: "Caelush version", status: "PASS", detail: PRODUCT_VERSION });
  checks.push({
    name: "Node version",
    status: nodeVersionInRange(options.nodeVersion ?? process.versions.node) ? "PASS" : "FAIL",
    detail: options.nodeVersion ?? process.versions.node,
  });
  checks.push({
    name: "platform",
    status: isSupportedPlatform(platform, arch) ? "PASS" : "FAIL",
    detail: currentPlatformLabel(platform, arch),
  });
  checks.push({
    name: "TTY",
    status: options.stdinIsTTY === true && options.stdoutIsTTY === true ? "PASS" : "WARN",
    detail: `stdin=${options.stdinIsTTY === true ? "tty" : "not a tty"}, stdout=${options.stdoutIsTTY === true ? "tty" : "not a tty"}`,
  });
  checks.push({
    name: "workspace",
    status:
      options.workspacePath !== undefined && existsSync(options.workspacePath) ? "PASS" : "FAIL",
    detail: options.workspacePath ?? "unavailable",
  });
  const daemonUrl = environment.CAELUSH_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL;
  checks.push({ name: "daemon URL", status: "PASS", detail: safeDaemonUrl(daemonUrl) });

  let probeClient = options.probeClient;
  try {
    probeClient ??= new CaelushClient({ baseUrl: daemonUrl });
  } catch {
    checks.push({
      name: "daemon reachable",
      status: "WARN",
      detail: "not reachable (invalid URL)",
    });
  }
  try {
    if (probeClient === undefined) throw new Error("daemon client unavailable");
    const health = await probeClient.getHealth();
    const info = await probeClient.getInfo();
    const compatible =
      health.apiVersion === "v1" &&
      health.protocolVersion === 1 &&
      info.apiVersion === "v1" &&
      info.protocolVersion === 1;
    checks.push({
      name: "daemon reachable",
      status: compatible ? "PASS" : "FAIL",
      detail: compatible ? "yes" : "API or protocol mismatch",
    });
    checks.push({
      name: "daemon API",
      status: health.apiVersion === "v1" ? "PASS" : "FAIL",
      detail: health.apiVersion,
    });
    checks.push({
      name: "daemon protocol",
      status: health.protocolVersion === 1 ? "PASS" : "FAIL",
      detail: String(health.protocolVersion),
    });
    checks.push({
      name: "daemon version",
      status: info.daemonVersion === PRODUCT_VERSION ? "PASS" : "WARN",
      detail: info.daemonVersion,
    });
  } catch {
    if (probeClient !== undefined)
      checks.push({
        name: "daemon reachable",
        status: "WARN",
        detail: "not reachable (doctor does not auto-start)",
      });
  }

  checks.push({
    name: "database parent",
    status: existsSync(dirname(paths.databasePath)) ? "PASS" : "FAIL",
    detail: dirname(paths.databasePath),
  });
  const executableCheck = options.executableCheck ?? defaultExecutableCheck;
  for (const executable of ["git", "rg"] as const) {
    const available = await executableCheck(executable);
    checks.push({
      name: executable === "git" ? "Git" : "ripgrep",
      status: available ? "PASS" : "WARN",
      detail: available ? "available" : "not available",
    });
  }
  const pty = await (options.nodePtyCheck ?? checkNodePtyLoadability)();
  checks.push({
    name: "node-pty",
    status: pty.available ? "PASS" : "FAIL",
    detail: pty.available ? "loadable" : "not loadable",
  });
  const migrations = (options.migrationCheck ?? inspectMigrationAssets)();
  checks.push({
    name: "migration assets",
    status: migrations.available ? "PASS" : "FAIL",
    detail: `${migrations.migrationCount} migration directories`,
  });

  const providerId = environment.CAELUSH_PROVIDER_ID;
  const defaultProvider = environment.CAELUSH_DEFAULT_PROVIDER;
  const defaultModel = environment.CAELUSH_DEFAULT_MODEL;
  checks.push({
    name: "Provider configured",
    status: providerId !== undefined ? "PASS" : "WARN",
    detail: providerId === undefined ? "no" : "yes",
  });
  if (providerId !== undefined)
    checks.push({ name: "Provider ID", status: "PASS", detail: providerId });
  if (defaultProvider !== undefined && defaultModel !== undefined) {
    checks.push({ name: "Default model", status: "PASS", detail: defaultModel });
  }

  return {
    exitCode: checks.some((check) => check.status === "FAIL") ? EXIT_CODES.DOCTOR_FAILURE : 0,
    checks,
  };
}

export function formatDoctorReport(result: DoctorResult): string {
  return (
    result.checks.map((check) => `[${check.status}] ${check.name}: ${check.detail}`).join("\n") +
    "\n"
  );
}

async function defaultExecutableCheck(executable: "git" | "rg"): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(executable, ["--version"], { shell: false }, (error) => resolve(error === null));
  });
}

function safeDaemonUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "invalid URL";
  }
}
