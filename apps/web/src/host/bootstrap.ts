import { CaelushProtocolCompatibilityError, type CaelushClient } from "@caelush/client";
import {
  DaemonInfoSchema,
  HealthResponseSchema,
  WorkspaceRefSchema,
  type DaemonInfo,
  type HealthResponse,
  type WorkspaceRef,
} from "@caelush/protocol";
import { z } from "zod";

const WebLaunchContextSchema = z
  .object({
    workspace: WorkspaceRefSchema,
  })
  .strict();

export type WebLaunchContext = z.infer<typeof WebLaunchContextSchema>;

export type WebBootstrapStatus =
  | "BOOTING"
  | "CONNECTING"
  | "CHECKING_PROTOCOL"
  | "READY"
  | "DAEMON_UNAVAILABLE"
  | "PROTOCOL_INCOMPATIBLE"
  | "WORKSPACE_MISSING"
  | "BOOTSTRAP_INVALID";

export type WebConnectionState = "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "INCOMPATIBLE";

export interface SafeWebError {
  readonly code:
    "DAEMON_UNAVAILABLE" | "PROTOCOL_INCOMPATIBLE" | "WORKSPACE_MISSING" | "BOOTSTRAP_INVALID";
  readonly message: string;
}

export interface WebHostState {
  readonly bootstrap: WebBootstrapStatus;
  readonly connection: WebConnectionState;
  readonly health?: HealthResponse;
  readonly info?: DaemonInfo;
  readonly workspace?: WorkspaceRef;
  readonly error?: SafeWebError;
}

export interface WebHostClient {
  getHealth(): Promise<HealthResponse>;
  getInfo(): Promise<DaemonInfo>;
}

export function createInitialWebHostState(): WebHostState {
  return { bootstrap: "BOOTING", connection: "CONNECTING" };
}

export async function parseWebLaunchContext(value: unknown): Promise<WebLaunchContext> {
  if (value === undefined || value === null || value === "") {
    throw new WebBootstrapInputError("WORKSPACE_MISSING");
  }

  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw new WebBootstrapInputError("BOOTSTRAP_INVALID");
    }
  }
  const parsed = WebLaunchContextSchema.safeParse(candidate);
  if (!parsed.success) throw new WebBootstrapInputError("BOOTSTRAP_INVALID");
  return parsed.data;
}

export async function bootstrapWebHost(input: {
  readonly client: WebHostClient | CaelushClient;
  readonly launchContext: unknown;
  readonly onState?: (state: WebHostState) => void;
}): Promise<WebHostState> {
  let launchContext: WebLaunchContext;
  try {
    launchContext = await parseWebLaunchContext(input.launchContext);
  } catch (error) {
    const safeError = toSafeWebError(error);
    return publish(input, {
      bootstrap: safeError.code,
      connection: safeError.code === "PROTOCOL_INCOMPATIBLE" ? "INCOMPATIBLE" : "DISCONNECTED",
      error: safeError,
    });
  }

  try {
    input.onState?.({
      bootstrap: "CONNECTING",
      connection: "CONNECTING",
      workspace: launchContext.workspace,
    });
    const health = await input.client.getHealth();
    if (!isCompatibleHealth(health))
      return publish(input, incompatibleState(launchContext, health));
    input.onState?.({
      bootstrap: "CHECKING_PROTOCOL",
      connection: "CONNECTING",
      health,
      workspace: launchContext.workspace,
    });
    const info = await input.client.getInfo();
    if (!isCompatibleInfo(info)) return publish(input, incompatibleState(launchContext, health));
    return publish(input, {
      bootstrap: "READY",
      connection: "CONNECTED",
      health,
      info,
      workspace: launchContext.workspace,
    });
  } catch (error) {
    const safeError = toSafeWebError(error);
    return publish(input, {
      bootstrap: safeError.code,
      connection: safeError.code === "PROTOCOL_INCOMPATIBLE" ? "INCOMPATIBLE" : "DISCONNECTED",
      workspace: launchContext.workspace,
      error: safeError,
    });
  }
}

export function toSafeWebError(error: unknown): SafeWebError {
  if (error instanceof WebBootstrapInputError) return safeError(error.code);
  if (error instanceof CaelushProtocolCompatibilityError) {
    return safeError("PROTOCOL_INCOMPATIBLE");
  }
  return safeError("DAEMON_UNAVAILABLE");
}

export class WebBootstrapInputError extends Error {
  constructor(readonly code: "WORKSPACE_MISSING" | "BOOTSTRAP_INVALID") {
    super(code);
    this.name = "WebBootstrapInputError";
  }
}

function safeError(code: SafeWebError["code"]): SafeWebError {
  const messages: Record<SafeWebError["code"], string> = {
    DAEMON_UNAVAILABLE: "无法连接到本地 Caelush 服务。",
    PROTOCOL_INCOMPATIBLE: "当前 Web 与 Caelush daemon 协议版本不兼容。",
    WORKSPACE_MISSING: "当前没有有效的工作区启动上下文。",
    BOOTSTRAP_INVALID: "Caelush Web 启动上下文无效。",
  };
  return { code, message: messages[code] };
}

function isCompatibleHealth(value: HealthResponse): boolean {
  return HealthResponseSchema.safeParse(value).success;
}

function isCompatibleInfo(value: DaemonInfo): boolean {
  return DaemonInfoSchema.safeParse(value).success;
}

function incompatibleState(workspace: WebLaunchContext, health: HealthResponse): WebHostState {
  const error = safeError("PROTOCOL_INCOMPATIBLE");
  return {
    bootstrap: "PROTOCOL_INCOMPATIBLE",
    connection: "INCOMPATIBLE",
    health,
    workspace: workspace.workspace,
    error,
  };
}

function publish(
  input: { readonly onState?: (state: WebHostState) => void },
  state: WebHostState,
): WebHostState {
  input.onState?.(state);
  return state;
}
