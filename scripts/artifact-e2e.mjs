import { execFileSync, spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
  stdio: "pipe",
});
if (extraction.status !== 0) {
  throw new Error(`Unable to extract the artifact: ${extraction.stderr.toString("utf8")}`);
}

const manifest = JSON.parse(await readFile(join(bundleDirectory, "manifest.json"), "utf8"));
const binPath = join(bundleDirectory, "bin", "caelush");
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
  CAELUSH_DEFAULT_PROVIDER: "openai-compatible",
  CAELUSH_DEFAULT_MODEL: "fixture-model",
};
delete environment.CAELUSH_DAEMON_URL;

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
  const llmModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "llm", "dist", "index.js"),
  ).href;
  const toolsModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "tools", "dist", "index.js"),
  ).href;
  const packagedAdapterProbe = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const llm = await import(${JSON.stringify(llmModule)}); const tools = await import(${JSON.stringify(toolsModule)}); const registry = new llm.LLMProviderRegistry(); registry.register(llm.createOpenAICompatibleLLMProvider({ id: "openai-compatible", baseURL: process.env.CAELUSH_PROVIDER_BASE_URL, apiKey: process.env.CAELUSH_PROVIDER_API_KEY })); const definitions = tools.createDefaultBuiltinToolRegistrations({ resolve: async () => { throw new Error("not used"); } }).map((item) => item.definition); const result = await new llm.LLMGateway({ providers: registry }).complete({ model: { provider: "openai-compatible", model: "fixture-model" }, messages: [{ role: "user", content: "packaged child probe" }], tools: definitions, toolChoice: { type: "AUTO" } }); if (result.text !== "artifact smoke complete") process.exit(1);`,
    ],
    { cwd: bundleDirectory, env: environment },
  );
  assert(
    packagedAdapterProbe.exitCode === 0,
    `packaged OpenAI-compatible child probe failed: ${packagedAdapterProbe.stderr}`,
  );
  const llm = await import(llmModule);
  const llmProviders = new llm.LLMProviderRegistry();
  llmProviders.register(
    llm.createOpenAICompatibleLLMProvider({
      id: "openai-compatible",
      baseURL: provider.url,
      apiKey: secret,
    }),
  );
  const directResult = await new llm.LLMGateway({ providers: llmProviders }).complete({
    model: { provider: "openai-compatible", model: "fixture-model" },
    messages: [{ role: "user", content: "direct provider probe" }],
  });
  assert(
    directResult.text === "artifact smoke complete",
    "packaged OpenAI-compatible adapter probe failed",
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

  const initialDaemonCount = await countArtifactDaemons(bundleDirectory);
  const single = await runLauncher(binPath, ["-p", "Reply exactly PACKAGE_OK"], {
    cwd: workspaceDirectory,
    env: environment,
  });
  assert(
    single.exitCode === 0,
    `single-command artifact E2E failed: stdout=${single.stdout}; stderr=${single.stderr}`,
  );
  assert(single.stdout.trim() === "PACKAGE_OK", "single-command output was not exact");
  const reusedDaemonCount = await countArtifactDaemons(bundleDirectory);
  assert(reusedDaemonCount === initialDaemonCount + 1, "single-command did not start one daemon");

  const reused = await runLauncher(binPath, ["-p", "Reply exactly REUSE_OK"], {
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
  const piped = await runLauncher(binPath, ["-p"], {
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
  const remembered = await runLauncher(binPath, ["-p", "Remember marker PACKAGED-ORANGE-912"], {
    cwd: continueWorkspace,
    env: continueEnvironment,
  });
  assert(remembered.exitCode === 0, `packaged Session seed failed: ${remembered.stderr}`);
  const continued = await runLauncher(binPath, ["-c", "-p", "What marker did I mention?"], {
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
    runLauncher(binPath, ["-p", "read fixture file", "--output-format", "json"], {
      cwd: parallelWorkspaceA,
      env: { ...environment, CAELUSH_HOME: parallelHome },
    }),
    runLauncher(binPath, ["-p", "read fixture file again", "--output-format", "json"], {
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
  const patchRequest = await runLauncher(
    binPath,
    ["-p", "patch fixture", "--output-format", "json"],
    { cwd: patchWorkspace, env: patchEnvironment },
  );
  assert(patchRequest.exitCode === 5, "protected file mutation did not stop at approval");
  const patchResult = JSON.parse(patchRequest.stdout);
  assert(patchResult.requiresApproval === true, "approval result did not identify the boundary");
  assert(typeof patchResult.runId === "string", "approval result did not expose a safe run id");
  const clientModule = pathToFileURL(
    join(bundleDirectory, "node_modules", "@caelush", "client", "dist", "index.js"),
  ).href;
  const packagedClient = await import(clientModule);
  const patchClient = new packagedClient.CaelushClient({
    baseUrl: "http://127.0.0.1:43120",
  });
  const pendingApproval = await waitForPendingApproval(patchClient, patchResult.runId);
  await patchClient.resolveApproval(patchResult.runId, pendingApproval.id, {
    action: "APPROVE",
    scope: "ONCE",
  });
  const patchedRun = await waitForTerminalRun(patchClient, patchResult.runId);
  assert(patchedRun.status === "COMPLETED", "approved artifact patch did not complete");
  assert(
    (await readFile(join(patchWorkspace, "fixture.txt"), "utf8")) === "after patch\n",
    "approved artifact patch did not mutate the workspace",
  );

  const stream = await runLauncher(
    binPath,
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
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const body = await readRequestBody(request);
    const payload = JSON.parse(body);
    Object.assign(requestRecord, payload);
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
    'const result = await scope.exec.execute({ ownerRunId: createRunId(), command: "echo artifact-pty", tty: true, yieldTimeMs: 2000 });',
    'if (result.status !== "EXITED" || !result.output.includes("artifact-pty")) process.exit(1);',
    "process.exit(0);",
  ].join("\n");
  const result = await run(process.execPath, ["--input-type=module", "-e", source], {
    cwd: workspace,
    env: process.env,
  });
  assert(result.exitCode === 0, "packaged PTY smoke failed.");
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
    try {
      return Number.parseInt(
        execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
          encoding: "utf8",
        }).trim(),
        10,
      );
    } catch {
      return 0;
    }
  }
  try {
    const processes = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });
    return processes.split("\n").filter((line) => line.includes(needle)).length;
  } catch {
    return 0;
  }
}

async function waitForPendingApproval(client, runId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await client.listPendingApprovals(runId);
    const approval = response.items[0];
    if (approval !== undefined) return approval;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Timed out waiting for packaged approval.");
}

async function waitForTerminalRun(client, runId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = await client.getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "BUDGET_EXCEEDED"].includes(run.status))
      return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Timed out waiting for packaged run settlement.");
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

function contains(value, needle) {
  return typeof value === "string" && value.includes(needle);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
