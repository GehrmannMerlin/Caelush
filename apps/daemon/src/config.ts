export interface DaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly sseHeartbeatIntervalMs: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  host: "127.0.0.1",
  port: 43120,
  sseHeartbeatIntervalMs: 15_000,
};

export function createDaemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return { ...DEFAULT_DAEMON_CONFIG, ...overrides };
}
