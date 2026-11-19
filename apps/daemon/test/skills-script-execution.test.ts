import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import { createRunId, type ApprovalResolution } from "@caelush/protocol";
import { createDefaultCodingTools, createRuntimeProcessOperations } from "@caelush/coding-agent";
import type { SkillScriptEvaluationContext } from "@caelush/coding-agent";
import { createInjectedReplayKeyProvider, createReplayProtection } from "@caelush/security";
import {
  createLocalRuntimeResolver,
  createAuthorizedRuntimeExecution,
  createRuntimeProcessPolicy,
  LocalRuntime,
  type ManagedProcessAdapter,
  type ProcessExit,
  type ProcessOutputEvent,
  type ProcessSandboxProvider,
  type SandboxedSpawnSpec,
} from "@caelush/runtime";
import { openToolStorage } from "../../../packages/storage/test/support/tool-settlement-decoder.js";
import { makeRun, makeSession } from "../../../packages/storage/test/support/fixtures.js";
import { createFilesystemSkillBundleStore } from "../src/skills/bundle-store.js";
import { createSkillCatalogService } from "../src/skills/catalog-service.js";
import { createFilesystemSkillProvider } from "../src/skills/filesystem-provider.js";
import { createRunSkillCatalogSnapshotService } from "../src/skills/run-catalog-snapshot.js";
import { createRunSkillModelCatalogService } from "../src/skills/run-skill-search.js";
import { createRunSkillOperationsAdapter } from "../src/skills/skill-operations-adapter.js";
import { createRunSkillScriptOperations } from "../src/skills/skill-script-operations.js";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";
import { SessionTranscriptService } from "../src/services/session-transcript-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  writeOpenAIChunk,
} from "./support/controllable-provider-server.js";
import type { ControllableProviderServer } from "./support/controllable-provider-server.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("frozen Skill script execution resources", () => {
  it("resolves only a verified immutable bundle file after the source script changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-script-frozen-"));
    directories.push(directory);
    const workspaceRoot = join(directory, "workspace");
    const userRoot = join(directory, "user-skills");
    const skillRoot = join(userRoot, "sample-skill");
    const scriptPath = join(skillRoot, "scripts", "check.mjs");
    await mkdir(join(skillRoot, "scripts"), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: sample-skill\ndescription: Run a frozen validation script.\n---\nUse the validation script.",
      "utf8",
    );
    await writeFile(scriptPath, "console.log('FROZEN_SCRIPT_V1')\n", "utf8");

    const provider = createFilesystemSkillProvider({
      userRoot,
      resolveWorkspaceRoot: async () => workspaceRoot,
    });
    const discovered = await provider.discover({
      workspaceId: "workspace_script_frozen",
      signal: new AbortController().signal,
    });
    const candidate = discovered.candidates.find(
      ({ manifest }) => manifest.name === "sample-skill",
    );
    if (candidate === undefined) throw new Error("The script fixture was not discovered.");
    const locator = await provider.resolveLocator(
      candidate.privateLocator,
      "workspace_script_frozen",
    );
    if (locator === null) throw new Error("The script fixture locator was not available.");

    const bundles = createFilesystemSkillBundleStore({
      rootDirectory: join(directory, "artifact-store"),
      resolveSource: async (skillId) =>
        skillId !== candidate.skillId
          ? null
          : {
              candidate,
              scopeId: candidate.providerId,
              rootDirectory: locator.rootDirectory,
              packageDirectory: locator.packageDirectory,
            },
    });
    const bundle = await bundles.captureCandidate({
      candidate,
      workspaceId: "workspace_script_frozen",
      signal: new AbortController().signal,
    });
    const frozen = await bundles.resolveExecutionResource({
      bundle,
      relativePath: "scripts/check.mjs",
      signal: new AbortController().signal,
    });

    await writeFile(scriptPath, "console.log('CHANGED_SOURCE_V2')\n", "utf8");
    expect(frozen.bundleRevision).toBe(bundle.bundleRevision);
    expect(frozen.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(relative(frozen.rootDirectory, frozen.absolutePath).split(sep).join("/")).toBe(
      "scripts/check.mjs",
    );
    await expect(readFile(frozen.absolutePath, "utf8")).resolves.toBe(
      "console.log('FROZEN_SCRIPT_V1')\n",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "executes a prepared script through the real Run Tool path with frozen bytes, typed argv, and safe feedback",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "caelush-script-dispatch-"));
      directories.push(directory);
      const workspaceRoot = join(directory, "workspace");
      const userRoot = join(directory, "user-skills");
      const builtinRoot = join(directory, "builtin-skills");
      const artifactRoot = join(directory, "skill-artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      const skillSources = [
        {
          name: "sample-skill",
          root: join(userRoot, "sample-skill"),
          frozenSource: "console.log('FROZEN_USER_SCRIPT_V1')\n",
        },
        {
          name: "project-skill",
          root: join(workspaceRoot, ".agents", "skills", "project-skill"),
          frozenSource: "console.log('FROZEN_PROJECT_SCRIPT_V1')\n",
        },
        {
          name: "builtin-skill",
          root: join(builtinRoot, "builtin-skill"),
          frozenSource: "console.log('FROZEN_BUILTIN_SCRIPT_V1')\n",
        },
      ] as const;
      for (const source of skillSources) {
        await mkdir(join(source.root, "scripts"), { recursive: true });
        await writeFile(
          join(source.root, "SKILL.md"),
          [
            "---",
            `name: ${source.name}`,
            "description: Run a frozen validation script.",
            "metadata:",
            "  caelush.scriptRuntime: node",
            "  searchTerms: validation script",
            "---",
            `Use the frozen ${source.name} validation script for this task.`,
            "",
          ].join("\n"),
          "utf8",
        );
        await writeFile(join(source.root, "scripts", "check.mjs"), source.frozenSource, "utf8");
      }

      const skillProvider = createFilesystemSkillProvider({
        userRoot,
        builtinRoots: [builtinRoot],
        resolveWorkspaceRoot: async () => workspaceRoot,
      });
      const workspaceServiceStorage = await openToolStorage({
        path: join(directory, "caelush.db"),
        replayProtection: createReplayProtection(
          createInjectedReplayKeyProvider("phase06-script-fixture-key", Buffer.alloc(32, 0x61)),
        ),
      });
      const storage = workspaceServiceStorage;
      let composition: DaemonComposition | undefined;
      let controlledProvider: ControlledProvider | undefined;
      let runtime: LocalRuntime | undefined;
      try {
        const workspaceService = new WorkspaceService({ repository: storage.workspaces });
        const workspace = await workspaceService.registerWorkspace({ path: workspaceRoot });
        const workspaceRef = {
          id: workspace.workspace.id,
          path: workspace.workspace.canonicalPath,
        };
        const catalog = createSkillCatalogService({
          provider: skillProvider,
          settings: storage.skillSettings,
        });
        const bundles = createFilesystemSkillBundleStore({
          rootDirectory: join(artifactRoot, "bundles"),
          resolveSource: async () => null,
        });
        const snapshots = createRunSkillCatalogSnapshotService({
          rootDirectory: join(artifactRoot, "run-catalogs"),
          catalog,
          bundleStore: bundles,
        });
        const modelCatalog = createRunSkillModelCatalogService({
          runs: storage.runs,
          snapshots,
        });
        const processObservations: Array<{
          readonly spec: SandboxedSpawnSpec;
          readonly scriptSource: string;
        }> = [];
        const additionalProcessObservations: Array<{
          readonly spec: SandboxedSpawnSpec;
          readonly scriptSource: string;
        }> = [];
        const scriptArgs = ["; touch PWNED_MARKER", "two words", "$(Write-Output injected)"];
        let lastScriptContext: SkillScriptEvaluationContext | undefined;
        let selectedBindings: readonly {
          readonly bindingId: string;
          readonly resourceId: string;
        }[] = [];
        const additionalScriptExecutor: {
          run?: ((activeBindingId: string) => Promise<void>) | undefined;
        } = {};
        const sandboxProvider = createControlledSandboxProvider(async (spec) => {
          const scriptPath = spec.launch.args[0];
          if (scriptPath === undefined)
            throw new Error("The Runtime launch lacked its script path.");
          const scriptSource = await readFile(scriptPath, "utf8");
          processObservations.push({ spec, scriptSource });
          const activeBindingId = spec.readOnlyResourceGrant?.resourceId;
          if (activeBindingId === undefined)
            throw new Error("The script grant did not identify its binding.");
          await additionalScriptExecutor.run?.(activeBindingId);
          return [
            scriptSource,
            JSON.stringify(spec.launch.args.slice(1)),
            spec.readOnlyResourceGrant?.canonicalRoot ?? "NO_RESOURCE_GRANT",
            "API_KEY=sk-test-provider-secret-0123456789",
          ].join("\n");
        });
        runtime = new LocalRuntime();
        const runtimeResolver = createLocalRuntimeResolver(runtime);
        const scriptSecurity = new SecurityCapabilityService({
          processSandboxProviders: [sandboxProvider],
        });
        const scriptExecution = createRunSkillScriptOperations({
          runs: storage.runs,
          steps: storage.steps,
          snapshots,
          bundles,
          runtimeResolver,
          securityCapabilityService: scriptSecurity,
        });
        const additionalSandboxProvider = createPersistentControlledSandboxProvider(
          async (spec) => {
            const scriptPath = spec.launch.args[0];
            if (scriptPath === undefined)
              throw new Error("The Runtime launch lacked its script path.");
            const scriptSource = await readFile(scriptPath, "utf8");
            additionalProcessObservations.push({ spec, scriptSource });
            return scriptSource;
          },
        );
        const additionalSecurity = new SecurityCapabilityService({
          processSandboxProviders: [additionalSandboxProvider],
        });
        const processOperations = createRuntimeProcessOperations(runtimeResolver, {
          authorizationResolver: async ({ ownerRunId, environment, securityContext }) => {
            const reference = securityContext?.securityPolicy;
            if (reference === undefined) return undefined;
            const policy = createRuntimeProcessPolicy({
              runId: ownerRunId,
              workspaceId: environment.workspace.id,
              workspaceRoot: environment.workspace.path,
              filesystemBoundary: reference.filesystemBoundary,
              processBoundary: reference.processBoundary,
              requiredEnforcement: reference.requiredEnforcement,
            });
            const provider = await additionalSecurity.selectRuntimeProcessProvider(policy);
            return createAuthorizedRuntimeExecution({
              policy,
              provider,
              authorizationNonce: `${ownerRunId}:${reference.policyDigest}:phase06-process-lifecycle`,
            });
          },
        });
        const additionalScriptExecution = createRunSkillScriptOperations({
          runs: storage.runs,
          steps: storage.steps,
          snapshots,
          bundles,
          runtimeResolver,
          securityCapabilityService: additionalSecurity,
        });
        let runScopedCancellationVerified = false;
        additionalScriptExecutor.run = async (activeBindingId) => {
          const context = lastScriptContext;
          if (context === undefined)
            throw new Error("The prepared script Tool context was not captured.");
          for (const binding of selectedBindings.filter(
            ({ bindingId }) => bindingId !== activeBindingId,
          )) {
            const result = await additionalScriptExecution(
              {
                runId: context.identity.runId,
                bindingId: binding.bindingId,
                resourcePath: "scripts/check.mjs",
                args: [],
                yieldTimeMs: 500,
                signal: new AbortController().signal,
              },
              context,
            );
            if (
              result.kind !== "EXECUTED" ||
              result.status !== "RUNNING" ||
              result.sessionId === undefined
            ) {
              throw new Error("A project or built-in frozen Skill script did not execute.");
            }
            const interaction = await processOperations.interact({
              environment: context.environment,
              securityContext: context.securityContext,
              ownerRunId: context.identity.runId,
              sessionId: result.sessionId,
              chars: "",
              yieldTimeMs: 250,
              signal: new AbortController().signal,
            });
            if (interaction.status !== "RUNNING") {
              throw new Error(
                "The script process session could not be polled through write_stdin.",
              );
            }
            if (!runScopedCancellationVerified) {
              const activeRuntime = runtime;
              if (activeRuntime === undefined) {
                throw new Error("The Skill script Runtime was not available for Run cleanup.");
              }
              const cancellation = await activeRuntime.cancelOwnedResources(context.identity.runId);
              if (
                !cancellation.confirmed ||
                !cancellation.stoppedResourceIds.includes(result.sessionId)
              ) {
                throw new Error("Run cancellation did not stop its owned Skill script process.");
              }
              runScopedCancellationVerified = true;
            } else {
              const stopped = await processOperations.terminate({
                environment: context.environment,
                securityContext: context.securityContext,
                ownerRunId: context.identity.runId,
                sessionId: result.sessionId,
              });
              if (stopped.status !== "EXITED" || stopped.signal !== "KILLED") {
                throw new Error(
                  "The script process session could not be stopped through stop_process.",
                );
              }
            }
          }
        };
        const capturingScriptExecution: typeof scriptExecution = (input, context) => {
          lastScriptContext = context;
          return scriptExecution(input, context);
        };
        const skillOperations = createRunSkillOperationsAdapter({
          runs: storage.runs,
          snapshots,
          bundles,
          modelCatalog,
          scriptExecution: capturingScriptExecution,
        });
        const toolRegistrations = createDefaultCodingTools({
          readFile: {} as never,
          readOnly: {} as never,
          patch: {} as never,
          exec: {} as never,
          process: {} as never,
          git: {} as never,
          skills: skillOperations,
        });
        controlledProvider = await createControlledProvider();
        const session = makeSession({
          workspaceId: workspaceRef.id,
          defaultWorkspace: workspaceRef,
          defaultModel: { provider: "deepseek", model: MODEL_ID },
        });
        await storage.sessions.insert(session);
        composition = await composeDaemon({
          storage,
          skillProvider,
          skillArtifactRoot: artifactRoot,
          skillFeatureEnabled: true,
          toolRegistrations,
          processSandboxProviders: [sandboxProvider],
          runtime,
          providers: [
            {
              provider: "deepseek",
              baseUrl: controlledProvider.endpoint,
              apiKey: "fixture-only",
              allowedModels: [MODEL_ID],
            },
          ],
          modelSources: [deepSeekModelSource()],
          defaultModel: { provider: "deepseek", model: MODEL_ID },
          toolExposure: "AVAILABLE",
          configResolver: {
            resolve: async () => ({
              baseSystemPrompt: "Use verified Skills and their bound scripts when relevant.",
              modelSettings: { maxOutputTokens: 2_048, temperature: 0 },
            }),
          },
        });
        expect(composition.toolRegistry.names()).toHaveLength(16);
        expect(composition.skillFeatureReadiness).toMatchObject({
          invocationReady: true,
          scriptExecutionReady: false,
        });

        const runId = createRunId();
        const catalogPage = await composition.skillCatalog!.listUserCatalog({
          workspaceId: workspaceRef.id,
          pageSize: 20,
          signal: new AbortController().signal,
        });
        expect(catalogPage.items.map(({ name }) => name)).toEqual([
          "builtin-skill",
          "project-skill",
          "sample-skill",
        ]);
        const selections = ["sample-skill", "project-skill", "builtin-skill"].map((name) => {
          const item = catalogPage.items.find((candidateItem) => candidateItem.name === name);
          if (item === undefined) throw new Error(`The ${name} Skill was not selectable.`);
          return { skillId: item.skillId, selectionToken: item.selectionToken };
        });
        const prepared = await composition.selectedSkillPreparer!.prepare({
          runId,
          workspaceId: workspaceRef.id,
          selections,
          model: { provider: "deepseek", model: MODEL_ID },
          signal: new AbortController().signal,
        });
        const frozenSnapshot =
          await composition.runSkillCatalogSnapshots!.readRunSkillCatalogSnapshot(
            prepared.workflowProfile.catalogSnapshotRef,
          );
        const frozenSkills = skillSources.map((source) => {
          const skill = frozenSnapshot.skills.find(({ name }) => name === source.name);
          if (skill === undefined)
            throw new Error(`The frozen ${source.name} Skill was not in the Run catalog.`);
          return skill;
        });
        for (const source of skillSources) {
          await writeFile(
            join(source.root, "scripts", "check.mjs"),
            `console.log('CHANGED_${source.name.toLocaleUpperCase("en-US")}_SOURCE_V2')\n`,
            "utf8",
          );
        }
        const runDraft = makeRun(session.id, {
          id: runId,
          goal: "Run the frozen user, project, and built-in Skill validation scripts.",
          workspace: workspaceRef,
          model: { provider: "deepseek", model: MODEL_ID },
          runtime: { id: "local", kind: "local" },
          permissionProfile: "PROJECT_ACCESS",
          approvalPolicy: "ON_BOUNDARY",
          completionContract: "NATURAL_V1",
          limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 90_000 },
        });
        const run = {
          ...runDraft,
          contextBudgetPolicy: await composition.contextBudgetPolicyResolver.resolve(runDraft),
        };
        await storage.runs.insertRunWithPreparedResources!({
          run,
          workflowProfile: prepared.workflowProfile,
          resourcesInOrder: prepared.bindingsInSelectionOrder,
          events: [],
        });
        selectedBindings = await storage.runs.readPreparedResources!(runId);
        expect(selectedBindings.map(({ resourceId }) => resourceId)).toEqual(
          selections.map(({ skillId }) => skillId),
        );
        controlledProvider.setBindingId(selectedBindings[0]!.bindingId);

        const publicRunEvents: string[] = [];
        const eventSubscription = composition.eventHub?.subscribe(
          { runId, includeDurable: true, includeTransient: true },
          (event) => publicRunEvents.push(JSON.stringify(event)),
        );
        const initial = await composition.controller.start(runId);
        expect(initial.run.status).toBe("WAITING_APPROVAL");
        const pendingApprovals = await storage.approvals.listPendingByRun(runId);
        expect(pendingApprovals).toHaveLength(1);
        expect(JSON.stringify(pendingApprovals[0])).not.toContain(scriptArgs.join(" "));
        await composition.supervisor.resolveApproval(runId, pendingApprovals[0]!.id, {
          action: "APPROVE",
          scope: "ONCE",
        } satisfies ApprovalResolution);
        await composition.supervisor.drain();
        await new Promise((resolve) => setTimeout(resolve, 25));
        eventSubscription?.close();

        const finalRun = await storage.runs.get(runId);
        expect(finalRun?.status).toBe("COMPLETED");
        expect(controlledProvider.requests).toHaveLength(3);
        expect(processObservations).toHaveLength(1);
        expect(additionalProcessObservations).toHaveLength(2);
        expect(runScopedCancellationVerified).toBe(true);
        const { spec, scriptSource } = processObservations[0]!;
        expect(spec.launch.executable).toBe(process.execPath);
        expect(spec.launch.args.slice(1)).toEqual(scriptArgs);
        expect(scriptSource).toBe(skillSources[0].frozenSource);
        expect(spec.readOnlyResourceGrant).toMatchObject({
          runId,
          bundleRevision: frozenSkills[0].bundle.bundleRevision,
          contentManifestHash: frozenSkills[0].bundle.bundleRevision.slice("sha256:".length),
        });
        expect(spec.readOnlyResourceGrant?.canonicalRoot.toLocaleLowerCase("en-US")).toContain(
          artifactRoot.replaceAll("\\", "/").toLocaleLowerCase("en-US"),
        );
        expect(spec.launch.executable.toLowerCase()).not.toContain("cmd.exe");
        const allScriptObservations = [...processObservations, ...additionalProcessObservations];
        expect(allScriptObservations.map(({ scriptSource: value }) => value).sort()).toEqual(
          skillSources.map(({ frozenSource }) => frozenSource).sort(),
        );
        for (const observation of allScriptObservations) {
          const canonicalRoot =
            observation.spec.readOnlyResourceGrant?.canonicalRoot.toLocaleLowerCase("en-US");
          expect(canonicalRoot).toContain(
            artifactRoot.replaceAll("\\", "/").toLocaleLowerCase("en-US"),
          );
          expect(canonicalRoot).not.toContain(userRoot.toLocaleLowerCase("en-US"));
          expect(canonicalRoot).not.toContain(
            join(workspaceRoot, ".agents", "skills").toLocaleLowerCase("en-US"),
          );
          expect(canonicalRoot).not.toContain(builtinRoot.toLocaleLowerCase("en-US"));
        }

        const invocations = await storage.toolInvocations.listByRun(runId);
        expect(invocations.map(({ toolName, status }) => ({ toolName, status }))).toEqual([
          { toolName: "search_skills", status: "COMPLETED" },
          { toolName: "run_skill_script", status: "COMPLETED" },
        ]);
        const bindings = await storage.runs.readPreparedResources!(runId);
        const receipts = await storage.runs.readPreparedInputReceipts!(runId);
        expect(bindings).toHaveLength(3);
        const receiptBindingIds = new Set(receipts.map(({ bindingId }) => bindingId));
        expect(bindings.every(({ bindingId }) => receiptBindingIds.has(bindingId))).toBe(true);
        expect(spec.readOnlyResourceGrant?.resourceId).toBe(bindings[0]?.bindingId);

        const observations = await storage.observations.listByRun(runId);
        const transcript = await new SessionTranscriptService({
          sessions: storage.sessions,
          runs: storage.runs,
          messageRecords: storage.messageRecords,
          codecs: composition.messages.codecs,
          transcriptProjectors: composition.transcriptProjectors,
        }).getTranscript(session.id, { limit: 100 });
        const publicEvents = await storage.eventReader.replay(runId, {
          afterSequence: 0,
          throughSequence: Number.MAX_SAFE_INTEGER,
          limit: 1_000,
        });
        const publicSurfaces = JSON.stringify({ observations, transcript, publicEvents });
        expect(publicSurfaces).not.toContain(artifactRoot);
        expect(publicSurfaces).not.toContain("sk-test-provider-secret-0123456789");
        for (const frozenSkill of frozenSkills) {
          expect(publicSurfaces).not.toContain(frozenSkill.bundle.artifactRef);
        }
        const liveAndDurableEvents = publicRunEvents.join("\n");
        expect(liveAndDurableEvents).not.toContain(artifactRoot);
        expect(liveAndDurableEvents).not.toContain("sk-test-provider-secret-0123456789");
        for (const frozenSkill of frozenSkills) {
          expect(liveAndDurableEvents).not.toContain(frozenSkill.bundle.artifactRef);
        }
        expect(controlledProvider.requests[2]?.body.messages).not.toContain(artifactRoot);
        expect(controlledProvider.requests[2]?.body.messages).not.toContain(
          "sk-test-provider-secret-0123456789",
        );

        const executionContext = lastScriptContext;
        const bindingId = bindings[0]?.bindingId;
        if (executionContext === undefined || bindingId === undefined) {
          throw new Error("The script evaluation context was not captured.");
        }
        const replayedTerminalCall = await composition.toolTurn.batches.execute({
          runId,
          sessionId: session.id,
          sourceStepId: executionContext.identity.sourceStepId,
          calls: [
            {
              externalCallId: executionContext.identity.externalCallId,
              toolName: "run_skill_script",
              args: {
                bindingId,
                resourcePath: "scripts/check.mjs",
                args: scriptArgs,
                yieldTimeMs: 1_000,
              },
            },
          ],
          environment: executionContext.environment,
          securityContext: executionContext.securityContext!,
          signal: new AbortController().signal,
        });
        expect(replayedTerminalCall.kind).toBe("COMPLETED");
        expect(processObservations).toHaveLength(1);

        const baseInput = {
          runId,
          bindingId,
          args: [],
          yieldTimeMs: 500,
          signal: new AbortController().signal,
        };
        await expect(
          scriptExecution({ ...baseInput, resourcePath: "references/guide.md" }, executionContext),
        ).rejects.toMatchObject({ code: "SKILL_SCRIPT_DENIED" });
        await expect(
          scriptExecution(
            { ...baseInput, resourcePath: "scripts/check.mjs", workdir: "../outside" },
            executionContext,
          ),
        ).rejects.toMatchObject({ code: "SKILL_SCRIPT_DENIED" });
        await expect(
          scriptExecution(
            {
              ...baseInput,
              bindingId: "binding_from_another_run",
              resourcePath: "scripts/check.mjs",
            },
            executionContext,
          ),
        ).rejects.toMatchObject({ code: "SKILL_BINDING_INACTIVE" });
        await expect(
          scriptExecution(
            { ...baseInput, resourcePath: "scripts/check.mjs" },
            {
              ...executionContext,
              environment: {
                ...executionContext.environment,
                workspace: {
                  ...executionContext.environment.workspace,
                  path: join(directory, "other"),
                },
              },
            },
          ),
        ).rejects.toMatchObject({ code: "SKILL_WORKSPACE_MISMATCH" });
        const securityContext = executionContext.securityContext;
        if (securityContext?.securityPolicy === undefined) {
          throw new Error("The executing Run did not carry its persisted security policy.");
        }
        await expect(
          scriptExecution(
            { ...baseInput, resourcePath: "scripts/check.mjs" },
            {
              ...executionContext,
              securityContext: {
                ...securityContext,
                securityPolicy: {
                  ...securityContext.securityPolicy,
                  policyDigest: "a".repeat(64),
                },
              },
            },
          ),
        ).rejects.toMatchObject({ code: "SKILL_SCRIPT_DENIED" });
        const originalProcess = process;
        vi.stubGlobal("process", { ...originalProcess, platform: "linux" });
        try {
          await expect(
            scriptExecution({ ...baseInput, resourcePath: "scripts/check.mjs" }, executionContext),
          ).rejects.toMatchObject({ code: "SKILL_SCRIPT_UNAVAILABLE" });
        } finally {
          vi.unstubAllGlobals();
        }
        expect(processObservations).toHaveLength(1);
      } finally {
        await composition?.dispose().catch(() => undefined);
        await controlledProvider?.close().catch(() => undefined);
        await storage?.close().catch(() => undefined);
        await runtime?.dispose().catch(() => undefined);
      }
    },
    120_000,
  );
});

const MODEL_ID = "deepseek-reasoner";
const MODEL_ARGS = ["; touch PWNED_MARKER", "two words", "$(Write-Output injected)"];

interface ControlledProvider extends ControllableProviderServer {
  setBindingId(bindingId: string): void;
}

function deepSeekModelSource(): ModelDescriptorSourcePort {
  const descriptor: ModelDescriptor = {
    ref: { provider: "deepseek", model: MODEL_ID },
    api: "openai-compatible-chat",
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 2_048 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "SUPPORTED",
      reasoningSummary: "UNKNOWN",
      promptCaching: "SUPPORTED",
      usageReporting: "SUPPORTED",
    },
    reasoning: { supportedLevels: ["HIGH"], supportsSummary: "UNKNOWN" },
    cache: { supportedRetentions: ["SHORT", "LONG"], defaultRetention: "LONG" },
    source: "CONFIGURATION",
    adapterMetadata: {
      "openai-compatible": {
        cacheDialect: "AUTOMATIC",
        requiresReasoningReplayWithTools: true,
      },
    },
  };
  return {
    id: "phase06-script-controlled-provider",
    priority: 100,
    resolve: (ref) =>
      ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
        ? descriptor
        : undefined,
  };
}

async function createControlledProvider(): Promise<ControlledProvider> {
  let selectedBindingId = "";
  const scriptArgs = MODEL_ARGS;
  const turns = [
    {
      kind: "TOOL" as const,
      id: "phase06-search",
      name: "search_skills",
      args: { query: "validation script" },
    },
    {
      kind: "TOOL" as const,
      id: "phase06-run-script",
      name: "run_skill_script",
      args: (messages: unknown) => {
        const prompt = collectStrings(messages).join("\n");
        const bindingIds = [
          ...prompt.matchAll(/<workflow_instruction\s+binding_id="([^"]+)"/gu),
        ].map((match) => match[1]);
        if (selectedBindingId.length === 0 || !bindingIds.includes(selectedBindingId)) {
          throw new Error("The selected Skill binding did not appear in Context.");
        }
        return {
          bindingId: selectedBindingId,
          resourcePath: "scripts/check.mjs",
          args: scriptArgs,
          yieldTimeMs: 1_000,
        };
      },
    },
    { kind: "ANSWER" as const, text: "The verified script completed." },
  ];
  const server = await createControllableProviderServer(async (request, response) => {
    if (!request.path.endsWith("/chat/completions") || request.method !== "POST") {
      throw new Error("The controlled Phase 06 Provider received an unexpected request.");
    }
    const turn = turns[request.index];
    if (turn === undefined)
      throw new Error("The controlled Phase 06 Provider script was exhausted.");
    beginOpenAISse(response);
    if (turn.kind === "TOOL") {
      const args = typeof turn.args === "function" ? turn.args(request.body.messages) : turn.args;
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: { reasoning_content: `Controlled script turn ${request.index}.` },
      });
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: turn.id,
              type: "function",
              function: { name: turn.name, arguments: JSON.stringify(args) },
            },
          ],
        },
      });
      writeOpenAIChunk(response, { model: MODEL_ID, delta: {}, finishReason: "tool_calls" });
    } else {
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: { reasoning_content: "Controlled script answer reasoning.", content: turn.text },
        finishReason: "stop",
      });
    }
    response.end("data: [DONE]\n\n");
  });
  return {
    ...server,
    setBindingId(bindingId) {
      selectedBindingId = bindingId;
    },
  };
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function createControlledSandboxProvider(
  outputFor: (spec: SandboxedSpawnSpec) => Promise<string>,
): ProcessSandboxProvider {
  return {
    id: "phase06-controlled-read-only-resource",
    kind: "RESTRICTED",
    enforcement: "HARD",
    probe: async () => ({ available: true, enforcement: "HARD" }),
    async create(spec) {
      if (spec.readOnlyResourceGrant === undefined) {
        throw new Error("The Runtime did not pass the immutable resource grant to the provider.");
      }
      return new ControlledProcessAdapter(await outputFor(spec));
    },
  };
}

function createPersistentControlledSandboxProvider(
  observe: (spec: SandboxedSpawnSpec) => Promise<void>,
): ProcessSandboxProvider {
  return {
    id: "phase06-controlled-persistent-resource",
    kind: "RESTRICTED",
    enforcement: "HARD",
    probe: async () => ({ available: true, enforcement: "HARD" }),
    async create(spec) {
      if (spec.readOnlyResourceGrant === undefined) {
        throw new Error(
          "The Runtime did not pass the immutable resource grant to the persistent process.",
        );
      }
      await observe(spec);
      return new PersistentControlledProcessAdapter();
    },
  };
}

class PersistentControlledProcessAdapter implements ManagedProcessAdapter {
  readonly tty = false;
  private readonly starts = new Set<() => void>();
  private readonly outputs = new Set<(event: ProcessOutputEvent) => void>();
  private readonly exits = new Set<(exit: ProcessExit) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  private closed = false;

  onStart(listener: () => void): () => void {
    this.starts.add(listener);
    queueMicrotask(() => {
      for (const start of this.starts) start();
    });
    return () => this.starts.delete(listener);
  }

  onOutput(listener: (event: ProcessOutputEvent) => void): () => void {
    this.outputs.add(listener);
    return () => this.outputs.delete(listener);
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.exits.add(listener);
    if (this.closed) queueMicrotask(() => listener({ signal: "KILLED" }));
    return () => this.exits.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  async write(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const exit of this.exits) exit({ signal: "KILLED" });
  }
}

class ControlledProcessAdapter implements ManagedProcessAdapter {
  readonly tty = false;
  private readonly starts = new Set<() => void>();
  private readonly outputs = new Set<(event: ProcessOutputEvent) => void>();
  private readonly exits = new Set<(exit: ProcessExit) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  private emitted = false;

  constructor(private readonly output: string) {}

  onStart(listener: () => void): () => void {
    this.starts.add(listener);
    return () => this.starts.delete(listener);
  }

  onOutput(listener: (event: ProcessOutputEvent) => void): () => void {
    this.outputs.add(listener);
    return () => this.outputs.delete(listener);
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.exits.add(listener);
    if (!this.emitted) {
      this.emitted = true;
      queueMicrotask(() => {
        for (const start of this.starts) start();
        for (const output of this.outputs) output({ stream: "stdout", text: this.output });
        for (const exit of this.exits) exit({ exitCode: 0 });
      });
    }
    return () => this.exits.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  async write(): Promise<void> {}

  async close(): Promise<void> {
    if (this.emitted) return;
    this.emitted = true;
    for (const exit of this.exits) exit({ signal: "KILLED" });
  }
}
