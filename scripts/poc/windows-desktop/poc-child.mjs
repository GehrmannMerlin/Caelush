import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fault = process.argv[2] ?? "";
let daemon;
let generation;
let started = false;
let closing = false;

process.on("message", (message) => {
  void handleMessage(message);
});

async function handleMessage(message) {
  if (!started) {
    await handleStart(message);
    return;
  }
  if (!isRecord(message) || typeof message.generation !== "string") {
    send({ type: "CONTROL_REJECTED", code: "INVALID_CONTROL" });
    return;
  }
  if (message.generation !== generation) {
    send({ type: "CONTROL_REJECTED", code: "GENERATION_MISMATCH" });
    return;
  }
  if (message.type === "PING") {
    send({ type: "PONG", generation });
    return;
  }
  if (message.type === "SHUTDOWN") {
    if (fault === "shutdown-timeout" || closing) return;
    closing = true;
    const shutdownStartedAt = Date.now();
    const progressTimer = setInterval(() => {
      void send({
        type: "SHUTDOWN_PROGRESS",
        generation,
        elapsedMs: Date.now() - shutdownStartedAt,
      });
    }, 1000);
    try {
      await daemon.close();
      clearInterval(progressTimer);
      const result = await send({ type: "CLOSED", generation });
      await writeShutdownIpcStatus("CLOSED", result);
      if (result === "SENT") {
        process.disconnect();
        setImmediate(() => process.exit(0));
      } else {
        process.exitCode = 1;
        process.disconnect();
      }
    } catch {
      clearInterval(progressTimer);
      const result = await send({ type: "ERROR", code: "DAEMON_SHUTDOWN_FAILED", generation });
      await writeShutdownIpcStatus("ERROR", result);
      process.exitCode = 1;
      process.disconnect();
    }
    return;
  }
  send({ type: "CONTROL_REJECTED", code: "UNKNOWN_CONTROL" });
}

async function handleStart(message) {
  if (started) {
    send({ type: "BOOTSTRAP_REJECTED", code: "BOOTSTRAP_ALREADY_USED" });
    return;
  }
  const keys = [
    "type",
    "protocolVersion",
    "generation",
    "bootstrapSecret",
    "databasePath",
    "productRoot",
  ];
  if (
    !isRecord(message) ||
    !hasExactKeys(message, keys) ||
    message.type !== "START" ||
    message.protocolVersion !== 1 ||
    typeof message.generation !== "string" ||
    !/^[A-Za-z0-9_-]{16,96}$/.test(message.generation) ||
    typeof message.bootstrapSecret !== "string" ||
    !/^[0-9a-f]{64}$/.test(message.bootstrapSecret) ||
    typeof message.databasePath !== "string" ||
    message.databasePath.length > 1024 ||
    typeof message.productRoot !== "string" ||
    message.productRoot.length > 1024
  ) {
    send({ type: "BOOTSTRAP_REJECTED", code: "INVALID_BOOTSTRAP" });
    return;
  }

  started = true;
  generation = message.generation;
  const bootstrapSecret = message.bootstrapSecret;
  const bootstrapChannelOnly =
    !process.argv.join(" ").includes(bootstrapSecret) &&
    !Object.values(process.env).some((value) => value?.includes(bootstrapSecret));
  delete message.bootstrapSecret;
  if (!bootstrapChannelOnly) {
    send({ type: "ERROR", code: "BOOTSTRAP_CHANNEL_LEAK" });
    process.exitCode = 1;
    process.disconnect();
    return;
  }

  if (fault === "exit-before-ready") process.exit(17);
  if (fault === "startup-timeout") return;

  try {
    const daemonEntry = pathToFileURL(
      join(message.productRoot, "node_modules", "@caelush", "daemon", "dist", "index.js"),
    ).href;
    const protocolEntry = pathToFileURL(
      join(message.productRoot, "node_modules", "@caelush", "protocol", "dist", "index.js"),
    ).href;
    const [{ startDaemon }, { DaemonInfoSchema }] = await Promise.all([
      import(daemonEntry),
      import(protocolEntry),
    ]);

    if (fault === "generation-mismatch") {
      daemon = await makeDaemon(startDaemon, message.productRoot, message.databasePath);
      await send({
        type: "READY",
        generation: `stale-${generation}`,
        pid: process.pid,
        port: Number(new URL(daemon.url).port),
        runtimeNodeVersion: process.versions.node,
        runtimeModulesAbi: process.versions.modules,
        runtimeNapi: process.versions.napi,
      });
      return;
    }

    daemon = await makeDaemon(startDaemon, message.productRoot, message.databasePath);
    const port = Number(new URL(daemon.url).port);
    const infoResponse = await fetch(`${daemon.url}/api/v1/info`);
    const info = DaemonInfoSchema.parse(await infoResponse.json());
    await send({
      type: "READY",
      generation,
      pid: process.pid,
      port,
      daemonVersion: info.daemonVersion,
      apiVersion: info.apiVersion,
      protocolVersion: info.protocolVersion,
      bootstrapChannelOnly,
      runtimeNodeVersion: process.versions.node,
      runtimeModulesAbi: process.versions.modules,
      runtimeNapi: process.versions.napi,
    });
    if (fault === "exit-after-ready") setTimeout(() => process.exit(23), 75);
  } catch {
    await send({ type: "ERROR", code: "DAEMON_START_FAILED", generation });
    if (daemon !== undefined) await daemon.close().catch(() => undefined);
    process.exitCode = 1;
    process.disconnect();
  }
}

async function makeDaemon(startDaemon, productRoot, databasePath) {
  const fixture = createFixture();
  const options = {
    databasePath,
    host: "127.0.0.1",
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providers: [],
    providerBindings: [fixture.binding],
    modelSources: [fixture.modelSource],
    adapterOverrides: [fixture.adapter],
    defaultModel: { provider: "fixture", model: "fixture-model" },
    web: { buildRoot: join(productRoot, "web") },
  };
  Object.defineProperty(options, Symbol.for("caelush.daemon.internal-shutdown-observer.v1"), {
    value: (observation) => {
      void send({ type: "SHUTDOWN_PHASE", generation, ...observation });
    },
  });
  return startDaemon(options);
}

function createFixture() {
  const providerId = "fixture";
  const modelId = "fixture-model";
  const apiId = "fixture-api";
  const descriptor = {
    ref: { provider: providerId, model: modelId },
    api: apiId,
    limits: { contextWindowTokens: 128000, maxOutputTokens: 8192 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNSUPPORTED",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    source: "CONFIGURATION",
  };
  return {
    binding: {
      id: providerId,
      endpoint: "http://fixture.invalid/v1",
      defaultApi: apiId,
      allowUnknownModels: true,
      credentials: { resolve: async () => ({ apiKey: "poc-fixture-only" }) },
    },
    modelSource: {
      id: "windows-desktop-poc-fixture",
      priority: 0,
      resolve: (ref) =>
        ref.provider === providerId && ref.model === modelId ? descriptor : undefined,
      list: () => [descriptor],
    },
    adapter: {
      id: apiId,
      async *stream() {
        await new Promise((resolve) => setTimeout(resolve, 180));
        yield { type: "text.delta", payload: { text: "Windows POC fixture completed." } };
        yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
      },
    },
  };
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(message) {
  if (typeof process.send !== "function" || !process.connected) return Promise.resolve("FAILED");
  return new Promise((resolve) => {
    try {
      process.send(message, (error) => resolve(error ? "FAILED" : "SENT"));
    } catch {
      resolve("FAILED");
    }
  });
}

function writeShutdownIpcStatus(type, result) {
  return new Promise((resolve) => {
    try {
      process.stdout.write(`POC_SHUTDOWN_IPC=${type}:${result}\n`, () => resolve());
    } catch {
      resolve();
    }
  });
}
