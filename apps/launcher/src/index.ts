export { main, runStaticCommand } from "./main.js";
export { EXIT_CODES } from "./exit-codes.js";
export type { ProductExitCode } from "./exit-codes.js";
export { HELP_TEXT } from "./help.js";
export {
  currentPlatformLabel,
  isSupportedPlatform,
  nodeVersionInRange,
  SUPPORTED_PLATFORM_MATRIX,
} from "./platform.js";
export type { SupportedPlatform } from "./platform.js";
export { PRODUCT_VERSION } from "./version.js";
export { formatDoctorReport, runDoctor } from "./doctor.js";
export type { DoctorCheck, DoctorCheckStatus, DoctorOptions, DoctorResult } from "./doctor.js";
export {
  DEFAULT_DAEMON_URL,
  DAEMON_STARTUP_POLL_MS,
  DAEMON_STARTUP_TIMEOUT_MS,
  DaemonBootstrapError,
  ensureDaemon,
} from "./daemon-discovery.js";
export type {
  DaemonDiscoveryResult,
  DaemonProbeClient,
  EnsureDaemonOptions,
  SpawnedDaemon,
} from "./daemon-discovery.js";
export { hasInteractiveTerminal, INTERACTIVE_TTY_ERROR } from "./tty.js";
