import type { AIMessage, AIModelSettings, AIToolSpec, ModelDescriptor } from "@caelush/ai";

import type { AgentLoop } from "../loop/agent-loop.js";
import type { AgentExecutionIdentity, AgentTurnRef } from "../loop/types.js";
import type { RunExecutionDirective } from "./directive.js";
import type { RunExecutionEffectResult } from "./effect-result.js";
import type { CompletionGate } from "./ports/completion-gate.js";
import type { ToolTurnCoordinator } from "./ports/tool-turn.js";

/**
 * The durable Run execution driver.
 *
 * ```text
 * RunExecutionDriver = execute exactly one typed effect
 * ```
 *
 * The driver performs the work a directive names and reports a typed result. It is deliberately
 * narrow in three directions:
 *
 * ```text
 * it writes no Run status       only the RunController commits a lifecycle transition
 * it owns no retry policy       it reports what happened; the Run Layer decides what it means
 * it never loops a Run          it executes one effect per call and returns
 * ```
 *
 * What each directive means for the driver:
 *
 * ```text
 * ADVANCE_AGENT        one model turn through the frozen AgentLoop.advance()
 * EXECUTE_TOOL_BATCH   one Tool batch turn through the Tool turn coordinator
 * EVALUATE_COMPLETION  one completion evaluation of an existing candidate
 * SUSPEND / FINALIZE / RETURN_TERMINAL
 *                      nothing to execute: the RunController owns what happens next
 * ```
 *
 * `ADVANCE_AGENT` and `EXECUTE_TOOL_BATCH` are driven for real: Phase 3C wired the Agent path and
 * Phase 3D wired the Tool path through a run-scoped `ToolTurnCoordinator`. `EVALUATE_COMPLETION`
 * remains generic and driven entirely by its port; its production adapter is Phase 3E work.
 */
export interface RunExecutionDriverDependencies {
  readonly agentLoop: AgentLoop;
  readonly toolTurns: ToolTurnCoordinator;
  readonly completionGate: CompletionGate;
}

export interface RunExecutionDriver {
  execute(
    directive: RunExecutionDirective,
    context: RunExecutionEffectContext,
  ): Promise<RunExecutionEffectResult>;
}

/**
 * The context one effect is executed in.
 *
 * It is everything a general Reason needs and nothing a host knows: an identity, the allocated
 * turn, the history it reasons from, the resolved model, the Tool catalog, the model settings and
 * the caller's cancellation signal.
 *
 * Deliberately absent: a workspace, a Runtime, a Git state, a project inspector, a verification
 * plan or a coding Tool registry. A driver that could see those would be a coding agent wearing a
 * general Run Layer's name, and the Agent Loop it drives would inherit the same knowledge through
 * the context it was handed.
 */
export interface RunExecutionEffectContext {
  readonly identity: AgentExecutionIdentity;
  /**
   * The durable turn this effect runs as.
   *
   * The Run Layer allocated the Step before the effect began, so the driver forwards a real
   * `AgentTurnRef` rather than inventing one. A durable boundary commits against it.
   */
  readonly turn: AgentTurnRef;
  readonly history: readonly AIMessage[];
  readonly model: ModelDescriptor;
  readonly tools: readonly AIToolSpec[];
  readonly modelSettings?: AIModelSettings | undefined;
  /**
   * The caller's cancellation signal.
   *
   * The driver never creates an abort scope, never owns a timeout and never reads a deadline: it
   * forwards this signal unchanged, and Run cancellation stays a Run Layer authority.
   */
  readonly signal: AbortSignal;
}

/** Create the frozen driver over its three ports. */
export function createRunExecutionDriver(
  dependencies: RunExecutionDriverDependencies,
): RunExecutionDriver {
  return {
    async execute(
      directive: RunExecutionDirective,
      context: RunExecutionEffectContext,
    ): Promise<RunExecutionEffectResult> {
      switch (directive.kind) {
        case "ADVANCE_AGENT": {
          // The directive already carries the turn input; the driver supplies the execution
          // context. Nothing is re-derived from the Run, so the Reason the coordinator decided on
          // is the Reason that runs.
          const result = await dependencies.agentLoop.advance({
            identity: context.identity,
            turn: context.turn,
            history: context.history,
            input: directive.input,
            model: context.model,
            tools: context.tools,
            ...(context.modelSettings === undefined
              ? {}
              : { modelSettings: context.modelSettings }),
            signal: context.signal,
          });
          return { kind: "AGENT", result };
        }
        case "EXECUTE_TOOL_BATCH": {
          const result = await dependencies.toolTurns.execute({
            mode: directive.mode,
            sourceStepId: directive.sourceStepId,
            pendingDecision: directive.pendingDecision,
            ...(directive.observationPolicy === undefined
              ? {}
              : { observationPolicy: directive.observationPolicy }),
            signal: context.signal,
          });
          return { kind: "TOOLS", result };
        }
        case "EVALUATE_COMPLETION": {
          const result = await dependencies.completionGate.evaluate({
            // The identity comes from the execution context, which is the only place the Run the
            // effect runs for is known. A gate that produced durable evidence without it would
            // have to invent one.
            identity: context.identity,
            mode: directive.mode,
            sourceStepId: directive.sourceStepId,
            candidate: directive.candidate,
            signal: context.signal,
          });
          return { kind: "COMPLETION", result };
        }
        case "SUSPEND":
        case "FINALIZE":
        case "RETURN_TERMINAL":
          // Nothing to execute. The RunController owns what happens next, and inventing an effect
          // here would hand it a state change nobody decided on.
          return { kind: "NONE" };
        default:
          return assertUnhandledDirective(directive);
      }
    },
  };
}

function assertUnhandledDirective(directive: never): never {
  throw new TypeError(
    `Unhandled Run execution directive: ${String((directive as { kind?: unknown }).kind)}.`,
  );
}
