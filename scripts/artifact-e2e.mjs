import { execFileSync, spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  SANDBOX_RUNNER_DIRECTORY_NAME,
  SANDBOX_RUNNER_MANIFEST_FILENAME,
} from "./build-sandbox-runner.mjs";

const artifactPath = resolve(process.argv[2] ?? "");
if (!artifactPath) throw new Error("Usage: node scripts/artifact-e2e.mjs <artifact.tgz>");

const testRoot = await mkdtemp(join(tmpdir(), "caelush-artifact-e2e-"));
const bundleDirectory = join(testRoot, "bundle");
const workspaceDirectory = join(testRoot, "workspace");
const homeDirectory = join(testRoot, "home");
await mkdir(bundleDirectory, { recursive: true });
await mkdir(workspaceDirectory, { recursive: true });
await mkdir(homeDirectory, { recursive: true });
await writeFile(join(workspaceDirectory, "fixture.txt"), "artifact fixture\n", "utf8");
await stopStaleArtifactDaemons();

const extraction = spawnSync("tar", ["-xzf", artifactPath, "-C", bundleDirectory], {
  // `tar -xzf` never reads stdin; do not hand the archiver a stdin pipe.
  stdio: ["ignore", "pipe", "pipe"],
});
if (extraction.status !== 0) {
  throw new Error(`Unable to extract the artifact: ${extraction.stderr.toString("utf8")}`);
}

const manifest = JSON.parse(await readFile(join(bundleDirectory, "manifest.json"), "utf8"));
const packagedSandboxRunner = await inspectPackagedSandboxRunner(manifest);
const binPath = join(bundleDirectory, "bin", "caelush");
// The packaged Daemon's own default port, the same one the packaged client already targets. Declared
// here rather than beside its helper because the main flow runs before the helper section is reached.
const PACKAGED_DAEMON_URL = "http://127.0.0.1:43120";
// The Daemon composes the packaged Runner host now, so a fresh workspace is `VIEW_ONLY: AVAILABLE`
// and `WORKSPACE_WRITE: PREPARATION_REQUIRED` rather than a refused preset. That splits this smoke
// into two jobs that need different Runs.
//
// The general product scenarios below — provider dialects, packaged PTY, streaming, daemon reuse,
// parallel startup, cancellation and recovery — are about the product, not the sandbox. They run
// through the explicitly selected Full Access capability, the one preset that never waits for an
// approval a non-interactive launcher cannot give. The restricted presets are exercised on their own
// in `assertRestrictedSandbox` below, which is where preparation, the refused write and restart
// consistency are actually asserted. The bundled Runner is separately proven through `doctor`, the
// packaged manifests, the archive checksum records and the tamper probe.
if (manifest.featureGates.fullAccessV1 !== true) {
  throw new Error("Release smoke requires the Full Access capability for its general scenarios.");
}
const fullAccessArgs = ["--permission", "full-access"];
const runConfiguredLauncher = (args, options) =>
  runLauncher(binPath, [...args, ...fullAccessArgs], options);
const provider = await startFakeProvider();
const hostFetch = globalThis.fetch.bind(globalThis);
const secret = "PHASE12E_SECRET_SENTINEL";
const environment = {
  ...process.env,
  CAELUSH_HOME: homeDirectory,
  CAELUSH_PROVIDER_ID: "openai-compatible",
  CAELUSH_PROVIDER_BASE_URL: provider.url,
  CAELUSH_PROVIDER_API_KEY: secret,
  CAELUSH_PROVIDER_ALLOWED_MODELS: "fixture-model",
  CAELUSH_PROVIDER_MODEL_PROFILES: JSON.stringify({
    "fixture-model": {
      contextWindowTokens: 32_000,
      maxOutputTokens: 16_384,
      recommendedOutputReserveTokens: 1_024,
    },
  }),
  CAELUSH_DEFAULT_PROVIDER: "openai-compatible",
  CAELUSH_DEFAULT_MODEL: "fixture-model",
};
delete environment.CAELUSH_DAEMON_URL;
// The packaged bundle must satisfy discovery on its own. Remove any development or
// diagnostic Runner override so neither the source tree nor this shell can satisfy it.
delete environment.CAELUSH_SANDBOX_RUNNER_PATH;
delete environment.CAELUSH_SANDBOX_RUNNER_MANIFEST;

try {
  const providerProbe = await hostFetch(`${provider.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "probe" }] }),
  });
  assert(providerProbe.ok, `fake provider probe failed: ${providerProbe.status}`);
  const packagedFetchProbe = await run(
    process.execPath,
    [
      "-e",
      `const response = await fetch(${JSON.stringify(`${provider.url}/chat/completions`)}, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); if (!response.ok) process.exit(1);`,
    ],
    { cwd: bundleDirectory, env: environment },
  );
  assert(
    packagedFetchProbe.exitCode === 0,
    `packaged process could not reach fake provider: ${packagedFetchProbe.stderr}`,
  );
  const aiModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "ai", "dist", "index.js"),
  ).href;
  const openAIAdapterModule = pathToFileURL(
    join(
      bundleDirectory,
      "node_modules",
      "@caelush",
      "ai",
      "dist",
      "adapters",
      "openai-compatible",
      "index.js",
    ),
  ).href;
  const anthropicAdapterModule = pathToFileURL(
    join(
      bundleDirectory,
      "node_modules",
      "@caelush",
      "ai",
      "dist",
      "adapters",
      "anthropic-messages",
      "index.js",
    ),
  ).href;
  const codingAgentModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "coding-agent", "dist", "index.js"),
  ).href;
  const agentModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "agent", "dist", "index.js"),
  ).href;
  // The packaged child probe composes the real AI core in a fresh process and speaks
  // both native dialects through one gateway.
  const packagedAiProbeSource = [
    `const ai = await import(${JSON.stringify(aiModule)});`,
    `const openai = await import(${JSON.stringify(openAIAdapterModule)});`,
    `const anthropic = await import(${JSON.stringify(anthropicAdapterModule)});`,
    `const coding = await import(${JSON.stringify(codingAgentModule)});`,
    `const agent = await import(${JSON.stringify(agentModule)});`,
    `const base = process.env.CAELUSH_PROVIDER_BASE_URL;`,
    `const unavailable = async () => { throw new Error("not used"); };`,
    `const definitions = coding.createDefaultCodingTools({ readFile: { readFileWithKind: unavailable }, readOnly: { readFileWithKind: unavailable, list: unavailable, listDirectoryWithKind: unavailable, listWithProbe: unavailable, find: unavailable, findWithRoot: unavailable, search: unavailable, searchWithRoot: unavailable }, patch: { apply: unavailable }, exec: { execute: unavailable }, process: { interact: unavailable }, git: { status: unavailable, diff: unavailable } });`,
    `const registryBuilder = new agent.DefaultAgentToolRegistryBuilder();`,
    `for (const definition of definitions) registryBuilder.register(definition.tool);`,
    `const toolSpecs = registryBuilder.build().modelSpecs();`,
    `const model = (provider, id, api) => ({ ref: { provider, model: id }, api, limits: { contextWindowTokens: 32000, maxOutputTokens: 4096 }, capabilities: { streaming: "SUPPORTED", toolCalling: "SUPPORTED", parallelToolCalls: "SUPPORTED", structuredOutput: "UNKNOWN", vision: "UNKNOWN", reasoning: "UNKNOWN", reasoningSummary: "UNKNOWN", promptCaching: "UNKNOWN", usageReporting: "SUPPORTED" }, source: "CONFIGURATION" });`,
    `const descriptors = [model("openai-compatible", "fixture-model", openai.OPENAI_COMPATIBLE_API_ID), model("anthropic-compatible", "fixture-model", anthropic.ANTHROPIC_MESSAGES_API_ID)];`,
    `const source = { id: "artifact-probe", priority: 0, resolve: (ref) => descriptors.find((item) => item.ref.provider === ref.provider && item.ref.model === ref.model), list: () => descriptors };`,
    `const subsystem = ai.createAISubsystem({ modelSources: [source], providers: [{ id: "openai-compatible", endpoint: base, defaultApi: openai.OPENAI_COMPATIBLE_API_ID, allowUnknownModels: false, credentials: { resolve: async () => ({ apiKey: process.env.CAELUSH_PROVIDER_API_KEY }) } }, { id: "anthropic-compatible", endpoint: base.replace(/\\/v1$/, ""), defaultApi: anthropic.ANTHROPIC_MESSAGES_API_ID, allowUnknownModels: false, credentials: { resolve: async () => ({ apiKey: process.env.CAELUSH_PROVIDER_API_KEY }) } }], adapters: [openai.createOpenAICompatibleApiAdapter(), anthropic.createAnthropicMessagesApiAdapter()] });`,
    `const openAIResult = await subsystem.gateway.complete({ model: { provider: "openai-compatible", model: "fixture-model" }, messages: [{ role: "user", content: "packaged child probe" }], tools: toolSpecs, toolChoice: { type: "AUTO" } });`,
    `if (openAIResult.text !== "artifact smoke complete") process.exit(1);`,
    `const anthropicResult = await subsystem.gateway.complete({ model: { provider: "anthropic-compatible", model: "fixture-model" }, messages: [{ role: "user", content: "packaged child probe" }] });`,
    `if (anthropicResult.text !== "artifact anthropic complete") process.exit(1);`,
    `if (anthropicResult.resolution.api !== anthropic.ANTHROPIC_MESSAGES_API_ID) process.exit(1);`,
  ].join("\n");
  const packagedAdapterProbe = await run(
    process.execPath,
    ["--input-type=module", "-e", packagedAiProbeSource],
    {
      cwd: bundleDirectory,
      env: environment,
    },
  );
  assert(
    packagedAdapterProbe.exitCode === 0,
    `packaged AI dialect child probe failed: ${packagedAdapterProbe.stderr}`,
  );
  // The in-process probe runs the same composition against the same fake provider, so
  // a bundle that only works in a child process cannot pass unnoticed.
  const { createAISubsystem } = await import(aiModule);
  const { createOpenAICompatibleApiAdapter, OPENAI_COMPATIBLE_API_ID } = await import(
    openAIAdapterModule
  );
  const { createAnthropicMessagesApiAdapter, ANTHROPIC_MESSAGES_API_ID } = await import(
    anthropicAdapterModule
  );
  const providerRoot = provider.url.replace(/\/v1$/, "");
  const probeDescriptors = [
    probeDescriptor("openai-compatible", "fixture-model", OPENAI_COMPATIBLE_API_ID),
    probeDescriptor("anthropic-compatible", "fixture-model", ANTHROPIC_MESSAGES_API_ID),
  ];
  const ai = createAISubsystem({
    modelSources: [
      {
        id: "artifact-probe",
        priority: 0,
        resolve: (ref) =>
          probeDescriptors.find(
            (item) => item.ref.provider === ref.provider && item.ref.model === ref.model,
          ),
        list: () => probeDescriptors,
      },
    ],
    providers: [
      {
        id: "openai-compatible",
        endpoint: provider.url,
        defaultApi: OPENAI_COMPATIBLE_API_ID,
        allowUnknownModels: false,
        credentials: { resolve: async () => ({ apiKey: secret }) },
      },
      {
        id: "anthropic-compatible",
        endpoint: providerRoot,
        defaultApi: ANTHROPIC_MESSAGES_API_ID,
        allowUnknownModels: false,
        credentials: { resolve: async () => ({ apiKey: secret }) },
      },
    ],
    adapters: [createOpenAICompatibleApiAdapter(), createAnthropicMessagesApiAdapter()],
  });
  const directResult = await ai.gateway.complete({
    model: { provider: "openai-compatible", model: "fixture-model" },
    messages: [{ role: "user", content: "direct provider probe" }],
  });
  assert(
    directResult.text === "artifact smoke complete",
    "packaged OpenAI-compatible adapter probe failed",
  );
  const directAnthropicResult = await ai.gateway.complete({
    model: { provider: "anthropic-compatible", model: "fixture-model" },
    messages: [{ role: "user", content: "direct provider probe" }],
  });
  assert(
    directAnthropicResult.text === "artifact anthropic complete" &&
      directAnthropicResult.resolution.api === ANTHROPIC_MESSAGES_API_ID,
    "packaged Anthropic Messages adapter probe failed",
  );
  provider.requests.length = 0;

  const version = await runLauncher(binPath, ["--version"], {
    cwd: workspaceDirectory,
    env: environment,
  });
  assert(version.exitCode === 0, `--version failed: ${version.stderr}`);
  assert(version.stdout.trim() === `caelush ${manifest.version}`, "packaged version mismatch");

  const help = await runLauncher(binPath, ["--help"], {
    cwd: workspaceDirectory,
    env: environment,
  });
  assert(help.exitCode === 0 && help.stdout.includes("caelush -p"), "packaged help is incomplete");

  const nonTty = await runLauncher(binPath, [], {
    cwd: workspaceDirectory,
    env: environment,
  });
  assert(nonTty.exitCode === 3, "non-TTY interactive invocation returned the wrong exit code");
  assert(nonTty.stdout === "", "non-TTY interactive invocation polluted stdout");
  assert(
    nonTty.stderr.trim() ===
      'Interactive Caelush requires a terminal.\nUse `caelush --print "..."` for non-interactive execution.',
    "non-TTY interactive guidance was not clean or exact",
  );

  const doctor = await runLauncher(binPath, ["doctor"], {
    cwd: workspaceDirectory,
    env: environment,
  });
  assert(doctor.exitCode === 0, `packaged doctor failed: ${doctor.stdout}\n${doctor.stderr}`);
  assert(doctor.stdout.includes("Provider configured: yes"), "doctor missed public provider state");
  assert(!doctor.stdout.includes(secret), "doctor leaked the provider secret");
  if (packagedSandboxRunner !== undefined) {
    assert(
      doctor.stdout.includes("Restricted execution Provider: native runner verified"),
      `packaged doctor did not verify the bundled Runner without an environment override: ${doctor.stdout}`,
    );
    await assertTamperedRunnerFailsClosed({
      sandboxManifest: packagedSandboxRunner.sandboxManifest,
      environment,
    });
  }

  const initialDaemonCount = await countArtifactDaemons(bundleDirectory);
  const single = await runConfiguredLauncher(
    ["-p", "Reply exactly PACKAGE_OK", "--output-format", "json"],
    {
      cwd: workspaceDirectory,
      env: environment,
    },
  );
  const singleResult = JSON.parse(single.stdout);
  assert(
    single.exitCode === 0 && singleResult.success === true,
    `single-command artifact E2E failed: stdout=${single.stdout}; stderr=${single.stderr}`,
  );
  assert(singleResult.finalText === "PACKAGE_OK", "single-command output was not exact");
  const reusedDaemonCount = await countArtifactDaemons(bundleDirectory);
  assert(reusedDaemonCount === initialDaemonCount + 1, "single-command did not start one daemon");

  const reused = await runConfiguredLauncher(["-p", "Reply exactly REUSE_OK"], {
    cwd: workspaceDirectory,
    env: environment,
  });
  assert(reused.exitCode === 0, `daemon reuse artifact E2E failed: ${reused.stderr}`);
  assert(reused.stdout.trim() === "REUSE_OK", "daemon reuse output was not exact");
  assert(
    (await countArtifactDaemons(bundleDirectory)) === reusedDaemonCount,
    "daemon reuse spawned another daemon",
  );

  const pipeHome = join(testRoot, "pipe-home");
  const pipeWorkspace = join(testRoot, "pipe-workspace");
  await mkdir(pipeHome, { recursive: true });
  await mkdir(pipeWorkspace, { recursive: true });
  const piped = await runConfiguredLauncher(["-p"], {
    cwd: pipeWorkspace,
    env: { ...environment, CAELUSH_HOME: pipeHome },
    input: "Reply exactly PIPE_OK\n",
  });
  assert(piped.exitCode === 0, `piped print failed: ${piped.stderr}`);
  assert(piped.stdout.trim() === "PIPE_OK", "piped print output was not exact");

  const continueHome = join(testRoot, "continue-home");
  const continueWorkspace = join(testRoot, "continue-workspace");
  await mkdir(continueHome, { recursive: true });
  await mkdir(continueWorkspace, { recursive: true });
  const continueEnvironment = { ...environment, CAELUSH_HOME: continueHome };
  const remembered = await runConfiguredLauncher(["-p", "Remember marker PACKAGED-ORANGE-912"], {
    cwd: continueWorkspace,
    env: continueEnvironment,
  });
  assert(remembered.exitCode === 0, `packaged Session seed failed: ${remembered.stderr}`);
  const continued = await runConfiguredLauncher(["-c", "-p", "What marker did I mention?"], {
    cwd: continueWorkspace,
    env: continueEnvironment,
  });
  assert(continued.exitCode === 0, `packaged Session continue failed: ${continued.stderr}`);
  assert(continued.stdout.trim() === "PACKAGED-ORANGE-912", "Session history was not reused");

  await stopArtifactDaemons(bundleDirectory);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  const parallelHome = join(testRoot, "parallel-home");
  const parallelWorkspaceA = join(testRoot, "parallel-workspace-a");
  const parallelWorkspaceB = join(testRoot, "parallel-workspace-b");
  await mkdir(parallelHome, { recursive: true });
  await mkdir(parallelWorkspaceA, { recursive: true });
  await mkdir(parallelWorkspaceB, { recursive: true });
  const parallelResults = await Promise.all([
    runConfiguredLauncher(["-p", "read fixture file", "--output-format", "json"], {
      cwd: parallelWorkspaceA,
      env: { ...environment, CAELUSH_HOME: parallelHome },
    }),
    runConfiguredLauncher(["-p", "read fixture file again", "--output-format", "json"], {
      cwd: parallelWorkspaceB,
      env: { ...environment, CAELUSH_HOME: parallelHome },
    }),
  ]);
  assert(
    (await countArtifactDaemons(bundleDirectory)) === 1,
    "parallel startup did not converge on exactly one daemon",
  );
  for (const result of parallelResults) {
    assert(
      result.exitCode === 0,
      `parallel packaged print failed: exit=${result.exitCode}; stdout=${result.stdout}; stderr=${result.stderr}; providerRequests=${JSON.stringify(provider.requests.map((request) => ({ method: request.method, url: request.url, roles: request.messages?.map((message) => message?.role) })))}; providerUrl=${provider.url}`,
    );
    const parsed = JSON.parse(result.stdout);
    assert(parsed.success === true, "parallel packaged print did not complete");
    assert(parsed.finalText === "artifact smoke complete", "unexpected fake provider result");
    assert(
      !result.stdout.includes(secret) && !result.stderr.includes(secret),
      "secret leaked in print output",
    );
  }

  const patchHome = join(testRoot, "patch-home");
  const patchWorkspace = join(testRoot, "patch-workspace");
  await mkdir(patchHome, { recursive: true });
  await mkdir(patchWorkspace, { recursive: true });
  await writeFile(join(patchWorkspace, "fixture.txt"), "before patch\n", "utf8");
  const patchEnvironment = { ...environment, CAELUSH_HOME: patchHome };
  const patchRequest = await runConfiguredLauncher(
    ["-p", "patch fixture", "--output-format", "json"],
    { cwd: patchWorkspace, env: patchEnvironment },
  );
  const patchResult = JSON.parse(patchRequest.stdout);
  assert(
    patchRequest.exitCode === 0 && patchResult.success === true,
    `Full Access artifact patch failed: ${patchRequest.stderr}`,
  );
  assert(
    (await readFile(join(patchWorkspace, "fixture.txt"), "utf8")) === "after patch\n",
    "artifact patch did not mutate the workspace",
  );

  const stream = await runConfiguredLauncher(
    ["-p", "stream fixture", "--output-format", "stream-json"],
    {
      cwd: workspaceDirectory,
      env: environment,
    },
  );
  assert(stream.exitCode === 0, `stream-json failed: ${stream.stderr}`);
  const streamRecords = stream.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert(
    streamRecords.some((record) => record.type === "result" && record.result.success),
    "stream-json result missing",
  );
  assert(
    streamRecords.every((record) => !JSON.stringify(record).includes(secret)),
    "stream-json leaked the provider secret",
  );

  await stopArtifactDaemons(bundleDirectory);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  const incompatibleOwner = await startIncompatiblePortOwner();
  try {
    const incompatible = await runLauncher(binPath, ["-p", "Reply exactly INCOMPATIBLE_OK"], {
      cwd: workspaceDirectory,
      env: { ...environment, CAELUSH_HOME: join(testRoot, "incompatible-home") },
    });
    assert(incompatible.exitCode === 3, "incompatible port did not fail with bootstrap error");
    const ownerProbe = await hostFetch(`${incompatibleOwner.url}/owner`);
    assert(ownerProbe.status === 200, "launcher disturbed an unrelated port owner");
  } finally {
    await incompatibleOwner.close();
  }

  const customDaemon = await startFakeDaemon(manifest.version);
  try {
    const customHome = join(testRoot, "custom-home");
    const customRun = await runLauncher(
      binPath,
      ["-p", "custom daemon", "--output-format", "json"],
      {
        cwd: workspaceDirectory,
        env: {
          ...environment,
          CAELUSH_HOME: customHome,
          CAELUSH_DAEMON_URL: customDaemon.url,
        },
      },
    );
    assert(customRun.exitCode !== 0, "custom daemon smoke unexpectedly completed a fake run");
    assert(
      (await countArtifactDaemons(bundleDirectory)) === 0,
      "custom daemon URL caused a local daemon spawn",
    );
  } finally {
    await customDaemon.close();
  }

  // The restricted presets, end to end through the packaged Daemon: capability query, preparation,
  // a refused write, a confined write, and a restart that must not lose either the capability facts
  // or the standing workspace grant.
  //
  // Gated on the artifact declaring a packaged Runner, because that is the artifact-level fact the
  // restricted composition depends on. A packaged-Runner bundle smoked on another platform is a
  // mismatch worth failing loudly rather than quietly skipping, and a bundle with no Runner has no
  // restricted composition to prove — so the skip is printed instead of being silent, and on the
  // Windows host this pairs with the packaged-Runner smoke always runs.
  if (packagedSandboxRunner !== undefined && process.platform !== "win32") {
    throw new Error(
      `the artifact packages a ${packagedSandboxRunner.sandboxManifest.platform}/${packagedSandboxRunner.sandboxManifest.arch} sandbox Runner but the smoke is running on ${process.platform}`,
    );
  }
  if (packagedSandboxRunner === undefined) {
    process.stdout.write(
      "artifact-e2e: the release declares no packaged sandbox runner, so the restricted-permission proof does not apply\n",
    );
  } else {
    await assertRestrictedSandbox({ binPath, bundleDirectory, testRoot, environment, provider });
  }

  const database = join(homeDirectory, "caelush.db");
  assert((await stat(database)).isFile(), "packaged daemon did not create the SQLite database");
  const daemonModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "daemon", "dist", "diagnostics.js"),
  ).href;
  const runtimeModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "runtime", "dist", "index.js"),
  ).href;
  const protocolModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "protocol", "dist", "index.js"),
  ).href;
  const diagnostics = await import(daemonModule);
  assert(
    (await diagnostics.checkNodePtyLoadability()).available,
    "packaged node-pty is not loadable",
  );
  assert(
    diagnostics.inspectMigrationAssets().available,
    "packaged Drizzle migrations are unavailable",
  );
  await runPackagedPty(runtimeModule, protocolModule, workspaceDirectory);

  const logPath = join(homeDirectory, "logs", "daemon.log");
  try {
    const log = await readFile(logPath, "utf8");
    assert(!log.includes(secret), "daemon log leaked the provider secret");
  } catch {
    // A quiet daemon is allowed to leave an empty/no log file on this smoke path.
  }
  const manifestText = await readFile(join(bundleDirectory, "manifest.json"), "utf8");
  assert(!manifestText.includes(secret), "manifest leaked the provider secret");
  process.stdout.write(`artifact-e2e passed: ${manifest.version}\n`);
} finally {
  await provider.close();
  await stopArtifactDaemons(bundleDirectory);
  await rm(testRoot, { recursive: true, force: true });
}

async function startFakeProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const requestRecord = { method: request.method, url: request.url };
    requests.push(requestRecord);
    const isOpenAIRoute = request.method === "POST" && request.url === "/v1/chat/completions";
    const isAnthropicRoute = request.method === "POST" && request.url === "/v1/messages";
    if (!isOpenAIRoute && !isAnthropicRoute) {
      response.writeHead(404).end();
      return;
    }
    const body = await readRequestBody(request);
    const payload = JSON.parse(body);
    Object.assign(requestRecord, payload);
    // The packaged bundle must speak both native API dialects through one gateway, so
    // this provider answers the OpenAI-compatible route and the native Anthropic
    // Messages route from the same script.
    if (isAnthropicRoute) {
      const systemText = Array.isArray(payload.system)
        ? payload.system.map((block) => block?.text ?? "").join("\n")
        : "";
      const answer = systemText.includes("Review the supplied")
        ? JSON.stringify({ verdict: "PASS", summary: "artifact smoke verified" })
        : "artifact anthropic complete";
      writeAnthropicSse(response, answer);
      return;
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const review = messages.some((message) => contains(message?.content, "Review the supplied"));
    const toolUsed = messages.some((message) => message?.role === "tool");
    const promptText = messages
      .map((message) => (typeof message?.content === "string" ? message.content : ""))
      .join("\n");
    const wantsRead = promptText.includes("read fixture");
    const wantsPatch = promptText.includes("patch fixture");
    if (!review && wantsRead && !toolUsed) {
      writeSse(response, toolCallChunk());
      return;
    }
    if (!review && wantsPatch && !toolUsed) {
      writeSse(
        response,
        toolCallChunk(
          "apply_patch",
          {
            patch:
              "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before patch\n+after patch\n*** End Patch",
          },
          "artifact-patch",
        ),
      );
      return;
    }
    const answer = promptText.includes("PACKAGE_OK")
      ? "PACKAGE_OK"
      : promptText.includes("REUSE_OK")
        ? "REUSE_OK"
        : promptText.includes("PIPE_OK")
          ? "PIPE_OK"
          : promptText.includes("PACKAGED-ORANGE-912")
            ? "PACKAGED-ORANGE-912"
            : wantsPatch
              ? "PATCH_OK"
              : "artifact smoke complete";
    writeSse(
      response,
      textChunk(
        review ? JSON.stringify({ verdict: "PASS", summary: "artifact smoke verified" }) : answer,
      ),
    );
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fake provider did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      }),
  };
}

async function startFakeDaemon(version) {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/health") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          service: "caelush-daemon",
          status: "ready",
          apiVersion: "v1",
          protocolVersion: 1,
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/info") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          apiVersion: "v1",
          protocolVersion: 1,
          daemonVersion: version,
          capabilities: {
            runExecution: true,
            runRecovery: true,
            cancellation: true,
            approvals: true,
            sseReplay: true,
          },
          runtimeKinds: ["local"],
          configuredProviders: [],
          defaultRunConfiguration: {
            runtime: { id: "local", kind: "local" },
            permissionProfile: "PROJECT_ACCESS",
            approvalPolicy: "DANGEROUS_ONLY",
            limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
          },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fake daemon did not bind.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      }),
  };
}

async function startIncompatiblePortOwner() {
  const server = createServer((request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ owner: "unrelated-test-service", path: request.url }));
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(43120, "127.0.0.1", resolvePromise);
  });
  return {
    url: "http://127.0.0.1:43120",
    close: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      }),
  };
}

/** The minimal safe model descriptor the artifact probe composes with. */
function probeDescriptor(provider, model, api) {
  return {
    ref: { provider, model },
    api,
    limits: { contextWindowTokens: 32_000, maxOutputTokens: 16_384 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "SUPPORTED",
    },
    source: "CONFIGURATION",
  };
}

function readRequestBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

/**
 * One complete native Anthropic Messages text turn.
 *
 * This is the packaged proof that a second, structurally different native dialect
 * works through the same `@caelush/ai` gateway: the probe never touches the legacy
 * `@caelush/llm` invocation surface, which Phase 2D retired.
 */
function writeAnthropicSse(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  const events = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_artifact_probe",
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  for (const entry of events) {
    response.write(`event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
  }
  response.end();
}

function textChunk(text) {
  const id = `artifact-${Date.now()}`;
  return [
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
}

function toolCallChunk(
  name = "read_file",
  input = { path: "fixture.txt" },
  toolId = "artifact-read",
) {
  const id = `artifact-tool-${Date.now()}`;
  return [
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: toolId,
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
}

async function runPackagedPty(runtimeModule, protocolModule, workspace) {
  const source = [
    `const { LocalRuntime } = await import(${JSON.stringify(runtimeModule)});`,
    `const { createRunId, createWorkspaceId } = await import(${JSON.stringify(protocolModule)});`,
    "const runtime = new LocalRuntime();",
    `const scope = await runtime.openWorkspace({ id: createWorkspaceId(), path: ${JSON.stringify(workspace)} });`,
    "const ownerRunId = createRunId();",
    'const result = await scope.exec.execute({ ownerRunId, command: "echo artifact-pty", tty: true, yieldTimeMs: 2000 });',
    'if (!result.output.includes("artifact-pty")) process.exit(1);',
    // A ConPTY exit can land just after the yield deadline, so a single yield races the exit event.
    // Drain the session to its terminal state instead of demanding one race-free observation.
    'if (result.status === "RUNNING") {',
    "  if (result.sessionId === undefined) process.exit(1);",
    '  const settled = await scope.exec.interact({ ownerRunId, sessionId: result.sessionId, chars: "", yieldTimeMs: 5000 });',
    '  if (settled.status !== "EXITED" || settled.exitCode !== 0) process.exit(1);',
    "}",
    "if (result.exitCode !== undefined && result.exitCode !== 0) process.exit(1);",
    "process.exit(0);",
  ].join("\n");
  const result = await run(process.execPath, ["--input-type=module", "-e", source], {
    cwd: workspace,
    env: process.env,
  });
  assert(
    result.exitCode === 0,
    `packaged PTY smoke failed: stdout=${result.stdout}; stderr=${result.stderr}`,
  );
}

function runLauncher(binPath, args, options) {
  return run(process.execPath, [binPath, ...args], options);
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out running ${command} ${args.join(" ")}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function countArtifactDaemons(bundleDirectory) {
  const needle = join(bundleDirectory, "node_modules", "@caelush", "daemon", "dist", "main.js");
  if (process.platform === "win32") {
    const escaped = needle.replaceAll("'", "''");
    const script = `$needle='${escaped}'; (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$needle*" } | Measure-Object).Count`;
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      // A process query never reads stdin; not handing it a stdin pipe also works on hosts that
      // cannot duplicate an unusual parent stdin handle.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const count = Number.parseInt(output.trim(), 10);
    // A broken counter must not silently satisfy the `=== 0` assertions below.
    if (!Number.isSafeInteger(count)) {
      throw new Error(`Unable to count packaged daemons: ${JSON.stringify(output.trim())}`);
    }
    return count;
  }
  const processes = execFileSync("ps", ["-eo", "args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return processes.split("\n").filter((line) => line.includes(needle)).length;
}

/**
 * The restricted presets, exercised through the extracted artifact alone.
 *
 * ```text
 * Step 1  VIEW_ONLY            a write crosses the boundary -> approval, then the OS still refuses it
 * Step 2  WORKSPACE_WRITE      prepared first, so the write lands -- inside the workspace and nowhere else
 * Step 3  restart              capability facts and the standing workspace grant must agree afterwards
 * ```
 *
 * Every fact this proves comes from the packaged Daemon over its own API, so a source-tree dependency
 * cannot make it pass.
 *
 * The Runs go through the API rather than `caelush -p` on purpose. Both restricted presets carry an
 * `ON_BOUNDARY` approval policy, and the CLI refuses every preset that is not `NEVER_ASK` when it has
 * no approval channel ("This non-interactive CLI session has no approval channel; choose --permission
 * full-access explicitly or use a TTY"). A restricted Run therefore cannot be launched through `-p`
 * at all, and an approval could never be answered if it were. Driving the Daemon directly is also
 * what makes Step 1 meaningful: the approval is granted deliberately, so the fixture staying
 * unchanged cannot be explained by the Run merely waiting for a human.
 *
 * The workspace starts unprepared on purpose: on a real Windows host `VIEW_ONLY` is `READY` without
 * any grant while `WORKSPACE_WRITE` reports `PREPARATION_REQUIRED`, and that asymmetry is what makes
 * Step 2 a preparation test rather than a formality.
 */
async function assertRestrictedSandbox({
  binPath,
  bundleDirectory,
  testRoot,
  environment,
  provider,
}) {
  const home = join(testRoot, "restricted-home");
  const workspace = join(testRoot, "restricted-workspace");
  const fixturePath = join(workspace, "fixture.txt");
  const outsideSentinel = join(testRoot, "restricted-outside.txt");
  const homeSentinel = join(home, "home-sentinel.txt");
  const outsideContent = "outside sentinel\n";
  const homeContent = "home sentinel\n";
  const model = { provider: "openai-compatible", model: "fixture-model" };
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(fixturePath, "before patch\n", "utf8");
  await writeFile(outsideSentinel, outsideContent, "utf8");
  await writeFile(homeSentinel, homeContent, "utf8");
  const env = { ...environment, CAELUSH_HOME: home };

  const { CaelushClient } = await import(
    pathToFileURL(join(bundleDirectory, "node_modules", "@caelush", "client", "dist", "index.js"))
      .href
  );

  /**
   * Bring the Daemon up from the workspace under test.
   *
   * Full Access is used only to *start* the packaged product: it is the one preset the CLI can launch
   * without an approval channel, and this call is about getting a Daemon listening, not about
   * exercising the sandbox. The workspace it registers is the one every restricted Run below uses.
   */
  const bootDaemon = async (prompt) => {
    const boot = await runLauncher(
      binPath,
      ["-p", prompt, "--output-format", "json", "--permission", "full-access"],
      { cwd: workspace, env },
    );
    assert(
      boot.exitCode === 0 && JSON.parse(boot.stdout).success === true,
      `packaged Daemon did not come up: stdout=${boot.stdout}; stderr=${boot.stderr}`,
    );
  };
  await bootDaemon("Reply exactly PACKAGE_OK");

  const client = new CaelushClient({ baseUrl: PACKAGED_DAEMON_URL });

  /**
   * The registered workspace, via the registry's own canonicalization.
   *
   * The registry lower-cases and forward-slashes the path, so comparing raw strings would fail on a
   * Windows temp path whose drive letter or directory case came back differently.
   */
  const registerWorkspace = async () => {
    const normalize = (value) => resolve(String(value)).replaceAll("\\", "/").toLowerCase();
    const items = (await client.listWorkspaces()).items;
    const found = items.find((item) => normalize(item.canonicalPath) === normalize(workspace));
    assert(
      found !== undefined,
      `the packaged Daemon did not register the restricted workspace: ${JSON.stringify(items)}`,
    );
    return { id: found.id, path: found.canonicalPath };
  };
  const statusesOf = (capabilities) =>
    Object.fromEntries(capabilities.presets.map((preset) => [preset.id, preset.status]));

  /** Create and start one Run at an explicit preset. */
  const startRunAt = async (ref, presetId, goal) => {
    const session = await client.createSession({
      title: goal,
      defaultWorkspace: ref,
      defaultModel: model,
      metadata: {},
    });
    const run = await client.createRun(session.id, {
      goal,
      workspace: ref,
      model,
      runtime: { id: "local", kind: "local" },
      preset: { id: presetId, expectedVersion: 1 },
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 120_000 },
    });
    await client.startRun(run.id);
    return run;
  };

  /**
   * Settle a Run and fail if it ever asks for an approval.
   *
   * Measured, not assumed: neither preset stops for a human here. The Daemon decides the
   * boundary-crossing write itself, so an approval appearing would be a policy change (or a
   * regression that turns an automatic refusal into a prompt nobody can answer), and either way the
   * gate should say so rather than quietly answer it and move on.
   */
  const settleWithoutApprovals = async (runId, deadlineMs = 30_000) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const pending = (await client.listPendingApprovals(runId)).items;
      assert(
        pending.length === 0,
        `a restricted Run asked for ${pending.length} approval(s) instead of deciding the boundary itself: ${JSON.stringify(pending.map((item) => item.id))}`,
      );
      const run = await client.getRun(runId);
      if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "BUDGET_EXCEEDED"].includes(run.status))
        return run;
      if (Date.now() > deadline)
        throw new Error(`Run ${runId} did not settle; last status ${run.status}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  };

  /**
   * How many model turns carried a tool result.
   *
   * This is what keeps Step 1 from being vacuous. "The fixture did not change" is also true of a Run
   * whose model never asked for a write at all, so the gate additionally requires that the write
   * actually reached the tool layer and came back with a result.
   */
  const toolTurns = (requests) =>
    requests.filter((request) =>
      (request.messages ?? []).some((message) => message?.role === "tool"),
    ).length;

  // The artifact must serve a restricted Provider from its own bundled Runner. A release that
  // advertises the gate but composes no provider would report UNAVAILABLE here.
  const global = await client.getSecurityCapabilities();
  assert(
    global.processSandbox?.status === "AVAILABLE",
    `packaged Daemon did not serve a restricted Provider: ${JSON.stringify(global.processSandbox)}`,
  );
  assert(
    global.processSandbox.enforcement !== "NONE",
    `packaged Daemon reported no enforcement: ${JSON.stringify(global.processSandbox)}`,
  );
  assert(
    global.workspacePreparationSupported === true,
    "packaged Daemon did not report a workspace preparation port",
  );

  const ref = await registerWorkspace();
  const unprepared = await client.getWorkspaceSecurityCapabilities(ref.id);
  const unpreparedStatuses = statusesOf(unprepared);
  assert(
    unpreparedStatuses.VIEW_ONLY === "AVAILABLE",
    `an unprepared workspace must still allow VIEW_ONLY: ${JSON.stringify(unpreparedStatuses)}`,
  );
  assert(
    unpreparedStatuses.WORKSPACE_WRITE === "PREPARATION_REQUIRED",
    `an unprepared workspace must require preparation for WORKSPACE_WRITE: ${JSON.stringify(unpreparedStatuses)}`,
  );
  assert(
    unpreparedStatuses.FULL_ACCESS === "AVAILABLE",
    `the packaged artifact must offer FULL_ACCESS: ${JSON.stringify(unpreparedStatuses)}`,
  );
  assert(
    unprepared.preparation?.status === "REQUIRED",
    `an unprepared workspace must report the requirement: ${JSON.stringify(unprepared.preparation)}`,
  );

  // --- Step 1: a VIEW_ONLY write must not land. --------------------------------------------------
  //
  // The Daemon refuses the write itself and the Run still completes, so this does not wait for an
  // approval: it asserts that none is needed. What makes the unchanged fixture meaningful is the
  // differential — the *identical* goal writes the *identical* file under WORKSPACE_WRITE in Step 2 —
  // plus the tool-turn guard below, which excludes a Run whose model never asked for a write.
  const viewOnlyRequests = provider.requests.length;
  const viewOnlyFixture = await readFile(fixturePath, "utf8");
  const viewOnly = await startRunAt(ref, "VIEW_ONLY", "patch fixture");
  const viewOnlyRun = await settleWithoutApprovals(viewOnly.id);
  assert(
    (await readFile(fixturePath, "utf8")) === viewOnlyFixture,
    `a VIEW_ONLY Run mutated the workspace (run settled ${viewOnlyRun.status})`,
  );
  assert(
    viewOnlyRun.securityPolicy?.preset?.id === "VIEW_ONLY",
    `the packaged Run carried the wrong preset: ${JSON.stringify(viewOnlyRun.securityPolicy?.preset)}`,
  );
  assert(
    toolTurns(provider.requests.slice(viewOnlyRequests)) >= 1,
    "the VIEW_ONLY Run never carried a tool result, so the write was never attempted",
  );

  // --- Step 2: once prepared, a WORKSPACE_WRITE mutation must land -- and stay inside. ----------
  const prepared = await client.prepareWorkspaceSecurity(ref.id, {
    id: "WORKSPACE_WRITE",
    expectedVersion: 1,
  });
  assert(
    prepared.status === "READY",
    `packaged preparation did not become READY: ${JSON.stringify(prepared)}`,
  );
  const ready = await client.getWorkspaceSecurityCapabilities(ref.id);
  const readyStatuses = statusesOf(ready);
  assert(
    readyStatuses.WORKSPACE_WRITE === "AVAILABLE",
    `a prepared workspace must allow WORKSPACE_WRITE: ${JSON.stringify(readyStatuses)}`,
  );
  assert(
    ready.preparation?.status === "READY",
    `a prepared workspace must report readiness: ${JSON.stringify(ready.preparation)}`,
  );

  const workspaceWriteRequests = provider.requests.length;
  const workspaceWrite = await startRunAt(ref, "WORKSPACE_WRITE", "patch fixture");
  const workspaceWriteRun = await settleWithoutApprovals(workspaceWrite.id);
  assert(
    workspaceWriteRun.status === "COMPLETED",
    `a prepared WORKSPACE_WRITE Run did not complete: ${JSON.stringify({ status: workspaceWriteRun.status, exitReason: workspaceWriteRun.exitReason })}`,
  );
  assert(
    (await readFile(fixturePath, "utf8")) === "after patch\n",
    "a prepared WORKSPACE_WRITE Run did not mutate the workspace",
  );
  assert(
    toolTurns(provider.requests.slice(workspaceWriteRequests)) >= 1,
    "the WORKSPACE_WRITE Run never carried a tool result, so the write was never attempted",
  );
  assert(
    workspaceWriteRun.securityPolicy?.preset?.id === "WORKSPACE_WRITE",
    `the packaged Run carried the wrong preset: ${JSON.stringify(workspaceWriteRun.securityPolicy?.preset)}`,
  );
  // The positive result above is only half the claim. The other half is that the write reached the
  // workspace and nothing else: the sentinels sit outside it, one in the parent directory and one in
  // the Daemon home, and neither may move.
  assert(
    (await readFile(outsideSentinel, "utf8")) === outsideContent,
    "the packaged mutation escaped the workspace boundary",
  );
  assert(
    (await readFile(homeSentinel, "utf8")) === homeContent,
    "the packaged mutation wrote into the Daemon home",
  );

  // --- Step 3: restart. Capability facts and the standing grant must both survive. --------------
  const sandboxBefore = await client.getSecurityCapabilities();
  const capabilitiesBefore = await client.getWorkspaceSecurityCapabilities(ref.id);
  await stopArtifactDaemons(bundleDirectory);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

  // Re-seed the fixture so the post-restart Run is a fresh, independent mutation rather than a repeat
  // of the one that already landed. Its success is what shows the grant is still *usable*, not merely
  // still reported.
  await writeFile(fixturePath, "before patch\n", "utf8");
  await bootDaemon("Reply exactly PACKAGE_OK");
  const refAfterRestart = await registerWorkspace();
  assert(
    refAfterRestart.id === ref.id,
    `the workspace identity changed across the restart: before=${ref.id}; after=${refAfterRestart.id}`,
  );
  const afterRestart = await startRunAt(refAfterRestart, "WORKSPACE_WRITE", "patch fixture");
  const afterRestartRun = await settleWithoutApprovals(afterRestart.id);
  assert(
    afterRestartRun.status === "COMPLETED",
    `a WORKSPACE_WRITE Run failed after the Daemon restart, so the standing grant was lost: ${JSON.stringify({ status: afterRestartRun.status, exitReason: afterRestartRun.exitReason })}`,
  );
  assert(
    (await readFile(fixturePath, "utf8")) === "after patch\n",
    "a post-restart WORKSPACE_WRITE Run did not mutate the workspace",
  );

  const sandboxAfter = await client.getSecurityCapabilities();
  assert(
    JSON.stringify(sandboxAfter.processSandbox) === JSON.stringify(sandboxBefore.processSandbox),
    `the sandbox capability changed across the restart: before=${JSON.stringify(sandboxBefore.processSandbox)}; after=${JSON.stringify(sandboxAfter.processSandbox)}`,
  );
  assert(
    sandboxAfter.defaultPreset === sandboxBefore.defaultPreset,
    `the default preset changed across the restart: before=${sandboxBefore.defaultPreset}; after=${sandboxAfter.defaultPreset}`,
  );
  const capabilitiesAfter = await client.getWorkspaceSecurityCapabilities(refAfterRestart.id);
  assert(
    JSON.stringify(statusesOf(capabilitiesAfter)) ===
      JSON.stringify(statusesOf(capabilitiesBefore)),
    `workspace preset availability changed across the restart: before=${JSON.stringify(statusesOf(capabilitiesBefore))}; after=${JSON.stringify(statusesOf(capabilitiesAfter))}`,
  );
  assert(
    capabilitiesAfter.preparation?.status === "READY",
    `the standing workspace grant did not survive the restart: ${JSON.stringify(capabilitiesAfter.preparation)}`,
  );

  process.stdout.write(
    `artifact-e2e restricted sandbox: ${JSON.stringify({
      sandbox: sandboxAfter.processSandbox,
      unprepared: unpreparedStatuses,
      prepared: statusesOf(capabilitiesAfter),
    })}\n`,
  );
}

async function stopStaleArtifactDaemons() {
  if (process.platform === "win32") {
    const script =
      "$marker='*caelush-artifact-e2e-*'; $daemon='*@caelush*daemon*dist*main.js*'; Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like $marker -and $_.CommandLine -like $daemon } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
    } catch {
      /* A stale test daemon may already have exited. */
    }
    return;
  }
  try {
    const processes = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    for (const line of processes.split("\n")) {
      if (!line.includes("caelush-artifact-e2e-") || !line.includes("@caelush/daemon/dist/main.js"))
        continue;
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? "", 10);
      if (Number.isSafeInteger(pid) && pid !== process.pid) process.kill(pid, "SIGTERM");
    }
  } catch {
    /* Best-effort cleanup for stale test processes. */
  }
}

async function stopArtifactDaemons(bundleDirectory) {
  const needle = join(bundleDirectory, "node_modules", "@caelush", "daemon", "dist", "main.js");
  if (process.platform === "win32") {
    const escaped = needle.replaceAll("'", "''");
    const script = `$needle='${escaped}'; Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$needle*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
    } catch {
      /* The daemon may already have exited. */
    }
    return;
  }
  try {
    const processes = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    for (const line of processes.split("\n")) {
      if (!line.includes(needle)) continue;
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? "", 10);
      if (Number.isSafeInteger(pid) && pid !== process.pid) process.kill(pid, "SIGTERM");
    }
  } catch {
    /* Best-effort cleanup for the host process. */
  }
}

/**
 * A release that advertises `runtimeSandboxV1` must actually carry the Runner it claims.
 *
 * This runs against the extracted bundle with every sandbox environment override removed, so
 * neither the source checkout nor this shell can satisfy the assertions. Presence, the packaged
 * manifest, the release manifest, the Runner bytes, and the archive checksum records must all
 * agree before the smoke treats the artifact as sandbox-capable.
 */
async function inspectPackagedSandboxRunner(releaseManifest) {
  if (releaseManifest.featureGates?.runtimeSandboxV1 === true) {
    assert(
      releaseManifest.sandboxRunner === "PACKAGED",
      "release advertises runtimeSandboxV1 but does not declare a packaged sandbox runner",
    );
  }
  if (releaseManifest.sandboxRunner !== "PACKAGED") return undefined;

  const runnerDirectory = join(bundleDirectory, SANDBOX_RUNNER_DIRECTORY_NAME);
  const sandboxManifestPath = join(runnerDirectory, SANDBOX_RUNNER_MANIFEST_FILENAME);
  assert(
    await fileExists(sandboxManifestPath),
    `packaged sandbox runner manifest is missing: ${sandboxManifestPath}`,
  );
  const sandboxManifest = JSON.parse(await readFile(sandboxManifestPath, "utf8"));
  assert(
    sandboxManifest.sha256 === releaseManifest.sandboxRunnerManifest?.sha256,
    "release manifest and packaged sandbox manifest disagree on the runner hash",
  );
  const runnerPath = join(runnerDirectory, sandboxManifest.executableName);
  assert(await fileExists(runnerPath), `packaged sandbox runner is missing: ${runnerPath}`);
  const measured = createHash("sha256")
    .update(await readFile(runnerPath))
    .digest("hex");
  assert(
    measured === sandboxManifest.sha256,
    "packaged sandbox runner bytes do not match the packaged manifest hash",
  );

  const coverage = await readChecksumCoverage();
  const runnerEntry = `${SANDBOX_RUNNER_DIRECTORY_NAME}/${sandboxManifest.executableName}`;
  const manifestEntry = `${SANDBOX_RUNNER_DIRECTORY_NAME}/${SANDBOX_RUNNER_MANIFEST_FILENAME}`;
  for (const required of [runnerEntry, manifestEntry]) {
    assert(
      coverage.has(required),
      `archive checksums do not cover the packaged runner: ${required}`,
    );
  }
  assert(
    coverage.get(runnerEntry) === sandboxManifest.sha256,
    "archive checksum disagrees with the packaged sandbox runner hash",
  );
  return { sandboxManifest, runnerPath, sandboxManifestPath };
}

async function readChecksumCoverage() {
  const checksums = await readFile(join(bundleDirectory, "checksums.sha256"), "utf8");
  const coverage = new Map();
  for (const line of checksums.trim().split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^(?<hash>[0-9a-f]{64})\x20{2}(?<path>.+)$/.exec(line);
    if (match === null) throw new Error("Invalid release checksum record in the extracted bundle.");
    coverage.set(match.groups.path, match.groups.hash);
  }
  return coverage;
}

/**
 * A tampered Runner must fail closed.
 *
 * The extracted bundle is copied so the pristine artifact keeps serving the remaining smoke
 * steps, then exactly one byte of the packaged Runner is flipped. The shipped doctor must stop
 * reporting the Runner as verified and must surface the bounded hash-mismatch reason code instead
 * of silently falling back to an unrestricted host probe.
 */
async function assertTamperedRunnerFailsClosed({ sandboxManifest, environment }) {
  const tamperedBundle = join(testRoot, "tampered-bundle");
  await cp(bundleDirectory, tamperedBundle, { recursive: true });
  const tamperedRunnerPath = join(
    tamperedBundle,
    SANDBOX_RUNNER_DIRECTORY_NAME,
    sandboxManifest.executableName,
  );
  const original = await readFile(tamperedRunnerPath);
  assert(original.length > 0, "packaged sandbox runner is empty");
  const tampered = Buffer.from(original);
  // Flip one bit of the final byte: the image stays loadable, so only the advertised hash
  // changes. That isolates artifact-identity checking from binary corruption.
  tampered[tampered.length - 1] ^= 0x01;
  assert(!tampered.equals(original), "tamper probe did not change the packaged runner bytes");
  await writeFile(tamperedRunnerPath, tampered);

  const tamperedDoctor = await runLauncher(join(tamperedBundle, "bin", "caelush"), ["doctor"], {
    cwd: workspaceDirectory,
    env: environment,
  });
  assert(
    !tamperedDoctor.stdout.includes("Restricted execution Provider: native runner verified"),
    `tampered packaged runner was still reported as verified: ${tamperedDoctor.stdout}`,
  );
  assert(
    tamperedDoctor.stdout.includes("Restricted execution Provider: RUNNER_HASH_MISMATCH"),
    `tampered packaged runner did not fail closed with a bounded reason code: ${tamperedDoctor.stdout}`,
  );
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contains(value, needle) {
  return typeof value === "string" && value.includes(needle);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
