import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRef } from "@caelush/protocol";
import { openCaelushStorage } from "@caelush/storage";
import type { ProcessSandboxProvider } from "@caelush/runtime";
import { expect } from "vitest";
import { buildDaemonApp, WorkspaceService } from "../../src/index.js";
import {
  SecurityCapabilityService,
  type WorkspacePreparationPort,
} from "../../src/services/security-capability-service.js";

/**
 * The shared apparatus for the workspace-bound permission surfaces.
 *
 * These tests all need the same shape: a real Storage, a real `WorkspaceService` with one
 * registered workspace, and a capability service whose restricted Provider and preparation
 * authority can each be swapped for a deliberately broken one. The flow proof and the adversarial
 * proof must exercise the *same* composition, otherwise "the happy path works" proves nothing about
 * the path that refuses.
 */

export const HOST_HEADERS = { host: "127.0.0.1" } as const;
export const JSON_HEADERS = { host: "127.0.0.1", "content-type": "application/json" } as const;

/** A packaged Runner whose probe proves it works on this host. */
export const restrictedProvider: ProcessSandboxProvider = {
  id: "fixture-restricted",
  kind: "RESTRICTED" as const,
  enforcement: "HARD" as const,
  create: async () => ({}) as never,
  probe: async () => ({ available: true, enforcement: "HARD" as const }),
};

/** The same packaged Runner, but the probe proves it cannot be trusted on this host. */
export const untrustedProvider: ProcessSandboxProvider = {
  id: "fixture-restricted",
  kind: "RESTRICTED" as const,
  enforcement: "HARD" as const,
  create: async () => ({}) as never,
  probe: async () => ({
    available: false,
    enforcement: "NONE" as const,
    reasonCode: "RUNNER_HASH_MISMATCH",
  }),
};

export interface PermissionFixture {
  readonly app: ReturnType<typeof buildDaemonApp>;
  readonly workspace: WorkspaceRef;
  /** The registered workspace root, which is also the fixture's own temporary directory. */
  readonly directory: string;
  close(): Promise<void>;
}

export async function createPermissionFixture(
  options: {
    readonly workspacePreparation?: WorkspacePreparationPort;
    readonly processSandboxProviders?: readonly ProcessSandboxProvider[];
  } = {},
): Promise<PermissionFixture> {
  const directory = await mkdtemp(join(tmpdir(), "caelush-permission-fixture-"));
  const storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const workspaceService = new WorkspaceService({ repository: storage.workspaces });
  const registration = await workspaceService.registerWorkspace({ path: directory });
  const app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    workspaces: storage.workspaces,
    workspaceService,
    eventHub: { watch: async function* () {} } as never,
    eventNotifier: { notifyCommitted: () => undefined },
    securityCapabilityService: new SecurityCapabilityService({
      processSandboxProviders: options.processSandboxProviders ?? [restrictedProvider],
      fullAccessAvailable: true,
      ...(options.workspacePreparation === undefined
        ? {}
        : { workspacePreparation: options.workspacePreparation }),
    }),
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
  });
  let closed = false;
  return {
    app,
    directory,
    workspace: { id: registration.workspace.id, path: registration.workspace.canonicalPath },
    async close() {
      if (closed) return;
      closed = true;
      await app.close().catch(() => undefined);
      await storage.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Fixtures created through this handle are all closed by one `closeAll()`, in creation order. */
export function trackFixtures() {
  const created: PermissionFixture[] = [];
  return {
    async create(
      options: {
        readonly workspacePreparation?: WorkspacePreparationPort;
        readonly processSandboxProviders?: readonly ProcessSandboxProvider[];
      } = {},
    ): Promise<PermissionFixture> {
      const fixture = await createPermissionFixture(options);
      created.push(fixture);
      return fixture;
    },
    async closeAll(): Promise<void> {
      for (const fixture of created.splice(0)) await fixture.close();
    },
  };
}

/**
 * A mutable preparation authority.
 *
 * `WORKSPACE_WRITE` is `REQUIRED` until the port is asked to prepare, which is exactly the contract
 * the Web and the API must agree on. `state.prepared` is exposed so a test can assert a refusal had
 * no side effect.
 */
export function prepareHarness(): {
  readonly port: WorkspacePreparationPort;
  readonly state: { prepared: boolean };
} {
  const state = { prepared: false };
  const port: WorkspacePreparationPort = {
    supported: true,
    getStatus: async (_workspaceId, preset) =>
      preset.id === "VIEW_ONLY" || state.prepared ? "READY" : "REQUIRED",
    prepare: async () => {
      state.prepared = true;
      return { status: "READY" as const };
    },
  };
  return { port, state };
}

/**
 * A workspace-bound daemon requires its Session to name a workspace, so the fixture client must
 * create Sessions the way the Web client does rather than sending an empty body.
 */
export async function createSession(
  app: ReturnType<typeof buildDaemonApp>,
  payload: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: JSON_HEADERS,
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

export function runPayload(
  workspace: WorkspaceRef,
  preset: "VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS",
  expectedVersion = 1,
) {
  return {
    goal: `Exercise ${preset}`,
    workspace,
    model: { provider: "test", model: "test-model" },
    runtime: { id: "local", kind: "test" },
    preset: { id: preset, expectedVersion },
    limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1_000 },
  };
}
