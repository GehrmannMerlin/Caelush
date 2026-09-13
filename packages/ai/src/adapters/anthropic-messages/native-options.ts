import { createAIError } from "../../errors/ai-error.js";
import type { AnthropicMessagesModelMetadata } from "./adapter-metadata.js";
import type { AIToolChoice } from "../../request/tool-choice.js";
import type { CacheRetention } from "../../cache/cache-retention.js";
import type { ModelRef } from "../../models/model-ref.js";
import type { ReasoningLevel } from "../../reasoning/reasoning-level.js";
import type { ResolvedAIModelRequest } from "../../request/resolved-model-request.js";

/** The native extended-thinking configuration. */
export type AnthropicThinking =
  | {
      readonly type: "enabled";
      readonly budget_tokens: number;
      readonly display?: "summarized" | "omitted";
    }
  | { readonly type: "disabled" };

/** The native output configuration this dialect understands. */
export interface AnthropicOutputConfig {
  readonly effort?: string;
}

/**
 * The dialect-private resolution of reasoning, thinking and caching for one turn.
 *
 * It states what will be sent natively *and* what the adapter decided about
 * `reasoning.summary.delta`: the transcript sink is only fed when the native
 * protocol is asked for a showable summary.
 */
export interface AnthropicNativeOptions {
  readonly thinking?: AnthropicThinking;
  /** The native `output_config` for this turn, when the metadata declares one. */
  readonly outputConfig?: AnthropicOutputConfig;
  /** The native cache marker to attach at the fixed tail position. */
  readonly cacheControl?: { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" };
  /** Whether native thinking is enabled for this turn. */
  readonly thinkingEnabled: boolean;
  /** Whether showable reasoning summaries are expected from the provider. */
  readonly summaryRequested: boolean;
}

/**
 * Resolve the native reasoning/thinking/cache options for one prepared turn.
 *
 * This is the single place where the frozen fail-closed rules for extended thinking
 * live, and none of them inspect a provider id or a model name:
 *
 * ```text
 * tools + effective reasoning != OFF
 *     -> AI_CAPABILITY_UNSUPPORTED
 *        The native protocol requires the assistant's opaque thinking blocks to be
 *        replayed across a tool continuation, and the frozen `AIMessage` contract
 *        has no safe place to carry them. Claiming support would be a lie.
 *
 * tools + reasoning not explicitly requested + thinking cannot be disabled
 *     -> AI_CAPABILITY_UNSUPPORTED
 *
 * tools + reasoning not explicitly requested + thinking can be disabled
 *     -> send {"type":"disabled"} and run the tool call
 *
 * tools + reasoning not explicitly requested + thinking is not on by default
 *     -> send nothing and run the tool call
 *
 * thinking enabled + caller temperature
 *     -> AI_CAPABILITY_UNSUPPORTED unless the model metadata explicitly allows it
 *
 * thinking enabled + toolChoice REQUIRED/TOOL
 *     -> AI_CAPABILITY_UNSUPPORTED (the native protocol forbids forcing tool use)
 * ```
 */
export function resolveAnthropicNativeOptions(
  metadata: AnthropicMessagesModelMetadata | undefined,
  request: ResolvedAIModelRequest,
  toolsDeclared: boolean,
): AnthropicNativeOptions {
  const model = request.model.ref;
  const thinking = metadata?.thinking;
  const effective = request.settings.reasoning.effective;
  const explicitlyRequested = request.settings.reasoning.requested !== undefined;

  const thinkingActive = isThinkingActive(effective, thinking);
  const cacheControl = resolveCacheControl(request.settings.cache.effective);

  if (toolsDeclared) {
    if (effective !== undefined && effective !== "OFF") {
      throw unsupported(
        `The Anthropic Messages dialect cannot combine tool calling with the effective reasoning level "${effective}": the native protocol requires the assistant's opaque thinking blocks to be replayed across a tool continuation, and the frozen AI message contract has no safe place to carry them.`,
        model,
      );
    }

    if (thinkingActive) {
      throw unsupported(
        `The Anthropic Messages dialect cannot run tool calling for model "${model.model}" because native thinking is always on and cannot be disabled.`,
        model,
      );
    }

    // The model may think by default. When the dialect is allowed to turn it off,
    // it says so explicitly rather than hoping the provider's default is off.
    if (thinking?.supported === true && thinking.defaultEnabled === true) {
      if (thinking.disableSupported !== true) {
        throw unsupported(
          `The Anthropic Messages dialect cannot run tool calling for model "${model.model}" because native thinking defaults to enabled and the model metadata does not declare it as safely disableable.`,
          model,
        );
      }
      return {
        thinking: { type: "disabled" },
        thinkingEnabled: false,
        summaryRequested: false,
        ...(cacheControl === undefined ? {} : { cacheControl }),
      };
    }

    if (!explicitlyRequested) {
      return {
        thinkingEnabled: false,
        summaryRequested: false,
        ...(cacheControl === undefined ? {} : { cacheControl }),
      };
    }

    // An explicitly requested non-OFF level was already rejected above, so this is
    // an explicit `OFF`: nothing to express natively.
    return {
      thinkingEnabled: false,
      summaryRequested: false,
      ...(cacheControl === undefined ? {} : { cacheControl }),
    };
  }

  // No tools: a text-only turn may use native thinking.
  if (effective === undefined || effective === "OFF") {
    if (effective === "OFF" && thinking?.supported === true && thinking.defaultEnabled === true) {
      if (thinking.disableSupported !== true) {
        throw unsupported(
          `The Anthropic Messages dialect cannot disable native thinking for model "${model.model}", but the caller requested reasoning OFF.`,
          model,
        );
      }
      return {
        thinking: { type: "disabled" },
        thinkingEnabled: false,
        summaryRequested: false,
        ...(cacheControl === undefined ? {} : { cacheControl }),
      };
    }
    return {
      thinkingEnabled: false,
      summaryRequested: false,
      ...(cacheControl === undefined ? {} : { cacheControl }),
    };
  }

  // A non-OFF level needs a native thinking configuration the metadata declares.
  if (thinking?.supported !== true) {
    if (explicitlyRequested) {
      throw unsupported(
        `The Anthropic Messages dialect has no native thinking configuration for model "${model.model}", so the requested reasoning level "${effective}" cannot be applied.`,
        model,
      );
    }
    // The model's own default stands: the caller never asked for a level, and the
    // dialect has nothing truthful to translate.
    return {
      thinkingEnabled: false,
      summaryRequested: false,
      ...(cacheControl === undefined ? {} : { cacheControl }),
    };
  }

  const budget = thinking.budgetTokensByLevel?.[effective];
  if (budget === undefined) {
    throw unsupported(
      `The Anthropic Messages dialect has no native thinking budget for the effective reasoning level "${effective}" on model "${model.model}".`,
      model,
    );
  }

  const effort = thinking.effortByLevel?.[effective];
  if (effort === undefined) {
    throw unsupported(
      `The Anthropic Messages dialect has no native output effort for the effective reasoning level "${effective}" on model "${model.model}".`,
      model,
    );
  }

  if (request.settings.temperature !== undefined && thinking.temperatureWithThinking !== true) {
    throw unsupported(
      `The Anthropic Messages dialect cannot send temperature together with native thinking for model "${model.model}", and the model metadata does not declare that combination as supported.`,
      model,
    );
  }

  assertToolChoiceCompatibleWithThinking(request.toolChoice, model);

  const display = thinking.display ?? "omitted";
  const summaryRequested = display === "summarized";

  return {
    thinking: {
      type: "enabled",
      budget_tokens: budget,
      display,
    },
    outputConfig: { effort },
    thinkingEnabled: true,
    summaryRequested,
    ...(cacheControl === undefined ? {} : { cacheControl }),
  };
}

/**
 * The native protocol forbids forcing tool use while extended thinking is enabled.
 *
 * This is a real protocol constraint, so the adapter surfaces it instead of
 * downgrading the caller's `REQUIRED`/`TOOL` choice to `auto`.
 */
function assertToolChoiceCompatibleWithThinking(
  choice: AIToolChoice | undefined,
  model: ModelRef,
): void {
  if (choice === undefined || choice.type === "AUTO" || choice.type === "NONE") return;
  throw unsupported(
    `The Anthropic Messages dialect cannot force tool use ("${choice.type}") while native thinking is enabled.`,
    model,
  );
}

/**
 * Whether native thinking is on for this turn without the adapter asking.
 *
 * `defaultEnabled` is the only authority. It is metadata, so no model name is ever
 * inspected to decide it.
 */
function isThinkingActive(
  effective: ReasoningLevel | undefined,
  thinking: AnthropicMessagesModelMetadata["thinking"],
): boolean {
  if (thinking?.defaultEnabled !== true) return false;
  if (thinking.disableSupported === true && effective === "OFF") return false;
  return true;
}

/** Map the resolved cache retention onto the native cache marker. */
function resolveCacheControl(
  retention: CacheRetention,
): { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" } | undefined {
  switch (retention) {
    case "NONE":
      return undefined;
    case "SHORT":
      return { type: "ephemeral" };
    case "LONG":
      return { type: "ephemeral", ttl: "1h" };
  }
}

function unsupported(message: string, model: ModelRef) {
  return createAIError("AI_CAPABILITY_UNSUPPORTED", message, {
    providerId: model.provider,
    model,
  });
}
