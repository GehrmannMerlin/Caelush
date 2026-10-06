import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIGateway } from "@caelush/ai";
import {
  createContextContributionPipeline,
  createStandardAgentMessageProjectorRegistry,
  type ContextEnginePort,
  type RunEventNotifierPort,
} from "@caelush/agent";
import type { RunAgentContextEngineInput } from "@caelush/core";
import {
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import type { Runtime } from "@caelush/runtime";
import { openCaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ contextEngineOptions: [] as unknown[] }));

vi.mock("@caelush/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@caelush/agent")>();
  return {
    ...actual,
    createV2ContextEngine: (
      options: Parameters<typeof actual.createV2ContextEngine>[0],
    ): ReturnType<typeof actual.createV2ContextEngine> => {
      captured.contextEngineOptions.push(options);
      return {} as ContextEnginePort;
    },
  };
});

import { createDaemonV2ContextEngine } from "../src/context/v2-context-composition.js";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";

let directory: string | undefined;
let composition: DaemonComposition | undefined;
let closeStorage: (() => Promise<void>) | undefined;

afterEach(async () => {
  await composition?.dispose().catch(() => undefined);
  await closeStorage?.().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  composition = undefined;
  closeStorage = undefined;
  captured.contextEngineOptions.length = 0;
});

describe("Prompt Surface daemon composition", () => {
  it("passes the storage-owned port to the Context Engine and starts with an empty surface", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-prompt-surface-composition-"));
    const storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    closeStorage = () => storage.close();
    composition = await composeDaemon({ storage });

    const runId = createRunId();
    const sessionId = createSessionId();
    const workspaceId = createWorkspaceId();
    const goal = "composition identity test";
    const input = {
      run: {
        id: runId,
        sessionId,
        goal,
        workspace: { id: workspaceId, path: directory },
      },
      identity: { runId, sessionId, goal },
      baseSystemPrompt: "test system prompt",
      runMode: "EXECUTE",
    } as unknown as RunAgentContextEngineInput;

    createDaemonV2ContextEngine({
      input,
      storage,
      promptSurfaceStore: storage.promptSurface,
      runtime: {} as Runtime,
      gateway: {} as AIGateway,
      messageProjectors: createStandardAgentMessageProjectorRegistry(),
      notifier: { notifyCommitted: () => undefined } as RunEventNotifierPort,
      contributionPipeline: createContextContributionPipeline(),
      clock: { now: () => createTimestampMs(0) },
      activeToolNames: [],
    });

    expect(captured.contextEngineOptions).toHaveLength(1);
    expect(captured.contextEngineOptions[0]).toMatchObject({
      promptSurfaceStore: storage.promptSurface,
    });
    await expect(storage.promptSurface.getCurrent(runId)).resolves.toBeUndefined();

    const daemonComposition = await readFile(
      new URL("../src/daemon-composition.ts", import.meta.url),
      "utf8",
    );
    expect(daemonComposition).toContain("promptSurfaceStore: options.storage.promptSurface");
  });
});
