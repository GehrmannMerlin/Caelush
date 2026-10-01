import { describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  LocalProcessManager,
  LocalRuntime,
  RuntimeAuthorizationError,
  createAuthorizedRuntimeExecution,
  createRuntimeFilesystemPolicy,
  createRuntimeProcessPolicy,
  type ManagedProcessAdapter,
  type ProcessExit,
  type ProcessOutputEvent,
  type SandboxedSpawnSpec,
} from "../src/index.js";

interface FixtureAdapterHandle {
  readonly adapter: ManagedProcessAdapter;
  readonly writes: string[];
  readonly closeCount: () => number;
}

function createFixtureAdapter(): FixtureAdapterHandle {
  const outputListeners = new Set<(event: ProcessOutputEvent) => void>();
  const exitListeners = new Set<(event: ProcessExit) => void>();
  const writes: string[] = [];
  let closeCalls = 0;
  let exited = false;
  const adapter: ManagedProcessAdapter = {
    tty: false,
    onStart(listener) {
      queueMicrotask(() => listener());
      return () => undefined;
    },
    onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      if (exited) queueMicrotask(() => listener({ exitCode: 0 }));
      return () => exitListeners.delete(listener);
    },
    onError() {
      return () => undefined;
    },
    async write(chars) {
      writes.push(chars);
      for (const listener of outputListeners) listener({ stream: "stdout", text: `echo:${chars}` });
    },
    async close() {
      closeCalls += 1;
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener({ signal: "KILLED" });
    },
  };
  return {
    adapter,
    writes,
    closeCount: () => closeCalls,
  };
}

function makePolicy(workspaceRoot: string) {
  const workspaceId = createWorkspaceId();
  return createRuntimeProcessPolicy({
    runId: "run_provider_conformance" as never,
    workspaceId,
    workspaceRoot,
    filesystemBoundary: "WORKSPACE_READ_WRITE",
    processBoundary: "WORKSPACE_WRITE",
    requiredEnforcement: "OS_RESTRICTED",
    hostUserRoot: workspaceRoot,
  });
}

describe("restricted Provider public conformance", () => {
  it("uses the authorized restricted Provider for output, stdin, cancellation, and cleanup", async () => {
    const workspaceRoot = process.cwd();
    const policy = makePolicy(workspaceRoot);
    const observed: SandboxedSpawnSpec[] = [];
    const handles: FixtureAdapterHandle[] = [];
    const provider = {
      id: "fixture-hard-restricted",
      kind: "RESTRICTED" as const,
      enforcement: "HARD" as const,
      create: async (spec: SandboxedSpawnSpec) => {
        observed.push(spec);
        const handle = createFixtureAdapter();
        handles.push(handle);
        return handle.adapter;
      },
    };
    const authorization = createAuthorizedRuntimeExecution({
      policy,
      provider,
      authorizationNonce: "provider-conformance-nonce-1",
    });
    const runtime = new LocalRuntime({
      processManager: new LocalProcessManager({ generationId: "provider-conformance" }),
    });
    try {
      const scope = await runtime.openWorkspace(
        { id: policy.filesystem.workspaceId, path: workspaceRoot },
        { processAuthorization: authorization },
      );
      const started = await scope.exec.executeAuthorized({
        ownerRunId: policy.runId,
        command: "node --version",
        workdir: ".",
        tty: false,
        yieldTimeMs: 250,
        authorization,
      });

      expect(started.status).toBe("RUNNING");
      expect(started.sessionId).toBeDefined();
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        cwd: workspaceRoot,
        tty: false,
        policy: {
          processBoundary: "WORKSPACE_WRITE",
          requiredEnforcement: "OS_RESTRICTED",
        },
      });

      const interacted = await scope.exec.interact({
        ownerRunId: policy.runId,
        sessionId: started.sessionId!,
        chars: "input\n",
        yieldTimeMs: 250,
      });
      expect(interacted.output).toContain("echo:input");
      expect(handles[0]?.writes).toEqual(["input\n"]);

      const terminated = await scope.exec.terminate({
        ownerRunId: policy.runId,
        sessionId: started.sessionId!,
      });
      expect(terminated).toMatchObject({ status: "EXITED", signal: "KILLED" });
      expect(handles[0]?.closeCount()).toBe(1);

      const cancellable = await scope.exec.executeAuthorized({
        ownerRunId: policy.runId,
        command: "node --version",
        workdir: ".",
        tty: false,
        yieldTimeMs: 250,
        authorization,
      });
      expect(cancellable.sessionId).toBeDefined();
      const cancelled = await runtime.cancelOwnedResources(policy.runId);
      expect(cancelled.confirmed).toBe(true);
      expect(cancelled.stoppedResourceIds).toHaveLength(1);
      expect(handles[1]?.closeCount()).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("requires an explicit authorization and never ordinary-spawns from a policy-bound scope", async () => {
    const workspaceRoot = process.cwd();
    const policy = makePolicy(workspaceRoot);
    const runtime = new LocalRuntime();
    try {
      const scope = await runtime.openWorkspace(
        { id: policy.filesystem.workspaceId, path: workspaceRoot },
        {
          filesystemPolicy: createRuntimeFilesystemPolicy({
            workspaceId: policy.filesystem.workspaceId,
            workspaceRoot,
            boundary: "WORKSPACE_READ_WRITE",
            hostUserRoot: workspaceRoot,
          }),
        },
      );

      await expect(
        scope.exec.execute({
          ownerRunId: policy.runId,
          command: "node --version",
          workdir: ".",
          tty: false,
          yieldTimeMs: 250,
        }),
      ).rejects.toBeInstanceOf(RuntimeAuthorizationError);
    } finally {
      await runtime.dispose();
    }
  });
});
