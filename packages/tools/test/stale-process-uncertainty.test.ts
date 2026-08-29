import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { LocalRuntime, createLocalRuntimeResolver, type RuntimeResolver } from "@caelush/runtime";
import {
  createExecCommandRegistration,
  createWriteStdinRegistration,
  ToolExecutionUncertainError,
} from "../src/index.js";

describe("stale process sessions", () => {
  it("maps a previous runtime generation to uncertain execution", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-stale-process-"));
    const workspace = path.join(parent, "workspace");
    await mkdir(workspace);
    const runtimeA = new LocalRuntime({
      processManagerOptions: { generationId: "stale-generation-a" },
    });
    const runtimeB = new LocalRuntime({
      processManagerOptions: { generationId: "stale-generation-b" },
    });
    const environment = {
      runtime: { id: "local", kind: "local" },
      workspace: { id: createWorkspaceId(), path: workspace },
    };
    const request = (args: Record<string, unknown>) => ({
      runId: "run_stale" as never,
      stepId: "step_stale" as never,
      invocationId: "inv_stale" as never,
      externalCallId: "call_stale",
      args: args as never,
      environment,
    });
    try {
      const started = await createExecCommandRegistration(
        createLocalRuntimeResolver(runtimeA),
      ).handler.execute({
        ...request({ cmd: 'node -e "setTimeout(() => {}, 10000)"', yield_time_ms: 250 }),
      });
      const sessionId = started.details.sessionId as string;
      expect(typeof sessionId).toBe("string");

      const resolver: RuntimeResolver = createLocalRuntimeResolver(runtimeB);
      const stdin = createWriteStdinRegistration(resolver);
      await expect(
        stdin.handler.execute({ ...request({ session_id: sessionId }) }),
      ).rejects.toBeInstanceOf(ToolExecutionUncertainError);
    } finally {
      await runtimeA.dispose();
      await runtimeB.dispose();
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});
