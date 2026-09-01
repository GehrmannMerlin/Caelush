import { CaelushClientProtocolError } from "@caelush/client";
import type { AgentEvent, ClientAgentRun, DaemonInfo, RunActionResponse } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { type CliDaemonClient } from "../src/application/cli-controller.js";
import { main } from "../src/main.js";

describe("CLI process lifecycle", () => {
  it("returns a safe failure code and creates no Session after bootstrap failure", async () => {
    let sessionCalls = 0;
    const client: CliDaemonClient = {
      getHealth: async () => {
        throw new CaelushClientProtocolError("Daemon request failed: ECONNREFUSED");
      },
      createSession: async () => {
        sessionCalls += 1;
        throw new Error("must not create a Session");
      },
      getInfo: async (): Promise<DaemonInfo> => {
        throw new Error("must not query info");
      },
      createRun: async (): Promise<ClientAgentRun> => {
        throw new Error("must not create a Run");
      },
      watchRunEvents: async function* () {
        yield* [] as AgentEvent[];
      },
      startRun: async (): Promise<RunActionResponse> => {
        throw new Error("must not start a Run");
      },
      getRun: async (): Promise<ClientAgentRun> => {
        throw new Error("must not get a Run");
      },
    };

    let unmountCalls = 0;
    await expect(
      main({
        client,
        workspacePath: "C:\\workspace\\project",
        renderApplication: () => ({
          waitUntilExit: async () => undefined,
          unmount: () => {
            unmountCalls += 1;
          },
        }),
      }),
    ).resolves.toBe(1);
    expect(sessionCalls).toBe(0);
    expect(unmountCalls).toBe(1);
  });
});
