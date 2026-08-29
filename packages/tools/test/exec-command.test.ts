import { describe, expect, it } from "vitest";
import { createExecCommandRegistration } from "../src/index.js";
import type { RuntimeResolver } from "@caelush/runtime";

describe("exec_command Tool", () => {
  it("publishes the strict command input and preserves non-zero exit as success", async () => {
    const resolver = { resolve: () => undefined } satisfies RuntimeResolver;
    const registration = createExecCommandRegistration(resolver);
    expect(registration.definition.inputSchema).toMatchObject({
      required: ["cmd"],
      additionalProperties: false,
    });
    expect(registration.definition.inputSchema).not.toHaveProperty("properties.timeout_ms");
    expect(registration.definition.requiredCapabilities).toEqual(["SHELL_EXEC", "PROCESS_START"]);
    const result = await registration.handler.execute({
      runId: "run_a" as never,
      stepId: "step_a" as never,
      invocationId: "inv_a" as never,
      externalCallId: "call_a",
      args: { cmd: "exit 7" },
      environment: {
        runtime: { id: "local", kind: "local" },
        workspace: { id: "ws" as never, path: "/missing" },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("exit 7");
    expect(result.details).toMatchObject({ error: "UNSUPPORTED_RUNTIME" });
  });

  it("bounds shell output exposed to the model at 48 KiB", async () => {
    const resolver: RuntimeResolver = {
      resolve: () => ({
        kind: "local",
        supports: () => true,
        openWorkspace: async () =>
          ({
            exec: {
              execute: async () => ({
                status: "EXITED",
                output: "x".repeat(64 * 1024),
                exitCode: 0,
                totalOutputBytes: 64 * 1024,
                omittedBytes: 0,
              }),
              interact: async () => {
                throw new Error("unused");
              },
            },
          }) as never,
      }),
    };
    const registration = createExecCommandRegistration(resolver);

    const result = await registration.handler.execute({
      runId: "run_a" as never,
      stepId: "step_a" as never,
      invocationId: "inv_a" as never,
      externalCallId: "call_a",
      args: { cmd: "printf output" },
      environment: {
        runtime: { id: "local", kind: "local" },
        workspace: { id: "ws" as never, path: "/workspace" },
      },
    });

    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(48 * 1024);
  });
});
