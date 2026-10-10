import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DaemonInfoSchema } from "@caelush/protocol";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { readProviderConfiguration, readProviderStreamPolicy } from "./config.js";
import { createDesktopCredentialAuthority } from "./providers/desktop-credential-rpc.js";
import { createNativeWorkspaceDirectoryPicker } from "./workspaces/workspace-picker.js";
import { DAEMON_VERSION } from "./version.js";

const PROFILE_ID = /^u_[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const REQUIRED_CAPABILITIES = [
  "runExecution",
  "runRecovery",
  "cancellation",
  "approvals",
  "sseReplay",
  "sessionTranscript",
  "desktopHostAuthV1",
  "desktopProfileBindingV1",
  "desktopLocalProxyV1",
] as const;
const SORTED_REQUIRED_CAPABILITIES = [...REQUIRED_CAPABILITIES].sort();

const StartMessageSchema = z
  .object({
    type: z.literal("START_DESKTOP_DAEMON"),
    ipcProtocolVersion: z.literal(1),
    generationId: z.string().uuid(),
    profileId: z.string().regex(PROFILE_ID),
    desktopVersion: z.string().min(1).max(256),
    expectedDaemonVersion: z.string().min(1).max(256),
    apiVersion: z.literal("v1"),
    protocolVersion: z.literal(1),
    requiredCapabilities: z.array(z.string().min(1).max(64)).max(64),
    bootstrapSecret: z.string().regex(SECRET),
    bootstrapExpiresAt: z.number().int().positive().safe(),
    hostToken: z.string().regex(TOKEN),
  })
  .strict()
  .refine(
    (value) => new Set(value.requiredCapabilities).size === value.requiredCapabilities.length,
    "requiredCapabilities must be unique",
  );

const StopMessageSchema = z
  .object({
    type: z.literal("STOP_DESKTOP_DAEMON"),
    ipcProtocolVersion: z.literal(1),
    generationId: z.string().uuid(),
  })
  .strict();

type StartMessage = z.infer<typeof StartMessageSchema>;
type StopMessage = z.infer<typeof StopMessageSchema>;

let bootstrapConsumed = false;
let bootstrapGeneration: string | undefined;
let daemon: DaemonHandle | undefined;
let disposeCredentialAuthority: (() => void) | undefined;
let starting: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
let stopRequested = false;

if (typeof process.send !== "function" || !process.connected || process.ppid <= 0) {
  process.exitCode = 1;
  process.disconnect?.();
} else {
  process.on("message", (message: unknown) => {
    void handleMessage(message);
  });
}

async function handleMessage(message: unknown): Promise<void> {
  if (!bootstrapConsumed) {
    bootstrapConsumed = true;
    const parsed = StartMessageSchema.safeParse(message);
    if (!parsed.success) {
      await send({
        type: "DAEMON_STARTUP_FAILED",
        ipcProtocolVersion: 1,
        generationId: readGeneration(message),
        code: "INVALID_BOOTSTRAP",
      });
      process.disconnect?.();
      setImmediate(() => process.exit(1));
      return;
    }
    bootstrapGeneration = parsed.data.generationId;
    const { bootstrapSecret, ...startData } = parsed.data;
    starting = startFromBootstrap(startData, bootstrapSecret);
    return;
  }

  if (isRecord(message) && message.type === "START_DESKTOP_DAEMON") {
    const generationId = readGeneration(message);
    await send({
      type: "DAEMON_STARTUP_FAILED",
      ipcProtocolVersion: 1,
      generationId,
      code: "BOOTSTRAP_ALREADY_USED",
    });
    stopRequested = true;
    if (starting !== undefined && daemon === undefined) {
      void starting.then(() => closeAndExit()).catch(() => closeAndExit());
    } else {
      await closeAndExit();
    }
    return;
  }

  // Credential responses share the trusted Child IPC channel but belong to the
  // injected Runtime credential authority, not to the Daemon lifecycle protocol.
  // Let its correlated listener consume them without treating them as a malformed
  // STOP message and shutting down the generation during a model call.
  if (isRecord(message) && message.type === "CREDENTIAL_RESPONSE") return;

  const parsed = StopMessageSchema.safeParse(message);
  if (!parsed.success || parsed.data.generationId !== bootstrapGeneration) {
    await send({
      type: "DAEMON_STARTUP_FAILED",
      ipcProtocolVersion: 1,
      generationId: readGeneration(message),
      code: "INVALID_CONTROL_MESSAGE",
    });
    stopRequested = true;
    if (starting !== undefined && daemon === undefined) {
      void starting.then(() => closeAndExit()).catch(() => closeAndExit());
    } else {
      await closeAndExit();
    }
    return;
  }
  stopRequested = true;
  await closeAndExit(parsed.data);
}

async function startFromBootstrap(
  message: Omit<StartMessage, "bootstrapSecret">,
  suppliedBootstrapSecret: string,
): Promise<void> {
  let bootstrapSecret = suppliedBootstrapSecret;
  const hostToken = message.hostToken;
  if (
    bootstrapSecret.length < 42 ||
    !isCanonicalSecret(bootstrapSecret) ||
    !TOKEN.test(hostToken) ||
    message.bootstrapExpiresAt <= Date.now() ||
    message.bootstrapExpiresAt > Date.now() + 10_000 ||
    message.desktopVersion !== message.expectedDaemonVersion ||
    message.expectedDaemonVersion !== DAEMON_VERSION ||
    message.apiVersion !== "v1" ||
    message.protocolVersion !== 1 ||
    message.requiredCapabilities.length !== SORTED_REQUIRED_CAPABILITIES.length ||
    [...message.requiredCapabilities]
      .sort()
      .some((capability, index) => capability !== SORTED_REQUIRED_CAPABILITIES[index])
  ) {
    bootstrapSecret = "";
    await failStartup(message.generationId, "BOOTSTRAP_INCOMPATIBLE");
    return;
  }
  bootstrapSecret = "";

  let failureCode = "DAEMON_START_FAILED";
  try {
    const profileRootDirectory = process.env.CAELUSH_HOME;
    if (profileRootDirectory === undefined) throw new Error("profile");
    failureCode = "PROFILE_BINDING_INVALID";
    const verifiedProfileRoot = await verifyProfileBinding(profileRootDirectory, message.profileId);
    failureCode = "DAEMON_START_FAILED";
    const databasePath = path.join(verifiedProfileRoot, "caelush.db");
    const environment = desktopProviderEnvironment(process.env);
    const credentialRpc = createDesktopCredentialAuthority({
      generationId: message.generationId,
      profileId: message.profileId,
    });
    disposeCredentialAuthority = credentialRpc.dispose;
    const hostTokenBytes = Buffer.from(hostToken, "base64url");
    if (hostTokenBytes.byteLength !== 32 || hostTokenBytes.toString("base64url") !== hostToken) {
      throw new Error("token");
    }

    daemon = await startDaemon({
      databasePath,
      host: "127.0.0.1",
      port: 0,
      environment,
      ...readProviderConfiguration(environment),
      credentialAuthority: credentialRpc.authority,
      providerStreamPolicy: readProviderStreamPolicy(environment),
      workspacePicker: createNativeWorkspaceDirectoryPicker(),
      desktopHost: {
        profileId: message.profileId,
        generationId: message.generationId,
        profileRootDirectory: verifiedProfileRoot,
        hostToken,
      },
    });
    const bound = new URL(daemon.url);
    if (bound.hostname !== "127.0.0.1" || bound.port === "0" || bound.port.length === 0) {
      throw new Error("bind");
    }
    failureCode = "DAEMON_INFO_HANDSHAKE_FAILED";
    const infoResponse = await fetch(`${daemon.url}/api/v1/info`, {
      headers: {
        origin: daemon.url,
        "x-caelush-host-token": hostToken,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!infoResponse.ok) throw new Error("info");
    const info = DaemonInfoSchema.parse(await infoResponse.json());
    if (info.daemonVersion !== message.expectedDaemonVersion) throw new Error("version");
    await send({
      type: "DAEMON_READY",
      ipcProtocolVersion: 1,
      generationId: message.generationId,
      profileId: message.profileId,
      childPid: process.pid,
      parentPid: process.ppid,
      host: bound.hostname,
      port: Number(bound.port),
      daemonVersion: info.daemonVersion,
      apiVersion: info.apiVersion,
      protocolVersion: info.protocolVersion,
      capabilities: Object.entries(info.capabilities)
        .filter(([, enabled]) => enabled === true)
        .map(([name]) => name)
        .sort(),
      bootstrapAccepted: true,
    });
    if (stopRequested) setImmediate(() => void closeAndExit());
  } catch {
    if (daemon !== undefined) await daemon.close().catch(() => undefined);
    daemon = undefined;
    disposeCredentialAuthority?.();
    disposeCredentialAuthority = undefined;
    await failStartup(message.generationId, failureCode);
  }
}

function desktopProviderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (/(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)/iu.test(key)) {
      delete environment[key];
      delete process.env[key];
    }
  }
  return environment;
}

async function verifyProfileBinding(
  profileRootDirectory: string,
  profileId: string,
): Promise<string> {
  const absoluteRoot = path.resolve(profileRootDirectory);
  const localAppDataDirectory = process.env.LOCALAPPDATA;
  if (localAppDataDirectory === undefined || localAppDataDirectory.trim().length === 0) {
    throw new Error("profile");
  }
  const expectedRoot = path.join(
    path.resolve(localAppDataDirectory),
    "Caelush",
    "profiles",
    profileId,
  );
  if (!samePath(absoluteRoot, expectedRoot)) throw new Error("profile");
  const metadata = await lstat(absoluteRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("profile");
  const canonicalRoot = await realpath(absoluteRoot);
  if (!samePath(canonicalRoot, absoluteRoot)) throw new Error("profile");
  const profileMetadataPath = path.join(canonicalRoot, "profile.json");
  const profileMetadata = await lstat(profileMetadataPath);
  if (
    profileMetadata.isSymbolicLink() ||
    !profileMetadata.isFile() ||
    profileMetadata.nlink !== 1 ||
    profileMetadata.size > 4096
  ) {
    throw new Error("profile");
  }
  const raw: unknown = JSON.parse(await readFile(profileMetadataPath, "utf8"));
  const parsed = z
    .object({
      schemaVersion: z.literal(1),
      profileId: z.string().regex(PROFILE_ID),
      createdAt: z.string().datetime({ offset: true }),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success || parsed.data.profileId !== profileId) throw new Error("profile");
  for (const name of ["runs", "logs", "backups", "browser", "downloads", "run"] as const) {
    const directoryPath = path.join(canonicalRoot, name);
    const directory = await lstat(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("profile");
    if (!samePath(await realpath(directoryPath), directoryPath)) throw new Error("profile");
  }
  const databasePath = path.join(canonicalRoot, "caelush.db");
  try {
    const database = await lstat(databasePath);
    if (database.isSymbolicLink() || !database.isFile() || database.nlink !== 1) {
      throw new Error("profile");
    }
    if (!samePath(await realpath(databasePath), databasePath)) throw new Error("profile");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  return canonicalRoot;
}

async function closeAndExit(message?: StopMessage): Promise<void> {
  if (stopping !== undefined) return stopping;
  stopping = (async () => {
    if (starting !== undefined && daemon === undefined) await starting.catch(() => undefined);
    if (daemon === undefined) {
      disposeCredentialAuthority?.();
      disposeCredentialAuthority = undefined;
      if (message !== undefined) {
        await send({
          type: "DAEMON_CLOSED",
          ipcProtocolVersion: 1,
          generationId: bootstrapGeneration,
        });
      }
      process.disconnect?.();
      setImmediate(() => process.exit(0));
      return;
    }
    try {
      await daemon.close();
      await send({
        type: "DAEMON_CLOSED",
        ipcProtocolVersion: 1,
        generationId: bootstrapGeneration,
      });
      daemon = undefined;
      disposeCredentialAuthority?.();
      disposeCredentialAuthority = undefined;
      process.disconnect?.();
      setImmediate(() => process.exit(0));
    } catch {
      stopping = undefined;
      await send({
        type: "DAEMON_STOP_BLOCKED",
        ipcProtocolVersion: 1,
        generationId: bootstrapGeneration,
        code: "SAFE_CHECKPOINT_PENDING",
      });
    }
  })();
  return stopping;
}

async function failStartup(generationId: string, code: string): Promise<void> {
  await send({ type: "DAEMON_STARTUP_FAILED", ipcProtocolVersion: 1, generationId, code });
  process.disconnect?.();
  setImmediate(() => process.exit(1));
}

async function send(message: unknown): Promise<boolean> {
  if (typeof process.send !== "function" || !process.connected) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      process.send?.(message, (error) => resolve(error === null));
    } catch {
      resolve(false);
    }
  });
}

function readGeneration(message: unknown): string {
  return isRecord(message) && typeof message.generationId === "string" ? message.generationId : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    path
      .resolve(value)
      .replace(/[\\/]+$/u, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

function isCanonicalSecret(value: string): boolean {
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}
