import type {
  AIAdapterEvent,
  AIConversationMessage,
  AIToolResultMessage,
  ApiAdapter,
  ApiAdapterStreamInput,
  ApiId,
} from "@caelush/ai";

import { answer, finish, toolCall } from "./ai-fixture.js";
import { FIXTURE_API } from "./reliability-fixture.js";

/**
 * A model stand-in that may only act on feedback it actually received.
 *
 * ```text
 * previous Tool result for one callId   the fact the next action needs
 * latest plan Context                   the state the next action must agree with
 * ```
 *
 * The adapter this replaces switched on a request counter: turn 3 always sent the correction, so the
 * test passed whether or not the correction had been delivered, whether or not the result was paired
 * with the right call, and whether or not the plan had moved on. That is a script, not a behaviour.
 *
 * Here every step names the `callId` whose result it reads and the observations it accepts. A missing
 * result, a result delivered twice, a result attached to the wrong call, a superseded plan or a plan
 * that has not advanced all raise, so the scenario fails at the request where the feedback broke
 * instead of continuing down a fixed script.
 *
 * What is recorded is deliberately thin: request ordinal, the consumed `callId`, the observation
 * classification and the plan revision the step saw. No provider state, no hidden reasoning.
 */

export type FeedbackScenario =
  | "argument-correction"
  | "failed-check-repair"
  | "post-compaction"
  | "degraded-post-compaction"
  | "keep-original-post-compaction"
  | "historical-not-started"
  | "historical-unknown";

/**
 * The classification of one consumed Tool result.
 *
 * `REJECTED` is a model-visible refusal (`isError`), which is what a schema violation produces. The
 * check markers come from the scenario's own script, so "the check failed" is a fact about what the
 * process printed rather than a guess at product wording.
 */
export type FeedbackObservation =
  | "REJECTED"
  | "SUCCEEDED"
  | "CHECK_FAILED"
  | "CHECK_PASSED"
  | "NOT_STARTED"
  | "OUTCOME_UNKNOWN"
  | "CANCELLED";

export interface FeedbackConsumption {
  readonly request: number;
  readonly consumedCallId: string;
  readonly observation: FeedbackObservation;
  readonly planRevision?: string;
}

export const CHECK_FAILED_MARKER = "CHECK_FAILED";
export const CHECK_PASSED_MARKER = "CHECK_PASSED";
/** A token only the failing script prints, so a surviving fact is attributable to the real output. */
export const CHECK_FAILED_TOKEN = "FAILURE_TOKEN_9F3";

/** The three closure texts the daemon writes when it repairs interrupted Tool history. */
const NOT_STARTED_MARKER = "The tool call was not started";
const OUTCOME_UNKNOWN_MARKER = "Its final outcome is unknown";
const CANCELLED_MARKER = "The tool operation was cancelled";

export class FeedbackContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackContractError";
  }
}

export class FeedbackDrivenAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly consumptions: FeedbackConsumption[] = [];
  readonly mainRequests: ApiAdapterStreamInput[] = [];
  summaryCalls = 0;
  /** The contract violation this adapter refused to continue past, when it raised one. */
  contractFailure: string | undefined;
  private step = 0;
  private planRevision: string | undefined;

  constructor(private readonly scenario: FeedbackScenario) {}

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if (isCompactionRequest(input)) {
      this.summaryCalls += 1;
      return this.summary();
    }
    this.mainRequests.push(input);
    return this.next(input);
  }

  private async *summary(): AsyncGenerator<AIAdapterEvent> {
    if (
      this.scenario === "degraded-post-compaction" ||
      this.scenario === "keep-original-post-compaction"
    ) {
      // Force the production summarization runner down its deterministic fallback path. The next
      // main turn must discover and read the durable source reference instead of trusting a made-up
      // semantic summary.
      yield* answer('{"goal":"truncated summary');
      return;
    }
    yield* answer(
      JSON.stringify({
        goal: "Continue the reliability scenario from its accepted feedback.",
        constraints: ["Preserve the accepted plan and the newest failure facts."],
        completedWork: ["Earlier closed Tool batches were summarized."],
        inProgress: ["Continue from the newest accepted plan revision."],
        blocked: [],
        importantDiscoveries: ["The plan and the newest failure must survive compaction."],
        keyDecisions: [],
        criticalReferences: [],
        nextIntent: "Read the newest plan and the newest failure, then act.",
      }),
    );
  }

  private async *next(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    try {
      yield* this.dispatch(input);
    } catch (error) {
      // The gateway wraps an adapter failure into a generic provider error, which would hide the
      // contract violation behind "AI provider request failed". Keep the reason where a failing
      // test can read it.
      this.contractFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async *dispatch(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    switch (this.scenario) {
      case "argument-correction":
        yield* this.argumentCorrection(input);
        return;
      case "failed-check-repair":
        yield* this.failedCheckRepair(input);
        return;
      case "post-compaction":
      case "degraded-post-compaction":
      case "keep-original-post-compaction":
        yield* this.postCompaction(input);
        return;
      case "historical-not-started":
        yield* this.historical(input, "NOT_STARTED");
        return;
      case "historical-unknown":
        yield* this.historical(input, "OUTCOME_UNKNOWN");
        return;
    }
  }

  private async *argumentCorrection(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.step += 1;
    if (this.step === 1) {
      yield* toolCall("plan-1", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "patch",
            step: "Create the greeting module.",
            status: "in_progress",
            acceptance: ["greeting.mjs exports greet()."],
          },
        ],
        execution: {
          goal: "Create a module through the production Tool pipeline.",
          unresolved: [],
          nextAction: "PLAN_A: write greeting.mjs",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 2) {
      this.consume(input, "plan-1", ["SUCCEEDED"]);
      // The exact model mistake the incident produced: a non-string argument for a string field.
      yield* toolCall("bad-patch", "apply_patch", { patch: 7 });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 3) {
      const { text } = this.consume(input, "bad-patch", ["REJECTED"]);
      // The refusal must be the schema's own feedback, not an infrastructure failure wearing a
      // rejection label: the model can only correct what it is actually told.
      if (!text.includes("patch")) {
        throw new FeedbackContractError("the rejection did not name the offending argument");
      }
      if (text.includes("infrastructure failed")) {
        throw new FeedbackContractError("the rejection was reported as an infrastructure failure");
      }
      yield* toolCall("good-patch", "apply_patch", { patch: GREETING_PATCH });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 4) {
      this.consume(input, "good-patch", ["SUCCEEDED"]);
      yield* toolCall("plan-2", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "patch",
            step: "Create the greeting module.",
            status: "completed",
            acceptance: ["greeting.mjs exports greet()."],
          },
        ],
        execution: {
          goal: "Create a module through the production Tool pipeline.",
          unresolved: [],
          nextAction: "PLAN_B: read the created file back",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 5) {
      this.consume(input, "plan-2", ["SUCCEEDED"]);
      this.requirePlanSays(input, "PLAN_B");
      yield* toolCall("read-back", "read_file", { path: "greeting.mjs" });
      yield finish("TOOL_CALLS");
      return;
    }
    const { text } = this.consume(input, "read-back", ["SUCCEEDED"]);
    if (!text.includes("GREETING_SENTINEL")) {
      throw new FeedbackContractError("the created module was not readable after the patch");
    }
    yield* answer("The greeting module exists and exports greet().");
  }

  private async *failedCheckRepair(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.step += 1;
    if (this.step === 1) {
      yield* toolCall("plan-1", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "check",
            step: "Create and pass the arithmetic check.",
            status: "in_progress",
            acceptance: ["node check.mjs prints CHECK_PASSED and exits zero."],
          },
        ],
        execution: {
          goal: "Repair a failing check from its real outcome.",
          unresolved: [],
          nextAction: "PLAN_A: write check.mjs, then run it",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 2) {
      this.consume(input, "plan-1", ["SUCCEEDED"]);
      yield* toolCall("write-check", "apply_patch", { patch: FAILING_CHECK_PATCH });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 3) {
      this.consume(input, "write-check", ["SUCCEEDED"]);
      yield* toolCall("run-check-1", "exec_command", { cmd: "node check.mjs" });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 4) {
      const { text } = this.consume(input, "run-check-1", ["CHECK_FAILED"]);
      if (!text.includes("exit code 1")) {
        // The failure has to arrive as a fact the model can act on, not just as a red mark.
        throw new FeedbackContractError("the failing check did not report its exit status");
      }
      yield* toolCall("plan-2", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "check",
            step: "Create and pass the arithmetic check.",
            status: "in_progress",
            acceptance: ["node check.mjs prints CHECK_PASSED and exits zero."],
          },
        ],
        execution: {
          goal: "Repair a failing check from its real outcome.",
          unresolved: ["CHECK_FAILED: check.mjs still reports the wrong result."],
          nextAction: "PLAN_B: fix check.mjs, then run it again",
        },
      });
      yield* toolCall("fix-check", "apply_patch", { patch: PASSING_CHECK_PATCH });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 5) {
      this.consume(input, "plan-2", ["SUCCEEDED"]);
      this.requirePlanSays(input, "PLAN_B");
      this.requirePlanSays(input, "CHECK_FAILED");
      this.consume(input, "fix-check", ["SUCCEEDED"]);
      yield* toolCall("run-check-2", "exec_command", { cmd: "node check.mjs" });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 6) {
      this.consume(input, "run-check-2", ["CHECK_PASSED"]);
      yield* toolCall("plan-3", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "check",
            step: "Create and pass the arithmetic check.",
            status: "completed",
            acceptance: ["node check.mjs prints CHECK_PASSED and exits zero."],
          },
        ],
        execution: {
          goal: "Repair a failing check from its real outcome.",
          unresolved: [],
          nextAction: "PLAN_C: report the passing check",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    this.consume(input, "plan-3", ["SUCCEEDED"]);
    this.requirePlanSays(input, "PLAN_C");
    yield* answer("The check passes now; its own output says CHECK_PASSED.");
  }

  private async *postCompaction(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.step += 1;
    if (this.step === 1) {
      yield* toolCall("plan-1", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "compact",
            step: "Keep the plan and the newest failure across compaction.",
            status: "in_progress",
          },
        ],
        execution: {
          goal: "Survive a working-set compaction with the newest facts intact.",
          unresolved: [],
          nextAction: "PLAN_A: run the check",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 2) {
      this.consume(input, "plan-1", ["SUCCEEDED"]);
      yield* toolCall("run-check-1", "exec_command", { cmd: "node failing-check.mjs" });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.step === 3) {
      this.consume(input, "run-check-1", ["CHECK_FAILED"]);
      // The failure is recorded in the newest plan, which is what compaction has to preserve.
      yield* toolCall("plan-2", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "compact",
            step: "Keep the plan and the newest failure across compaction.",
            status: "in_progress",
          },
        ],
        execution: {
          goal: "Survive a working-set compaction with the newest facts intact.",
          unresolved: [`UNRESOLVED_SENTINEL: ${CHECK_FAILED_TOKEN} still fails.`],
          nextAction: "PLAN_COMPACTION: repair the newest failing check",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    const padding = PADDING_READS[this.step - 4];
    if (padding !== undefined) {
      this.consume(input, this.step === 4 ? "plan-2" : paddingCallId(this.step - 1), ["SUCCEEDED"]);
      /*
       * Reading durable workspace files is how a working set actually grows: the observations are
       * real bytes from disk, large enough to reach the pressure threshold, and small enough that
       * single-observation pruning leaves them intact.
       */
      yield* toolCall(paddingCallId(this.step), "read_file", { path: padding, limit: 400 });
      yield finish("TOOL_CALLS");
      return;
    }
    const lastPaddingStep = 3 + PADDING_READS.length;
    if (this.step === lastPaddingStep + 1) {
      this.consume(input, paddingCallId(lastPaddingStep), ["SUCCEEDED"]);
      if (this.summaryCalls === 0) {
        throw new FeedbackContractError("compaction never ran, so nothing was proven about it");
      }
      if (this.scenario === "degraded-post-compaction") {
        const sourceRef = input.request.messages
          .flatMap((message) => (typeof message.content === "string" ? [message.content] : []))
          .join("\n")
          .match(/history:v1:[^\s"\\]+/u)?.[0];
        if (sourceRef === undefined) {
          throw new FeedbackContractError("degraded checkpoint omitted a readable history ref");
        }
        yield* toolCall("degraded-history", "read_history", { sourceRef, maxBytes: 32_768 });
        yield finish("TOOL_CALLS");
        return;
      }
      // The whole point: after compaction the request still carries the accepted plan and the
      // failure it has to repair.
      this.requirePlanSays(input, "PLAN_COMPACTION");
      this.requirePlanSays(input, "UNRESOLVED_SENTINEL");
      this.requirePlanSays(input, CHECK_FAILED_TOKEN);
      yield* toolCall("read-back", "read_file", { path: PADDING_READS[0], limit: 1 });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.scenario === "degraded-post-compaction" && this.step === lastPaddingStep + 2) {
      const { text } = this.consume(input, "degraded-history", ["SUCCEEDED"]);
      if (!text.includes(CHECK_FAILED_TOKEN)) {
        throw new FeedbackContractError(
          "read_history did not restore the original failed-check fact",
        );
      }
      yield* answer("I restored the original failed-check evidence from the verified history ref.");
      return;
    }
    this.consume(input, "read-back", ["SUCCEEDED"]);
    // Compaction keeps working afterwards: the plan facts are still there one turn later.
    this.requirePlanSays(input, "PLAN_COMPACTION");
    yield* answer("The plan and the newest failure survived compaction.");
  }

  private async *historical(
    input: ApiAdapterStreamInput,
    expected: "NOT_STARTED" | "OUTCOME_UNKNOWN",
  ): AsyncGenerator<AIAdapterEvent> {
    this.step += 1;
    if (this.step === 1) {
      const { text } = this.consume(input, HISTORICAL_CALL_ID, [expected]);
      // The repaired history is the only place the model can learn what happened. Both branches read
      // it, and neither re-runs the interrupted call: one re-issues a call that provably never ran,
      // the other inspects the current state first because the outcome is unknown.
      if (expected === "NOT_STARTED") {
        if (!text.includes("may be requested again")) {
          throw new FeedbackContractError("the not-started closure did not invite a safe retry");
        }
        yield* toolCall("retry-read", "read_file", { path: "state.txt" });
        yield finish("TOOL_CALLS");
        return;
      }
      if (!text.includes("Do not blindly repeat this action")) {
        throw new FeedbackContractError(
          "the unknown-outcome closure did not warn against a replay",
        );
      }
      yield* toolCall("inspect-state", "read_file", { path: "state.txt" });
      yield finish("TOOL_CALLS");
      return;
    }
    const callId =
      this.step === 2 ? (expected === "NOT_STARTED" ? "retry-read" : "inspect-state") : undefined;
    if (callId !== undefined) {
      const { text } = this.consume(input, callId, ["SUCCEEDED"]);
      if (!text.includes("STATE_SENTINEL")) {
        throw new FeedbackContractError("the inspection did not read the current state");
      }
      yield* answer(
        expected === "NOT_STARTED"
          ? "The call that never started was re-issued against the current state."
          : "The unknown outcome was inspected before any retry.",
      );
      return;
    }
    throw new FeedbackContractError("the scenario advanced past its final step");
  }

  /**
   * Read the one Tool result for `callId`, and refuse anything the step did not expect.
   *
   * ```text
   * zero results      the model never saw the feedback it is about to act on
   * two results       the same call was answered twice
   * other call        the feedback belongs to a different request
   * ```
   */
  private consume(
    input: ApiAdapterStreamInput,
    callId: string,
    expected: readonly FeedbackObservation[],
  ): { readonly text: string; readonly observation: FeedbackObservation } {
    const matches = toolResultsFor(input, callId);
    if (matches.length !== 1) {
      throw new FeedbackContractError(
        `request ${String(this.mainRequests.length)} expected exactly one result for ${callId}, found ${String(matches.length)}`,
      );
    }
    const message = matches[0]!;
    const observation = classifyToolResult(message);
    if (!expected.includes(observation)) {
      throw new FeedbackContractError(
        `request ${String(this.mainRequests.length)} classified ${callId} as ${observation}, expected ${expected.join(" or ")}`,
      );
    }
    this.consumptions.push(
      Object.freeze({
        request: this.mainRequests.length,
        consumedCallId: callId,
        observation,
        ...(this.planRevision === undefined ? {} : { planRevision: this.planRevision }),
      }),
    );
    return { text: resultText(message), observation };
  }

  /** The plan block must carry this fact, or the step is acting on a stale or missing projection. */
  private requirePlanSays(input: ApiAdapterStreamInput, sentinel: string): void {
    const serialized = JSON.stringify(input.request.messages);
    const revision = /revision=([A-Za-z0-9._:-]+)/u.exec(serialized)?.[1];
    if (revision !== undefined) this.planRevision = revision;
    if (!serialized.includes(sentinel)) {
      throw new FeedbackContractError(
        `request ${String(this.mainRequests.length)} lost the plan fact ${sentinel}`,
      );
    }
  }
}

const HISTORICAL_CALL_ID = "interrupted-call";
/** The only Tool whose output can carry a check verdict. */
const CHECK_TOOL_NAME = "exec_command";
/**
 * The durable files the compaction scenario reads, in order.
 *
 * Five reads of a bounded size, rather than one huge read: each observation stays below the
 * single-observation projection cap, so what the request carries is the real file rather than a
 * pruned summary of it.
 */
export const PADDING_READS = Object.freeze([
  "padding-1.txt",
  "padding-2.txt",
  "padding-3.txt",
  "padding-4.txt",
  "padding-5.txt",
] as const);

function paddingCallId(step: number): string {
  return `pad-${String(step - 3)}`;
}

function isCompactionRequest(input: ApiAdapterStreamInput): boolean {
  if ((input.request.tools?.length ?? 0) === 0) return true;
  if (input.request.toolChoice?.type === "NONE") return true;
  return input.request.messages.some((message) =>
    JSON.stringify(message).includes("Compaction semantic source JSON"),
  );
}

function toolResultsFor(
  input: ApiAdapterStreamInput,
  callId: string,
): readonly AIToolResultMessage[] {
  const matches: AIToolResultMessage[] = [];
  for (const message of input.request.messages as readonly AIConversationMessage[]) {
    if (message.role === "tool" && message.toolCallId === callId) matches.push(message);
  }
  return matches;
}

function resultText(message: AIToolResultMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function classifyToolResult(message: AIToolResultMessage): FeedbackObservation {
  const text = resultText(message);
  if (text.includes(NOT_STARTED_MARKER)) return "NOT_STARTED";
  if (text.includes(OUTCOME_UNKNOWN_MARKER)) return "OUTCOME_UNKNOWN";
  if (text.includes(CANCELLED_MARKER)) return "CANCELLED";
  /*
   * A check's verdict is a fact only when a command produced it. `update_plan` echoes back the
   * acceptance criteria it was given, and those quote the marker the check prints — reading that echo
   * as a verdict would let a plan that *mentions* success pass for a check that *reported* it.
   */
  if (message.toolName === CHECK_TOOL_NAME) {
    if (text.includes(CHECK_PASSED_MARKER)) return "CHECK_PASSED";
    if (text.includes(CHECK_FAILED_MARKER)) return "CHECK_FAILED";
  }
  return message.isError ? "REJECTED" : "SUCCEEDED";
}

const GREETING_PATCH = [
  "*** Begin Patch",
  "*** Add File: greeting.mjs",
  "+export function greet(name) {",
  "+  return `GREETING_SENTINEL hello ${String(name)}`;",
  "+}",
  "*** End Patch",
].join("\n");

const FAILING_CHECK_PATCH = [
  "*** Begin Patch",
  "*** Add File: check.mjs",
  '+process.stdout.write("CHECK_FAILED: 6 * 7 was not computed\\n");',
  "+process.exitCode = 1;",
  "*** End Patch",
].join("\n");

const PASSING_CHECK_PATCH = [
  "*** Begin Patch",
  "*** Update File: check.mjs",
  "@@",
  '-process.stdout.write("CHECK_FAILED: 6 * 7 was not computed\\n");',
  "-process.exitCode = 1;",
  '+process.stdout.write("CHECK_PASSED: " + String(6 * 7) + "\\n");',
  "*** End Patch",
].join("\n");
