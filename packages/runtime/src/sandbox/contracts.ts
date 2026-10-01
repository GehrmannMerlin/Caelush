import type {
  ProcessAdapterFactory,
  ShellLaunch,
  ManagedProcessAdapter,
} from "../exec/contracts.js";
import type { RuntimeProcessPolicy } from "../security/runtime-boundary.js";
import type { SandboxControlMessage } from "./control-protocol.js";

export type SandboxEnforcement = "HARD" | "PARTIAL" | "NONE";
export type ProcessSandboxKind = "RESTRICTED" | "UNRESTRICTED";

export interface SandboxedSpawnSpec {
  readonly launch: ShellLaunch;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tty: boolean;
  readonly policy: RuntimeProcessPolicy;
  readonly controlHello?: SandboxControlMessage;
}

export interface ProcessSandboxProvider {
  readonly id: string;
  readonly kind: ProcessSandboxKind;
  readonly enforcement: SandboxEnforcement;
  create(input: SandboxedSpawnSpec): Promise<ManagedProcessAdapter>;
}

export interface ProcessSandboxProbe {
  readonly provider: ProcessSandboxProvider;
  readonly available: boolean;
  readonly enforcement: SandboxEnforcement;
  readonly reasonCode?: string;
}

export type ProcessSandboxFactory = Pick<ProcessAdapterFactory, "create">;
