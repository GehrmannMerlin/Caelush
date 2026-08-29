import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { createWorkspaceId, type JsonObject } from "@caelush/protocol";
import { createExecCommandRegistration, createWriteStdinRegistration } from "../src/index.js";
import type { ToolExecutionRequest } from "../src/handler.js";

function request(args: Record<string, unknown>): ToolExecutionRequest {
  return {
    runId: "run_shell" as never,
    stepId: "step_shell" as never,
    invocationId: "inv_shell" as never,
    externalCallId: "call_shell",
    args: args as JsonObject,
    environment: {
      runtime: { id: "local", kind: "local" },
      workspace: { id: createWorkspaceId(), path: "" },
    },
  };
}

describe("shell Tool runtime integration", () => {
  it("returns non-zero exit as a successful Tool result", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-shell-tool-"));
    const workspace = path.join(parent, "workspace");
    await mkdir(workspace);
    const script = path.join(workspace, "nonzero.js");
    await writeFile(script, "process.exitCode = 7;", "utf8");
    const runtime = new LocalRuntime({
      processManagerOptions: { generationId: "tool-generation" },
    });
    const resolver = createLocalRuntimeResolver(runtime);
    const registration = createExecCommandRegistration(resolver);
    try {
      const result = await registration.handler.execute({
        ...request({ cmd: "node nonzero.js" }),
        environment: {
          runtime: { id: "local", kind: "local" },
          workspace: { id: createWorkspaceId(), path: workspace },
        },
      });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("exit code 7");
      expect(result.details).toMatchObject({ ok: true, status: "EXITED", exitCode: 7 });
    } finally {
      await runtime.dispose();
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("continues one real managed process through write_stdin", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-shell-tool-"));
    const workspace = path.join(parent, "workspace");
    await mkdir(workspace);
    const script = path.join(workspace, "managed.js");
    await writeFile(
      script,
      "process.stdout.write('READY'); process.stdin.on('data', s => { process.stdout.write(s.includes('ping') ? 'pong' : s); if (s.includes('exit')) process.exit(0) });",
      "utf8",
    );
    const runtime = new LocalRuntime({
      processManagerOptions: { generationId: "managed-generation" },
    });
    const resolver = createLocalRuntimeResolver(runtime);
    const exec = createExecCommandRegistration(resolver);
    const stdin = createWriteStdinRegistration(resolver);
    const environment = {
      runtime: { id: "local", kind: "local" },
      workspace: { id: createWorkspaceId(), path: workspace },
    };
    try {
      const started = await exec.handler.execute({
        ...request({
          cmd: "node managed.js",
          yield_time_ms: 250,
        }),
        environment,
      });
      expect(started.isError).toBe(false);
      expect(started.details).toMatchObject({
        ok: true,
        status: "RUNNING",
        sessionId: expect.any(String),
      });
      const sessionId = started.details.sessionId;
      const polled = await stdin.handler.execute({
        ...request({ session_id: sessionId }),
        environment,
      });
      expect(polled.isError).toBe(false);
      const pong = await stdin.handler.execute({
        ...request({ session_id: sessionId, chars: "ping\n" }),
        environment,
      });
      expect(pong.content).toContain("pong");
      const exited = await stdin.handler.execute({
        ...request({ session_id: sessionId, chars: "exit\n" }),
        environment,
      });
      expect(exited.details).toMatchObject({ ok: true, status: "EXITED", exitCode: 0 });
    } finally {
      await runtime.dispose();
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});
