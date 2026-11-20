import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CaelushClient, isTerminalRunStatus } from "@caelush/client";
import type { AIProviderBinding, ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import {
  createWorkspaceId,
  RunWorkflowExecutionProfileV1Schema,
  SubmissionIdSchema,
  type RunId,
  type SelectablePermissionPresetId,
} from "@caelush/protocol";
import { createInjectedReplayKeyProvider, createReplayProtection } from "@caelush/security";
import { openCaelushStorage, type CaelushStorage, type RunRepository } from "@caelush/storage";
import { composeDaemon, type DaemonComposition } from "../../src/daemon-composition.js";
import { startDaemon, type DaemonHandle } from "../../src/daemon.js";
import { createFilesystemSkillProvider } from "../../src/skills/filesystem-provider.js";
import { restrictedProvider } from "./permission-flow-fixture.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  sendOpenAIText,
  writeOpenAIChunk,
  type ControllableProviderServer,
} from "./controllable-provider-server.js";

const ACCEPTANCE_PROVIDER_ID = "phase08-local-fixture";
const ACCEPTANCE_MODEL_ID = "phase08-deterministic-model";
const OPENAI_COMPATIBLE_API = "openai-compatible-chat";

export type SkillAcceptanceFaultPoint =
  | "RUN_BEFORE_COMMIT"
  | "TOOL_BEFORE_COMMIT"
  | "STEP_BEFORE_COMMIT"
  | "AFTER_COMMIT_BEFORE_NOTIFY"
  | "PROVIDER_STARTED";

export type SkillAcceptanceProfile = "OFF" | "EMPTY_SKILLS" | "DISCOVERABLE_SKILL" | "ONE_SKILL";

export interface StartSkillAcceptanceScenarioInput {
  readonly caseId: string;
  readonly faultPoint?: SkillAcceptanceFaultPoint;
  readonly policy: SelectablePermissionPresetId;
  readonly profile: SkillAcceptanceProfile;
}

export interface SkillAcceptanceRequestEvidence {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface SkillAcceptanceDurableFacts {
  readonly runCount: number;
  readonly bindingCount: number;
  readonly receiptCount: number;
  readonly stepCount: number;
  readonly toolInvocationCount: number;
  readonly invocationStatuses: readonly string[];
  readonly observationCount: number;
  readonly eventSequences: readonly number[];
  readonly eventTypes: readonly string[];
}

export interface ScenarioHandle {
  readonly rootDirectory: string;
  readonly databasePath: string;
  readonly sessionId: string;
  readonly workspace: { readonly id: string; readonly path: string };
  readonly skillId: string | undefined;
  createRun(options?: { readonly withSkill?: boolean }): ReturnType<CaelushClient["createRun"]>;
  getRun(runId: RunId): ReturnType<CaelushClient["getRun"]>;
  startRun(runId: RunId): Promise<void>;
  waitForRun(runId: RunId): ReturnType<CaelushClient["getRun"]>;
  inspect(): Promise<{
    readonly runCount: number;
    readonly bindingCount: number;
    readonly receiptCount: number;
    readonly providerCalls: number;
    readonly scriptLaunches: number;
  }>;
  readRunIds(): Promise<readonly RunId[]>;
  readWorkflowProfile(
    runId: RunId,
  ): Promise<import("@caelush/protocol").RunWorkflowExecutionProfileV1 | null>;
  inspectDurableFacts(runId: RunId): Promise<SkillAcceptanceDurableFacts>;
  requestEvidence(): readonly SkillAcceptanceRequestEvidence[];
  providerToolNames(): readonly (readonly string[])[];
  requestContainsText(text: string): boolean;
  readReplayFirstEvent(
    runId: RunId,
  ): Promise<{ readonly sequence: number | null; readonly type: string } | null>;
  waitForProviderStarted(): Promise<void>;
  restart(): Promise<void>;
  setSkillFeatureEnabled(enabled: boolean): Promise<void>;
  replaceSkillBody(body: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Runs one isolated scenario through the production daemon, real HTTP client, SQLite store,
 * filesystem Skill catalog, and the local OpenAI-compatible Provider adapter.
 * The loopback Provider is a deterministic test fixture; it never makes Internet requests.
 */
export async function startSkillAcceptanceScenario(
  input: StartSkillAcceptanceScenarioInput,
): Promise<ScenarioHandle> {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), `caelush-phase08-${input.caseId.toLowerCase()}-`),
  );
  const databasePath = join(rootDirectory, "caelush.db");
  const skillIdDirectory = join(rootDirectory, "skills", "phase08-fixture");
  if (input.profile === "ONE_SKILL" || input.profile === "DISCOVERABLE_SKILL") {
    await mkdir(skillIdDirectory, { recursive: true });
    await writeSkillManifest(skillIdDirectory);
  } else {
    await mkdir(join(rootDirectory, "skills"), { recursive: true });
  }

  let providerStartedResolve: (() => void) | undefined;
  let providerStartedSettled = false;
  const providerStarted = new Promise<void>((resolve) => {
    providerStartedResolve = resolve;
  });
  let scenarioSkillId: string | undefined;
  let injectedToolCallSent = false;
  const provider: ControllableProviderServer = await createControllableProviderServer(
    async (_request, response) => {
      if (input.faultPoint === "PROVIDER_STARTED") {
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        response.flushHeaders();
        providerStartedSettled = true;
        providerStartedResolve?.();
        await new Promise<void>((resolve) => response.once("close", resolve));
        return;
      }
      if (input.faultPoint === "TOOL_BEFORE_COMMIT" && !injectedToolCallSent) {
        if (scenarioSkillId === undefined) {
          throw new Error("The Phase 08 Tool fault scenario has no discoverable Skill.");
        }
        injectedToolCallSent = true;
        beginOpenAISse(response);
        writeOpenAIChunk(response, {
          model: ACCEPTANCE_MODEL_ID,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "phase08-read-skill",
                type: "function",
                function: {
                  name: "read_skill",
                  arguments: JSON.stringify({ skillId: scenarioSkillId }),
                },
              },
            ],
          },
          finishReason: "tool_calls",
        });
        response.end("data: [DONE]\n\n");
        return;
      }
      sendOpenAIText(response, "The deterministic local Provider fixture completed this turn.");
    },
  );

  const providerBinding: AIProviderBinding = {
    id: ACCEPTANCE_PROVIDER_ID,
    endpoint: `${provider.endpoint}/v1`,
    defaultApi: OPENAI_COMPATIBLE_API,
    allowUnknownModels: true,
    credentials: { resolve: async () => ({ apiKey: "phase08-fixture-only" }) },
    rateLimitDomain: "phase08-local-fixture",
  };
  const modelSource: ModelDescriptorSourcePort = {
    id: "phase08-local-fixture",
    priority: 0,
    resolve: ({ provider: providerId, model }) =>
      providerId === ACCEPTANCE_PROVIDER_ID && model === ACCEPTANCE_MODEL_ID
        ? acceptanceModelDescriptor()
        : undefined,
  };
  const options = {
    databasePath,
    port: 0,
    shutdownTimeoutMs: 1_000,
    workspacePath: rootDirectory,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [providerBinding],
    modelSources: [modelSource],
    defaultModel: { provider: ACCEPTANCE_PROVIDER_ID, model: ACCEPTANCE_MODEL_ID },
    processSandboxProviders: [restrictedProvider],
    fullAccessAvailable: true,
    ...(input.faultPoint === "AFTER_COMMIT_BEFORE_NOTIFY"
      ? { faultPoint: "AFTER_COMMIT_BEFORE_NOTIFY" as const }
      : {}),
  } as const;

  let skillFeatureEnabled = input.profile !== "OFF";
  let daemon: DaemonHandle | undefined;
  let daemonProcess: ChildProcessWithoutNullStreams | undefined;
  let client: CaelushClient | undefined;
  const openDaemon = async () => {
    if (input.faultPoint === "PROVIDER_STARTED") {
      const started = await startAcceptanceDaemonProcess({
        databasePath,
        providerEndpoint: provider.endpoint,
        workspacePath: rootDirectory,
        skillsEnabled: skillFeatureEnabled,
      });
      daemonProcess = started.process;
      client = new CaelushClient({ baseUrl: started.url });
      return;
    }
    daemon = await startDaemon({
      ...options,
      environment: { CAELUSH_FEATURE_SKILLS_V1: skillFeatureEnabled ? "1" : "0" },
    });
    client = new CaelushClient({ baseUrl: daemon.url });
  };

  try {
    await openDaemon();
    if (input.faultPoint !== undefined) installScenarioFault(databasePath, input.faultPoint);
    const createdSession = await client!.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: rootDirectory },
      defaultModel: { provider: ACCEPTANCE_PROVIDER_ID, model: ACCEPTANCE_MODEL_ID },
    });
    const workspace = createdSession.defaultWorkspace;
    if (workspace === undefined) throw new Error("Phase 08 scenario Workspace was not registered.");
    const discoveredSkill =
      input.profile === "ONE_SKILL" || input.profile === "DISCOVERABLE_SKILL"
        ? (await client!.listSkills(workspace.id, { q: "phase08-fixture" })).items[0]
        : undefined;
    if (
      (input.profile === "ONE_SKILL" || input.profile === "DISCOVERABLE_SKILL") &&
      discoveredSkill === undefined
    ) {
      throw new Error("Phase 08 scenario Skill fixture was not discovered.");
    }
    scenarioSkillId = discoveredSkill?.skillId;
    const selectedSkill = input.profile === "ONE_SKILL" ? discoveredSkill : undefined;

    let disposed = false;
    return {
      rootDirectory,
      databasePath,
      sessionId: createdSession.id,
      workspace,
      skillId: selectedSkill?.skillId,
      async createRun(runOptions = {}) {
        const currentClient = requireClient(client);
        const includeSkill = runOptions.withSkill ?? selectedSkill !== undefined;
        if (includeSkill && selectedSkill === undefined) {
          throw new Error("This Phase 08 scenario has no selectable Skill.");
        }
        return currentClient.createRun(createdSession.id, {
          goal: `Phase 08 ${input.caseId} deterministic acceptance scenario`,
          submissionId: SubmissionIdSchema.parse(randomUUID()),
          ...(!includeSkill || selectedSkill === undefined
            ? {}
            : {
                skillSelections: [
                  { skillId: selectedSkill.skillId, selectionToken: selectedSkill.selectionToken },
                ],
              }),
          workspace,
          model: { provider: ACCEPTANCE_PROVIDER_ID, model: ACCEPTANCE_MODEL_ID },
          runtime: { id: "local", kind: "local" },
          preset: { id: input.policy, expectedVersion: 1 },
          limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 20_000 },
        });
      },
      async startRun(runId) {
        await requireClient(client).startRun(runId);
      },
      async getRun(runId) {
        return requireClient(client).getRun(runId);
      },
      async waitForRun(runId) {
        const activeClient = requireClient(client);
        let run = await activeClient.getRun(runId);
        for (let attempt = 0; attempt < 400 && !isTerminalRunStatus(run.status); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          run = await activeClient.getRun(runId);
        }
        return run;
      },
      async inspect() {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return {
            runCount: count(database, "SELECT COUNT(*) AS count FROM agent_runs"),
            bindingCount: count(database, "SELECT COUNT(*) AS count FROM run_prepared_resources"),
            receiptCount: count(
              database,
              "SELECT COUNT(*) AS count FROM prepared_input_resource_receipts",
            ),
            providerCalls: provider.requests.length,
            scriptLaunches: 0,
          };
        } finally {
          database.close();
        }
      },
      async readRunIds() {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return database
            .prepare("SELECT id FROM agent_runs ORDER BY created_at_ms, id")
            .all()
            .map((row) => (row as { id: RunId }).id);
        } finally {
          database.close();
        }
      },
      async readWorkflowProfile(runId) {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const row = database
            .prepare("SELECT data_json FROM run_workflow_profiles WHERE run_id = ?")
            .get(runId) as { data_json: string } | undefined;
          return row === undefined
            ? null
            : RunWorkflowExecutionProfileV1Schema.parse(JSON.parse(row.data_json));
        } finally {
          database.close();
        }
      },
      async inspectDurableFacts(runId) {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return {
            runCount: count(
              database,
              "SELECT COUNT(*) AS count FROM agent_runs WHERE id = ?",
              runId,
            ),
            bindingCount: count(
              database,
              "SELECT COUNT(*) AS count FROM run_prepared_resources WHERE run_id = ?",
              runId,
            ),
            receiptCount: count(
              database,
              "SELECT COUNT(*) AS count FROM prepared_input_resource_receipts WHERE run_id = ?",
              runId,
            ),
            stepCount: count(
              database,
              "SELECT COUNT(*) AS count FROM agent_steps WHERE run_id = ?",
              runId,
            ),
            toolInvocationCount: count(
              database,
              "SELECT COUNT(*) AS count FROM tool_invocations WHERE run_id = ?",
              runId,
            ),
            invocationStatuses: database
              .prepare(
                "SELECT status FROM tool_invocations WHERE run_id = ? ORDER BY created_at_ms, id",
              )
              .all(runId)
              .map((row) => String((row as { status: string }).status)),
            observationCount: count(
              database,
              "SELECT COUNT(*) AS count FROM agent_observations WHERE run_id = ?",
              runId,
            ),
            eventSequences: database
              .prepare(
                "SELECT aggregate_sequence FROM agent_events WHERE run_id = ? ORDER BY aggregate_sequence",
              )
              .all(runId)
              .map((row) => Number((row as { aggregate_sequence: number }).aggregate_sequence)),
            eventTypes: database
              .prepare(
                "SELECT event_type FROM agent_events WHERE run_id = ? ORDER BY aggregate_sequence",
              )
              .all(runId)
              .map((row) => String((row as { event_type: string }).event_type)),
          };
        } finally {
          database.close();
        }
      },
      requestEvidence() {
        return provider.requests.map(({ rawBodySha256, rawBodyByteLength }) => ({
          sha256: rawBodySha256,
          byteLength: rawBodyByteLength,
        }));
      },
      providerToolNames() {
        return provider.requests.map((request) => {
          const tools = request.body["tools"];
          if (!Array.isArray(tools)) return [];
          return tools.flatMap((tool) => {
            if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return [];
            const fn = (tool as Record<string, unknown>)["function"];
            if (typeof fn !== "object" || fn === null || Array.isArray(fn)) return [];
            const name = (fn as Record<string, unknown>)["name"];
            return typeof name === "string" ? [name] : [];
          });
        });
      },
      requestContainsText(text) {
        return provider.requests.some((request) => {
          const messages = request.body["messages"];
          return Array.isArray(messages) && JSON.stringify(messages).includes(text);
        });
      },
      async readReplayFirstEvent(runId) {
        const controller = new AbortController();
        const eventStream = requireClient(client).watchRunEvents(runId, {
          afterSequence: 0,
          signal: controller.signal,
        });
        const iterator = eventStream[Symbol.asyncIterator]();
        try {
          const result = await iterator.next();
          if (result.done) return null;
          return {
            sequence:
              result.value.durability.kind === "DURABLE" ? result.value.durability.sequence : null,
            type: result.value.type,
          };
        } finally {
          controller.abort();
          await iterator.return?.();
        }
      },
      async waitForProviderStarted() {
        if (!providerStartedSettled) await providerStarted;
      },
      async restart() {
        if (daemonProcess !== undefined) {
          await stopAcceptanceDaemonProcess(daemonProcess, "SIGKILL");
          daemonProcess = undefined;
          client = undefined;
          await openDaemon();
          return;
        }
        await daemon?.close();
        daemon = undefined;
        client = undefined;
        await openDaemon();
      },
      async setSkillFeatureEnabled(enabled) {
        await daemon?.close();
        daemon = undefined;
        if (daemonProcess !== undefined) {
          await stopAcceptanceDaemonProcess(daemonProcess, "SIGKILL");
          daemonProcess = undefined;
        }
        client = undefined;
        skillFeatureEnabled = enabled;
        await openDaemon();
      },
      async replaceSkillBody(body) {
        if (scenarioSkillId === undefined) {
          throw new Error("This Phase 08 scenario has no Skill source to replace.");
        }
        await writeSkillManifest(skillIdDirectory, body);
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await daemon?.close().catch(() => undefined);
        if (daemonProcess !== undefined) {
          await stopAcceptanceDaemonProcess(daemonProcess, "SIGKILL");
          daemonProcess = undefined;
        }
        await provider.close().catch(() => undefined);
        await rm(rootDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await daemon?.close().catch(() => undefined);
    if (daemonProcess !== undefined) {
      await stopAcceptanceDaemonProcess(daemonProcess, "SIGKILL");
    }
    await provider.close().catch(() => undefined);
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function startAcceptanceDaemonProcess(input: {
  readonly databasePath: string;
  readonly providerEndpoint: string;
  readonly workspacePath: string;
  readonly skillsEnabled: boolean;
}): Promise<{ readonly process: ChildProcessWithoutNullStreams; readonly url: string }> {
  const daemonModuleUrl = pathToFileURL(
    join(process.cwd(), "apps", "daemon", "dist", "daemon.js"),
  ).href;
  const childSource = `
    import { startDaemon } from ${JSON.stringify(daemonModuleUrl)};
    const providerId = ${JSON.stringify(ACCEPTANCE_PROVIDER_ID)};
    const modelId = ${JSON.stringify(ACCEPTANCE_MODEL_ID)};
    const daemon = await startDaemon({
      databasePath: process.env.CAELUSH_PHASE08_DATABASE_PATH,
      port: 0,
      shutdownTimeoutMs: 1000,
      workspacePath: process.env.CAELUSH_PHASE08_WORKSPACE_PATH,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [{
        id: providerId,
        endpoint: process.env.CAELUSH_PHASE08_PROVIDER_ENDPOINT + "/v1",
        defaultApi: ${JSON.stringify(OPENAI_COMPATIBLE_API)},
        allowUnknownModels: true,
        credentials: { resolve: async () => ({ apiKey: "phase08-fixture-only" }) },
        rateLimitDomain: providerId,
      }],
      modelSources: [{
        id: providerId,
        priority: 0,
        resolve: ({ provider, model }) => provider === providerId && model === modelId
          ? {
              ref: { provider: providerId, model: modelId },
              api: ${JSON.stringify(OPENAI_COMPATIBLE_API)},
              limits: { contextWindowTokens: 128000, maxOutputTokens: 8192 },
              capabilities: {
                streaming: "SUPPORTED",
                toolCalling: "SUPPORTED",
                parallelToolCalls: "SUPPORTED",
                structuredOutput: "UNKNOWN",
                vision: "UNSUPPORTED",
                reasoning: "UNKNOWN",
                reasoningSummary: "UNKNOWN",
                promptCaching: "UNKNOWN",
                usageReporting: "UNKNOWN",
              },
              source: "CONFIGURATION",
            }
          : undefined,
      }],
      defaultModel: { provider: providerId, model: modelId },
      processSandboxProviders: [{
        id: "phase08-test-permission-capability",
        kind: "RESTRICTED",
        enforcement: "HARD",
        probe: async () => ({ available: true, enforcement: "HARD" }),
        create: async () => ({}),
      }],
      fullAccessAvailable: true,
      environment: {
        ...process.env,
        CAELUSH_FEATURE_SKILLS_V1: process.env.CAELUSH_PHASE08_SKILLS_ENABLED,
      },
    });
    process.stdout.write("PHASE08_READY " + daemon.url + "\\n");
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CAELUSH_PHASE08_DATABASE_PATH: input.databasePath,
      CAELUSH_PHASE08_PROVIDER_ENDPOINT: input.providerEndpoint,
      CAELUSH_PHASE08_WORKSPACE_PATH: input.workspacePath,
      CAELUSH_PHASE08_SKILLS_ENABLED: input.skillsEnabled ? "1" : "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Phase 08 daemon subprocess did not become ready."));
      }, 15_000);
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error !== undefined) reject(error);
        else if (value !== undefined) resolve(value);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
        const readyLine = output.split(/\r?\n/u).find((line) => line.startsWith("PHASE08_READY "));
        if (readyLine !== undefined) finish(undefined, readyLine.slice("PHASE08_READY ".length));
      });
      child.once("error", (error) =>
        finish(new Error(`Phase 08 daemon subprocess failed: ${error.name}.`)),
      );
      child.once("exit", () =>
        finish(new Error("Phase 08 daemon subprocess exited before readiness.")),
      );
    });
    return { process: child, url };
  } catch (error) {
    await stopAcceptanceDaemonProcess(child, "SIGKILL");
    throw error;
  }
}

async function stopAcceptanceDaemonProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill(signal);
  });
}

function acceptanceModelDescriptor(): ModelDescriptor {
  return {
    ref: { provider: ACCEPTANCE_PROVIDER_ID, model: ACCEPTANCE_MODEL_ID },
    api: OPENAI_COMPATIBLE_API,
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    source: "CONFIGURATION",
  };
}

function installScenarioFault(databasePath: string, faultPoint: SkillAcceptanceFaultPoint): void {
  if (faultPoint === "PROVIDER_STARTED" || faultPoint === "AFTER_COMMIT_BEFORE_NOTIFY") return;
  const database = new DatabaseSync(databasePath);
  try {
    if (faultPoint === "STEP_BEFORE_COMMIT") {
      database.exec(
        "CREATE TRIGGER phase08_step_before_commit " +
          "BEFORE INSERT ON prepared_input_resource_receipts " +
          "BEGIN SELECT RAISE(ABORT, 'phase08 STEP_BEFORE_COMMIT'); END",
      );
      return;
    }
    const triggerName =
      faultPoint === "RUN_BEFORE_COMMIT"
        ? "phase08_run_before_commit"
        : "phase08_tool_before_commit";
    database.exec(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON run_prepared_resources ` +
        `BEGIN SELECT RAISE(ABORT, 'phase08 ${faultPoint}'); END`,
    );
  } finally {
    database.close();
  }
}

function count(database: DatabaseSync, sql: string, ...parameters: string[]): number {
  const row = database.prepare(sql).get(...parameters) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function requireClient(client: CaelushClient | undefined): CaelushClient {
  if (client === undefined) throw new Error("Phase 08 scenario daemon is not running.");
  return client;
}

async function writeSkillManifest(
  directory: string,
  body = "PHASE08_FROZEN_PRIVATE_GUIDANCE_MARKER",
): Promise<void> {
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: phase08-fixture\ndescription: Deterministic Phase 08 acceptance fixture.\n---\n${body}\n`,
    "utf8",
  );
}

export type MissingSkillStorageCapability =
  | "insertRunWithPreparedResources"
  | "readPreparedResources"
  | "readPreparedInputReceipts"
  | "readWorkflowProfile"
  | "isWorkflowArtifactReferenced";

export interface SkillCompositionFixtureOptions {
  readonly artifactStoreAvailable?: boolean;
  readonly missingRunCapability?: MissingSkillStorageCapability;
}

export interface SkillCompositionFixture {
  readonly rootDirectory: string;
  readonly workspacePath: string;
  readonly userSkillRoot: string;
  readonly storage: CaelushStorage;
  readonly composition: DaemonComposition;
  dispose(): Promise<void>;
}

/**
 * Compose the production daemon against isolated SQLite and Skill directories.
 * Optional missing-capability cases remove one real public Storage port after opening it, so
 * readiness tests exercise composition-derived capability detection rather than a made-up
 * capability response.
 */
export async function createSkillCompositionFixture(
  options: SkillCompositionFixtureOptions = {},
): Promise<SkillCompositionFixture> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "caelush-skills-acceptance-"));
  const workspacePath = join(rootDirectory, "workspace");
  const userSkillRoot = join(rootDirectory, "user-skills");
  const artifactRoot = join(rootDirectory, "skill-artifacts");
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(userSkillRoot, { recursive: true }),
  ]);

  let storage: CaelushStorage | undefined;
  let composition: DaemonComposition | undefined;
  try {
    storage = await openCaelushStorage({
      path: join(rootDirectory, "caelush.db"),
      replayProtection: createReplayProtection(
        createInjectedReplayKeyProvider("phase08-acceptance", Buffer.alloc(32, 0x48)),
      ),
    });
    const compositionStorage =
      options.missingRunCapability === undefined
        ? storage
        : omitRunCapability(storage, options.missingRunCapability);
    const skillProvider = createFilesystemSkillProvider({
      userRoot: userSkillRoot,
      resolveWorkspaceRoot: async () => workspacePath,
    });
    composition = await composeDaemon({
      storage: compositionStorage,
      skillProvider,
      ...(options.artifactStoreAvailable === false ? {} : { skillArtifactRoot: artifactRoot }),
      skillGlobalWatchRoots: [userSkillRoot],
      skillFeatureEnabled: true,
    });

    let disposed = false;
    return {
      rootDirectory,
      workspacePath,
      userSkillRoot,
      storage,
      composition,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await composition?.dispose().catch(() => undefined);
        await storage?.close().catch(() => undefined);
        await rm(rootDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await composition?.dispose().catch(() => undefined);
    await storage?.close().catch(() => undefined);
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

function omitRunCapability(
  storage: CaelushStorage,
  capability: MissingSkillStorageCapability,
): CaelushStorage {
  const runs = new Proxy(storage.runs, {
    get(target, property) {
      if (property === capability) return undefined;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as RunRepository;
  return new Proxy(storage, {
    get(target, property) {
      if (property === "runs") return runs;
      return Reflect.get(target, property, target) as unknown;
    },
  });
}
