import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiAdapter } from "@caelush/ai";
import {
  AgentRunSchema,
  AgentSessionSchema,
  RunResourcePolicySchema,
  WorkspaceRecordSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type ContextBudgetPolicySnapshot,
  type RunLimits,
} from "@caelush/protocol";
import { createInjectedReplayKeyProvider, expandPermissionPreset } from "@caelush/security";
import { createReplayProtection } from "@caelush/security";
import { openCaelushStorage, toHostToolEffectsPort, type CaelushStorage } from "@caelush/storage";
import {
  applyToolEffectsToAgentState,
  createCodingToolSettlementExtensionDecoder,
  effectsChangeAgentState,
} from "@caelush/coding-agent";
import { composeDaemon, type DaemonComposition } from "../../src/daemon-composition.js";
import type { ResourceCorrectionRecoveryPolicy } from "@caelush/core";
import {
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  fixtureBinding,
  fixtureModelSource,
} from "./ai-fixture.js";

/**
 * The Context budget policy a fixture Run is frozen against.
 *
 * `"DAEMON_DEFAULT"` asks the composed daemon's own resolver — the same authority `createRun` calls
 * — for the policy it would stamp on a new Run. A test that writes `WORKING_SET_V2` by hand proves
 * that a policy object can be persisted; it says nothing about what production chooses, so any
 * assertion about the default has to go through the resolver.
 */
export type FixtureContextBudgetPolicy = ContextBudgetPolicySnapshot | "DAEMON_DEFAULT";

export interface ReliabilityFixtureOptions {
  /**
   * The scripted dialect adapter, appended to the built-in adapter set.
   *
   * Required unless {@link useBuiltinAdapter} is set. A test that exercises the real SDK over an
   * in-memory wire uses the built-in `openai-compatible-chat` adapter and injects only
   * `providerBindingOverrides.transport.fetch`, because appending a second adapter under the same
   * API id is a duplicate registration and wrapping the built-in one under `fixture-api` fails the
   * provider's own replay-identity check.
   */
  readonly adapter?: ApiAdapter;
  /** Use only the built-in adapters, with the wire supplied through the provider binding. */
  readonly useBuiltinAdapter?: boolean;
  /** Provider binding overrides, e.g. `transport.fetch` returning an in-memory SSE response. */
  readonly providerBindingOverrides?: Record<string, unknown>;
  readonly rootDirectory?: string;
  readonly limits?: RunLimits;
  readonly resourcePolicy?: unknown;
  readonly permissionPreset?: "VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS";
  readonly resourceCorrectionRecoveryPolicy?: ResourceCorrectionRecoveryPolicy | null;
  readonly contextBudgetPolicy?: FixtureContextBudgetPolicy;
  /** Model limits for scenarios that must reproduce a large-window provider. */
  readonly modelLimits?: { readonly contextWindowTokens: number; readonly maxOutputTokens: number };
  /** Adapter capability metadata, e.g. the DeepSeek native-replay requirement. */
  readonly adapterMetadata?: Record<string, unknown>;
  /**
   * Dialect id the model declares.
   *
   * A fixture that wraps the real OpenAI-compatible adapter must declare that dialect, because the
   * provider's own private replay payload is bound to it.
   */
  readonly api?: string;
}

/** A real daemon composition and SQLite database with only its external model wire scripted. */
export interface ReliabilityFixture {
  readonly composition: DaemonComposition;
  readonly storage: CaelushStorage;
  readonly databasePath: string;
  readonly fixtureRoot: string;
  readonly workspacePath: string;
  readonly sessionId: ReturnType<typeof createSessionId>;
  readonly run: ReturnType<typeof AgentRunSchema.parse>;
  restartComposition(): Promise<DaemonComposition>;
  dispose(): Promise<void>;
}

export async function createReliabilityFixture(
  options: ReliabilityFixtureOptions,
): Promise<ReliabilityFixture> {
  const fixtureRoot =
    options.rootDirectory ?? (await mkdtemp(join(tmpdir(), "caelush-reliability-")));
  const workspacePath = join(fixtureRoot, "workspace");
  const databasePath = join(fixtureRoot, "caelush.db");
  await mkdir(workspacePath, { recursive: true });

  let storage: CaelushStorage | undefined;
  let composition: DaemonComposition | undefined;
  try {
    storage = await openCaelushStorage({
      path: databasePath,
      replayProtection: createReplayProtection({
        ...createInjectedReplayKeyProvider("reliability-fixture", Buffer.alloc(32, 7)),
      }),
      toolSettlementExtension: createCodingToolSettlementExtensionDecoder({
        effects: toHostToolEffectsPort({
          changesState: effectsChangeAgentState,
          apply: applyToolEffectsToAgentState,
        }),
      }),
    });
    const compose = (recoveryPolicy?: ResourceCorrectionRecoveryPolicy | null) =>
      composeDaemon({
        storage: storage!,
        providerBindings: [
          fixtureBinding(
            (options.providerBindingOverrides ?? {}) as Parameters<typeof fixtureBinding>[0],
          ),
        ],
        modelSources: [
          fixtureModelSource(options.modelLimits, options.adapterMetadata, options.api),
        ],
        adapterOverrides: options.useBuiltinAdapter
          ? []
          : options.adapter === undefined
            ? []
            : [options.adapter],
        defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
        ...(recoveryPolicy === undefined
          ? {}
          : { resourceCorrectionRecoveryPolicy: recoveryPolicy }),
      });
    composition = await compose(options.resourceCorrectionRecoveryPolicy);

    const now = createTimestampMs(Date.now());
    const workspaceId = createWorkspaceId();
    const workspace = WorkspaceRecordSchema.parse({
      id: workspaceId,
      canonicalPath: workspacePath,
      displayName: "Reliability fixture",
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    });
    await storage.workspaces.insert(workspace);

    const sessionId = createSessionId();
    const model = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL };
    const session = AgentSessionSchema.parse({
      id: sessionId,
      workspaceId,
      defaultWorkspace: { id: workspaceId, path: workspacePath },
      defaultModel: model,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    });
    await storage.sessions.insert(session, { expectedWorkspace: workspace });

    const limits = options.limits ?? { maxSteps: 32, maxToolCalls: 64, timeoutMs: 120_000 };
    const resourcePolicy = RunResourcePolicySchema.parse(
      options.resourcePolicy ?? {
        mode: "ADAPTIVE",
        correctionVersion: "AUTONOMOUS_CORRECTION_V2",
        operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
        batch: { maxToolCallsPerTurn: 16 },
        progress: {
          windowTurns: 8,
          identicalCallNudgeThreshold: 3,
          noProgressTurnsBeforeReplan: 4,
          replansBeforePause: 2,
        },
        hardLimits: {},
        inactivity: {},
      },
    );
    const securityPolicy = expandPermissionPreset({
      presetId: options.permissionPreset ?? "WORKSPACE_WRITE",
      expectedVersion: 1,
      createdAt: new Date(now).toISOString(),
    });
    const runDraft = AgentRunSchema.parse({
      id: createRunId(),
      sessionId,
      goal: "exercise the real daemon reliability path",
      status: "PENDING",
      workspace: { id: workspaceId, path: workspacePath },
      model,
      runtime: { id: "local", kind: "local" },
      permissionProfile: securityPolicy.permissionProfile,
      approvalPolicy: securityPolicy.approvalPolicy,
      securityPolicy,
      completionContract: "NATURAL_V1",
      limits,
      resourcePolicy,
      createdAt: now,
    });
    const contextBudgetPolicy =
      options.contextBudgetPolicy === "DAEMON_DEFAULT"
        ? await composition.contextBudgetPolicyResolver.resolve(runDraft)
        : (options.contextBudgetPolicy ?? { version: "LEGACY_FULL_OUTPUT_V1" });
    const run = AgentRunSchema.parse({ ...runDraft, contextBudgetPolicy });
    await storage.runs.insert(run);

    let disposed = false;
    return {
      composition,
      storage,
      databasePath,
      fixtureRoot,
      workspacePath,
      sessionId,
      run,
      async restartComposition() {
        await composition?.dispose();
        composition = await compose();
        return composition;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await composition?.dispose().catch(() => undefined);
        await storage?.close().catch(() => undefined);
        if (options.rootDirectory === undefined) {
          await rm(fixtureRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await composition?.dispose().catch(() => undefined);
    await storage?.close().catch(() => undefined);
    if (options.rootDirectory === undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export { FIXTURE_API };
