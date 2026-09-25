import type { AIModelSettings, AIToolSpec, ModelDescriptor } from "@caelush/ai";

import type {
  AgentExecutionIdentity,
  AgentTurnInput,
  AgentTurnRef,
  LegacyContextItem,
  PreparedModelContext,
} from "../types.js";
import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";

/**
 * The frozen Context Engine boundary.
 *
 * ```text
 * ContextEngine = what this Reason sees
 * ```
 *
 * One call prepares everything the model will be shown for exactly one turn. The loop never
 * builds context itself and never learns how it was built: it hands over the identity, the
 * turn, the durable conversation snapshot, the turn input, the resolved model, the tool catalog and the mode, and
 * receives messages plus opaque diagnostics.
 *
 * The input is deliberately narrow, and the exclusions are the point:
 *
 * ```text
 * cwd, workspace, project, git     how a coding host describes its environment
 * verification plan, runtime       other subsystems' state
 * ```
 *
 * None of those may cross into the general kernel. A coding host expresses them *inside* its
 * Context Engine implementation, and only the rendered messages and an opaque report come
 * back out.
 */
export interface ContextEnginePort {
  prepare(input: ContextPrepareInput): Promise<PreparedModelContext>;
}

/**
 * Why the context is being prepared.
 *
 * ```text
 * NORMAL            the ordinary first attempt for this turn
 * FORCED_RECOVERY   the provider rejected the context window, so the engine must compact
 * ```
 *
 * `FORCED_RECOVERY` is bounded by the loop to one extra provider attempt per turn. If that
 * attempt overflows too, the turn fails with `CONTEXT_EXHAUSTED`: a context that cannot be
 * recovered twice is not going to be recovered by a third identical try.
 *
 * An engine that cannot actually compact must **reject** a `FORCED_RECOVERY` preparation —
 * with its own context-exhaustion error — rather than resolve with a context that does not
 * fit. It must never report "recovered" through a field of its answer: the loop has no such
 * field to read, and answering with the same oversized context would spend a second provider
 * call on the very request that was just rejected. Whether a forced recovery happened is
 * recorded by the loop, in `AgentLoopContextReceipt.recovery`.
 */
export type ContextPrepareMode = "NORMAL" | "FORCED_RECOVERY";

/** Everything the Context Engine is told for one turn, and nothing more. */
export interface ContextPrepareInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  /** The validated durable conversation source for this turn. */
  readonly conversation: AgentConversationSnapshot;
  /** What this Reason is about: new user input, tool results, or a continuation. */
  readonly input: AgentTurnInput;
  /** The resolved model authority, so the engine can size its budget to it. */
  readonly model: ModelDescriptor;
  readonly tools: readonly AIToolSpec[];
  readonly mode: ContextPrepareMode;
  /** The caller's cancellation signal. Context preparation is abortable like any other work. */
  readonly signal: AbortSignal;
}

/**
 * The frozen Context Provider seam.
 *
 * A provider contributes `ContextItem`s to a turn's context. It is the extension point a host
 * uses to add knowledge — memory, project facts, a session summary — without the general loop
 * learning what that knowledge is.
 *
 * Phase 3B freezes the seam and the item contract only. It does not rewrite the Context
 * System: a legacy Context runtime is bridged by a host adapter, and the provider pipeline
 * itself is later work.
 */
export interface ContextProvider {
  readonly id: string;

  provide(input: ContextProviderInput): Promise<readonly LegacyContextItem[]>;
}

/**
 * What a provider is told.
 *
 * It receives the identity, the turn, what this Reason is about, the resolved model and the
 * signal — and nothing else.
 *
 * ```text
 * history   absent on purpose
 * ```
 *
 * The conversation is itself a context source. Handing a provider the whole durable
 * conversation would let every provider become a second conversation assembler, and the
 * consequences are all failures the engine cannot repair afterwards: duplicated history,
 * disagreement about order, providers trimming independently, and several budget authorities
 * competing over the same window. Selecting and ordering the conversation belongs to the
 * ContextEngine, which is the one component that can do it against a single budget.
 *
 * The model is authority *for reading*, never for re-resolution: a provider may consult
 * `model` to judge capabilities and adapt its content, but it must not resolve a model again,
 * change the model, change the provider, or change the API dialect. The descriptor it receives
 * is the one this turn was resolved against.
 */
export interface ContextProviderInput {
  readonly identity: AgentExecutionIdentity;

  readonly turn: AgentTurnRef;

  readonly input: AgentTurnInput;

  readonly model: ModelDescriptor;

  readonly signal: AbortSignal;
}

/**
 * Project the model settings the kernel may carry onto the frozen AI settings contract.
 *
 * `toolChoice` is deliberately absent. The frozen `AIModelSettings` has no such field, and
 * the request builder owns the default (`AUTO` when tools are present, omitted when they are
 * not), so a caller-supplied tool choice would be a second, weaker authority over the same
 * decision.
 */
export function toAIModelSettings(settings: {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}): AIModelSettings | undefined {
  if (settings.maxOutputTokens === undefined && settings.temperature === undefined) {
    return undefined;
  }
  return {
    ...(settings.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: settings.maxOutputTokens }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
  };
}
