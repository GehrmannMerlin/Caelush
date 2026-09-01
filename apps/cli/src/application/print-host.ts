import type { AgentEvent, ClientAgentRun, RunId, RunStatus } from "@caelush/protocol";
import { VerifiedRunFinalResultSchema } from "@caelush/protocol";
import {
  CliConversationController,
  MAX_CLI_PROMPT_BYTES,
  type CliDaemonClient,
} from "./cli-controller.js";
import type { LaunchIntent, PrintOutputFormat } from "../bootstrap/cli-args.js";

export const MAX_PRINT_INPUT_BYTES = MAX_CLI_PROMPT_BYTES;

export class PrintInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintInputError";
  }
}

export interface PrintInput {
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly isTTY: boolean;
  readonly argument?: string;
  readonly maxBytes?: number;
}

export async function readPrintPrompt(options: PrintInput): Promise<string | undefined> {
  const maxBytes = options.maxBytes ?? MAX_PRINT_INPUT_BYTES;
  if (
    options.argument !== undefined &&
    new TextEncoder().encode(options.argument).byteLength > maxBytes
  ) {
    throw new PrintInputError("The print prompt is too large.");
  }
  if (options.argument === undefined && options.isTTY) return undefined;
  if (options.argument !== undefined && options.isTTY) return options.argument;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of options.input) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) throw new PrintInputError("The print prompt is too large.");
    chunks.push(bytes);
  }
  let stdinText: string;
  try {
    const allBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      allBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    stdinText = new TextDecoder("utf-8", { fatal: true }).decode(allBytes);
  } catch {
    throw new PrintInputError("The print prompt must be valid UTF-8.");
  }

  if (options.argument !== undefined && stdinText.trim().length > 0) {
    throw new PrintInputError(
      "Provide the prompt either as an argument or through stdin, not both.",
    );
  }
  if (options.argument !== undefined) return options.argument;
  return stdinText.trim().length === 0 ? undefined : stdinText;
}

export interface PrintResult {
  readonly version: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly status: RunStatus;
  readonly success: boolean;
  readonly finalText?: string;
  readonly errorCode?: string;
  readonly requiresApproval?: boolean;
  readonly exitReason?: string;
}

export function serializePrintResult(result: PrintResult): string {
  return JSON.stringify(result);
}

export function shouldEmitPrintEvent(event: Pick<AgentEvent, "visibility">): boolean {
  return event.visibility === "USER_VISIBLE";
}

export interface PrintHostOptions {
  readonly client: CliDaemonClient;
  readonly workspacePath: string;
  readonly launchIntent: Exclude<LaunchIntent, { readonly kind: "RESUME_PICKER" }>;
  readonly outputFormat: PrintOutputFormat;
  readonly version: string;
  readonly prompt?: string;
  readonly stdin: AsyncIterable<Uint8Array | string>;
  readonly stdinIsTTY: boolean;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly registerSigint?: (handler: () => void) => () => void;
}

export interface PrintHostResult {
  readonly exitCode: number;
  readonly run?: ClientAgentRun;
  readonly result: PrintResult;
}

export async function runPrintHost(options: PrintHostOptions): Promise<PrintHostResult> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  let prompt: string | undefined;
  try {
    prompt = await readPrintPrompt({
      input: options.stdin,
      isTTY: options.stdinIsTTY,
      ...(options.prompt === undefined ? {} : { argument: options.prompt }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid print input.";
    stderr(`${message}\n`);
    const result: PrintResult = {
      version: options.version,
      sessionId: "unavailable",
      status: "FAILED",
      success: false,
      errorCode: "USAGE",
      exitReason: message,
    };
    if (options.outputFormat !== "text") stdout(`${serializePrintResult(result)}\n`);
    return { exitCode: 2, result };
  }

  if (prompt === undefined && options.launchIntent.kind === "NEW") {
    const message = "Print mode requires a prompt argument or non-empty stdin.";
    stderr(`${message}\n`);
    const result: PrintResult = {
      version: options.version,
      sessionId: "unavailable",
      status: "FAILED",
      success: false,
      errorCode: "USAGE",
      exitReason: message,
    };
    if (options.outputFormat !== "text") stdout(`${serializePrintResult(result)}\n`);
    return { exitCode: 2, result };
  }

  const controller = new CliConversationController({
    client: options.client,
    workspacePath: options.workspacePath,
    launchIntent: options.launchIntent,
    onUserVisibleEvent: (event) => {
      if (options.outputFormat === "stream-json" && shouldEmitPrintEvent(event)) {
        stdout(`${JSON.stringify({ type: "event", event })}\n`);
      }
    },
  });
  let cancelledByUser = false;
  const unregisterSigint = (options.registerSigint ?? defaultSigintRegistration)(() => {
    cancelledByUser = true;
    void controller.cancelActiveRun();
  });

  try {
    await controller.bootstrap();
    const bootstrapState = controller.getState();
    if (bootstrapState.bootstrap === "BOOTSTRAP_ERROR") {
      return finishWithoutRun(options, stderr, stdout, {
        version: options.version,
        sessionId: bootstrapState.session?.id ?? "unavailable",
        status: "FAILED",
        success: false,
        errorCode: "BOOTSTRAP_FAILURE",
        exitReason:
          bootstrapState.fatalError ?? "Caelush could not connect to the local Agent service.",
      });
    }

    let runId: RunId | undefined = controller.getState().activeRun?.runId;
    if (prompt !== undefined) {
      if (!(await controller.submitPrompt(prompt))) {
        return finishWithoutRun(options, stderr, stdout, {
          version: options.version,
          sessionId: controller.getState().session?.id ?? "unavailable",
          status: "FAILED",
          success: false,
          errorCode: "TERMINAL_FAILURE",
          exitReason: controller.getState().fatalError ?? "The Run could not be started.",
        });
      }
      runId =
        controller.getState().activeRun?.runId ?? findRunId(controller.getState().displayHistory);
    }
    if (runId === undefined) {
      return finishWithoutRun(options, stderr, stdout, {
        version: options.version,
        sessionId: controller.getState().session?.id ?? "unavailable",
        status: "FAILED",
        success: false,
        errorCode: "TERMINAL_FAILURE",
        exitReason: "There is no active Run to print.",
      });
    }

    const run = await waitForRun(controller, options.client, runId);
    const result = toPrintResult(options.version, run, cancelledByUser);
    emitResult(options.outputFormat, result, stdout, stderr);
    return { exitCode: exitCodeForResult(result, cancelledByUser), run, result };
  } finally {
    unregisterSigint();
    controller.dispose();
  }
}

async function waitForRun(
  controller: CliConversationController,
  client: CliDaemonClient,
  runId: RunId,
): Promise<ClientAgentRun> {
  return new Promise<ClientAgentRun>((resolve, reject) => {
    let settled = false;
    const finish = (run: ClientAgentRun): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(run);
    };
    const inspect = (state: ReturnType<CliConversationController["getState"]>): void => {
      const active = state.activeRun;
      if (active?.runId === runId && active.status === "WAITING_APPROVAL") {
        void client.getRun(runId).then(finish, reject);
        return;
      }
      if (active === undefined && state.displayHistory.some((entry) => entry.runId === runId)) {
        void client.getRun(runId).then(finish, reject);
      }
    };
    const unsubscribe = controller.subscribe(inspect);
    inspect(controller.getState());
  });
}

function toPrintResult(
  version: string,
  run: ClientAgentRun,
  cancelledByUser: boolean,
): PrintResult {
  const finalResult = VerifiedRunFinalResultSchema.safeParse(run.finalResult);
  if (run.status === "COMPLETED" && finalResult.success) {
    return {
      version,
      sessionId: run.sessionId,
      runId: run.id,
      status: run.status,
      success: true,
      finalText: finalResult.data.text,
    };
  }
  if (run.status === "WAITING_APPROVAL") {
    return {
      version,
      sessionId: run.sessionId,
      runId: run.id,
      status: run.status,
      success: false,
      errorCode: "APPROVAL_REQUIRED",
      requiresApproval: true,
      exitReason: "Run is waiting for approval.",
    };
  }
  return {
    version,
    sessionId: run.sessionId,
    runId: run.id,
    status: run.status,
    success: false,
    errorCode: cancelledByUser && run.status === "CANCELLED" ? "CANCELLED" : "TERMINAL_FAILURE",
    exitReason:
      cancelledByUser && run.status === "CANCELLED"
        ? "User requested cancellation."
        : `Run ended with status ${run.status}.`,
  };
}

function emitResult(
  format: PrintOutputFormat,
  result: PrintResult,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): void {
  if (format === "stream-json") {
    stdout(`${JSON.stringify({ type: "result", result })}\n`);
    return;
  }
  if (format === "json") {
    stdout(`${serializePrintResult(result)}\n`);
    return;
  }
  if (result.success && result.finalText !== undefined) {
    stdout(`${result.finalText}\n`);
    return;
  }
  if (result.requiresApproval) {
    stderr(
      "Run is waiting for approval.\nResume this Session interactively to review the request.\n",
    );
    return;
  }
  stderr(`${result.exitReason ?? "Run failed."}\n`);
}

function finishWithoutRun(
  options: PrintHostOptions,
  stderr: (text: string) => void,
  stdout: (text: string) => void,
  result: PrintResult,
): PrintHostResult {
  emitResult(options.outputFormat, result, stdout, stderr);
  return { exitCode: result.errorCode === "USAGE" ? 2 : 3, result };
}

function exitCodeForResult(result: PrintResult, cancelledByUser: boolean): number {
  if (result.success) return 0;
  if (result.requiresApproval) return 5;
  if (cancelledByUser && result.status === "CANCELLED") return 130;
  return 4;
}

function findRunId(entries: readonly { readonly runId?: RunId | undefined }[]): RunId | undefined {
  return entries.find((entry) => entry.runId !== undefined)?.runId;
}

function defaultSigintRegistration(handler: () => void): () => void {
  process.once("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}
