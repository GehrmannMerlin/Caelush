import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

export const MAX_DAEMON_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_DAEMON_LOG_LINE_BYTES = 4096;

export function safeDaemonLogLine(message: string): string {
  const sanitized = message
    .replace(
      /([A-Z0-9_]*(?:API_KEY|AUTHORIZATION|SECRET|TOKEN))\s*[=:]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
  return Buffer.byteLength(sanitized, "utf8") <= MAX_DAEMON_LOG_LINE_BYTES
    ? sanitized
    : `${Buffer.from(sanitized, "utf8").subarray(0, MAX_DAEMON_LOG_LINE_BYTES).toString("utf8")}…`;
}

export async function rotateDaemonLog(
  logPath: string,
  maxBytes = MAX_DAEMON_LOG_BYTES,
): Promise<void> {
  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath) || statSync(logPath).size < maxBytes) return;
  const backupPath = `${logPath}.1`;
  if (existsSync(backupPath)) unlinkSync(backupPath);
  renameSync(logPath, backupPath);
}

export async function openDaemonLog(logPath: string): Promise<number> {
  await rotateDaemonLog(logPath);
  mkdirSync(dirname(logPath), { recursive: true });
  return openSync(logPath, "a", 0o600);
}

export function closeDaemonLog(fd: number): void {
  closeSync(fd);
}
