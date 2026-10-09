import { Readable } from "node:stream";
import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createWorkspaceId,
  type ClientAgentRun,
  type ClientAgentSession,
  type DaemonInfo,
  type HealthResponse,
  type PublicRunEvent,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  MAX_PRINT_INPUT_BYTES,
  PrintInputError,
  runPrintHost,
  readPrintPrompt,
  serializePrintResult,
  shouldEmitPrintEvent,
  type PrintResult,
} from "../src/application/print-host.js";
import type { CliDaemonClient } from "../src/application/cli-controller.js";

describe("print host input and output contracts", () => {
  it("accepts strict UTF-8 stdin and treats empty input as no prompt", async () => {
    await expect(
      readPrintPrompt({
        input: Readable.from([Buffer.from("解释这个项目", "utf8")]),
        isTTY: false,
      }),
    ).resolves.toBe("解释这个项目");
    await expect(
      readPrintPrompt({ input: Readable.from([]), isTTY: false }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid or oversized stdin and argument-plus-stdin ambiguity", async () => {
    await expect(
      readPrintPrompt({ input: Readable.from([Buffer.from([0xff])]), isTTY: false }),
    ).rejects.toBeInstanceOf(PrintInputError);
    await expect(
      readPrintPrompt({
        input: Readable.from([Buffer.from("stdin")]),
        isTTY: false,
        argument: "argument",
      }),
    ).rejects.toThrow("Provide the prompt either as an argument or through stdin, not both.");
    await expect(
      readPrintPrompt({
        input: Readable.from([Buffer.alloc(MAX_PRINT_INPUT_BYTES + 1)]),
        isTTY: false,
      }),
    ).rejects.toBeInstanceOf(PrintInputError);
  });

  it("does not read a TTY when the prompt argument is present", async () => {
    const input = Readable.from([]);
    await expect(readPrintPrompt({ input, isTTY: true, argument: "argument" })).resolves.toBe(
      "argument",
    );
  });

  it("treats a missing prompt on a TTY as usage input instead of waiting for stdin", async () => {
    await expect(
      readPrintPrompt({ input: Readable.from([]), isTTY: true }),
    ).resolves.toBeUndefined();
  });

  it("keeps output public and emits only USER_VISIBLE events", () => {
    const result: PrintResult = {
      version: "0.1.0",
      sessionId: "ses_01234567-89ab-7def-8123-456789abcdef",
      runId: "run_01234567-89ab-7def-8123-456789abcdef",
      status: "COMPLETED",
      success: true,
      finalText: "verified answer",
    };
    expect(JSON.parse(serializePrintResult(result))).toEqual(result);
    expect(shouldEmitPrintEvent({ visibility: "USER_VISIBLE" })).toBe(true);
    expect(shouldEmitPrintEvent({ visibility: "DEBUG" })).toBe(false);
    expect(
      serializePrintResult({
        ...result,
        status: "WAITING_APPROVAL",
        success: false,
        requiresApproval: true,
      }),
    ).toContain('"requiresApproval":true');
  });

  it("prints a NORMAL_COMPLETION result from a completed Run", async () => {
    const pending = makeRun("show the result");
    const completed = makeRun("show the result", {
      id: pending.id,
      sessionId: pending.sessionId,
      completionContract: "NATURAL_V1",
      status: "COMPLETED",
      startedAt: 2,
      finishedAt: 3,
      finalResult: {
        type: "NORMAL_COMPLETION",
        text: "The task is complete.",
        sourceStepId: createStepId(),
      },
    });
    const output: string[] = [];
    const client = makeClient(pending, completed);

    const result = await runPrintHost({
      client,
      workspacePath: "C:\\workspace\\project",
      launchIntent: { kind: "NEW" },
      outputFormat: "json",
      version: "0.1.0",
      prompt: "show the result",
      stdin: Readable.from([]),
      stdinIsTTY: true,
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      registerSigint: () => () => undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({
      status: "COMPLETED",
      success: true,
      finalText: "The task is complete.",
    });
    expect(JSON.parse(output.join(""))).toMatchObject({
      status: "COMPLETED",
      success: true,
      finalText: "The task is complete.",
    });
  });
});

function makeClient(pending: ClientAgentRun, completed: ClientAgentRun): CliDaemonClient {
  const session: ClientAgentSession = {
    id: pending.sessionId,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  };
  const info: DaemonInfo = {
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: "0.1.0",
    capabilities: {
      runExecution: true,
      runRecovery: true,
      cancellation: true,
      approvals: true,
      sseReplay: true,
      sessionTranscript: true,
    },
    runtimeKinds: ["local"],
    configuredProviders: ["fixture"],
    defaultModel: { provider: "fixture", model: "fixture-model" },
    defaultRunConfiguration: {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    },
  };
  const health: HealthResponse = {
    service: "caelush-daemon",
    status: "ready",
    apiVersion: "v1",
    protocolVersion: 1,
  };
  const event: PublicRunEvent = {
    eventId: createEventId(),
    schemaVersion: 1,
    type: "run.completed",
    runId: pending.id,
    sessionId: pending.sessionId,
    stepId: createStepId(),
    timestamp: 3,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    payload: { result: completed.finalResult },
  } as PublicRunEvent;

  return {
    getHealth: async () => health,
    getInfo: async () => info,
    createSession: async () => session,
    createRun: async () => pending,
    watchRunEvents: async function* () {
      yield event;
    },
    startRun: async () => ({
      runId: pending.id,
      action: "START",
      disposition: "SCHEDULED",
      run: pending,
    }),
    getRun: async () => completed,
    listSessions: async () => ({ items: [session] }),
    getSession: async () => session,
    getSessionTranscript: async () => ({ items: [] }),
    listRuns: async () => ({ items: [completed] }),
    recoverRun: async () => ({
      runId: pending.id,
      action: "RECOVER",
      disposition: "SCHEDULED",
      run: pending,
    }),
    cancelRun: async () => ({
      runId: pending.id,
      action: "CANCEL",
      disposition: "SCHEDULED",
      run: pending,
    }),
    continueResourceGuard: async () => ({
      runId: pending.id,
      action: "CONTINUE_RESOURCE_GUARD",
      disposition: "SCHEDULED",
      run: pending,
    }),
    listPendingApprovals: async () => ({ items: [] }),
    resolveApproval: async () => ({
      runId: pending.id,
      action: "RESOLVE_APPROVAL",
      disposition: "SCHEDULED",
      run: pending,
    }),
  };
}

function makeRun(goal: string, overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return {
    id: createRunId(),
    sessionId: createSessionId(),
    goal,
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:\\workspace\\project" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    model: { provider: "fixture", model: "fixture-model" },
    createdAt: 1,
    ...overrides,
  };
}
