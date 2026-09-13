import { describeValue } from "../../internal/assertions.js";
import { isReasoningLevel } from "../../reasoning/reasoning-level.js";
import type { JsonObject } from "../../json/json-value.js";
import type { ReasoningLevel } from "../../reasoning/reasoning-level.js";

/**
 * The adapter-private metadata namespace for the Anthropic Messages dialect.
 *
 * Protocol differences are *data*, never code: whether a model can think, whether
 * thinking can be turned off, how a semantic reasoning level is spelled natively,
 * and which authentication scheme a proxy expects are all declared here. Nothing
 * in this file inspects a provider id or a model name, because
 * `provider != model != api dialect` is exactly the separation this adapter has to
 * demonstrate.
 *
 * `ModelDescriptor.adapterMetadata` is also scanned for credential-bearing keys by
 * the frozen descriptor contract, so this namespace can never carry a secret.
 */
export const ANTHROPIC_MESSAGES_METADATA_NAMESPACE = "anthropicMessages";

/**
 * Everything the dialect needs to know about one model, all optional.
 *
 * The parser is deliberately tolerant at the field level and strict at the type
 * level: an unknown sibling key is a metadata typo that would silently change
 * behaviour, so it is rejected; a missing key simply means "no information".
 */
export interface AnthropicMessagesModelMetadata {
  /** Native extended thinking, as declared for this model. */
  readonly thinking?: AnthropicThinkingMetadata;
}

/** Native extended-thinking support for one model. */
export interface AnthropicThinkingMetadata {
  /** Whether this model can produce native thinking at all. */
  readonly supported: boolean;
  /**
   * Whether thinking is on unless it is explicitly disabled.
   *
   * A model that always thinks cannot be combined with tools under the frozen V2
   * message contract, because the opaque continuation blocks cannot be replayed.
   */
  readonly defaultEnabled: boolean;
  /** Whether an explicit `{"type": "disabled"}` is honoured. */
  readonly disableSupported: boolean;
  /**
   * Which native display mode to request.
   *
   * `summarized` is the only mode that produces the showable text the frozen
   * `reasoning.summary.delta` event carries. `omitted` means the provider returns
   * thinking blocks whose text must not be published.
   */
  readonly display?: "summarized" | "omitted";
  /**
   * The native thinking budget for each semantic reasoning level.
   *
   * There is no built-in default: a level without an explicit budget is a
   * configuration defect, and the adapter fails closed rather than inventing a
   * number. `OFF` is never mapped here, because `OFF` means "do not think".
   */
  readonly budgetTokensByLevel?: Partial<Record<ReasoningLevel, number>>;
  /**
   * The native `output_config.effort` value for each semantic reasoning level.
   *
   * Like the budget map, this is explicit per model and has no built-in default: a
   * level that the metadata does not map is a configuration defect rather than
   * something the adapter guesses, and `MINIMAL -> low` must never become a
   * repository-wide assumption about every model.
   */
  readonly effortByLevel?: Partial<Record<ReasoningLevel, string>>;
  /**
   * Whether the native protocol tolerates a caller-supplied `temperature` while
   * thinking is enabled.
   *
   * The native protocol rejects a modified temperature together with extended
   * thinking. When this is not explicitly `true`, a request that combines thinking
   * with a temperature fails closed instead of silently dropping the caller's
   * value.
   */
  readonly temperatureWithThinking?: boolean;
}

/**
 * The adapter-private provider compatibility namespace for this dialect.
 *
 * It lives in `AIProviderBinding.compatibility`, which is a `JsonObject`, so the
 * frozen `AIProviderBinding` contract never grows a provider-native field.
 */
export const ANTHROPIC_MESSAGES_COMPATIBILITY_NAMESPACE = "anthropicMessages";

/** The provider-level transport shape this dialect understands. */
export interface AnthropicMessagesConnectionMetadata {
  /**
   * Where the Messages endpoint lives below the configured endpoint.
   *
   * It is only consulted when the endpoint has a non-root path that cannot be
   * interpreted unambiguously, so a proxy with a custom path is configured rather
   * than guessed.
   */
  readonly messagesPath?: string;
  /**
   * Which credential scheme this connection uses.
   *
   * `api-key` is the direct Anthropic semantic (`x-api-key`). `bearer` is the
   * explicit opt-in for a gateway that expects `Authorization: Bearer`. It is
   * never inferred.
   */
  readonly authMode?: "api-key" | "bearer";
}

/**
 * Parse the adapter-private model metadata.
 *
 * Returns `undefined` when the namespace is absent, and throws a `TypeError` — a
 * host configuration defect, not an invocation failure — when it is present but
 * malformed.
 */
export function parseAnthropicMessagesModelMetadata(
  adapterMetadata: JsonObject | undefined,
): AnthropicMessagesModelMetadata | undefined {
  const namespace = adapterMetadata?.[ANTHROPIC_MESSAGES_METADATA_NAMESPACE];
  if (namespace === undefined) return undefined;

  const record = requireRecord(
    namespace,
    `Model descriptor adapterMetadata.${ANTHROPIC_MESSAGES_METADATA_NAMESPACE}`,
  );
  assertKnownKeys(
    record,
    ["thinking"],
    `Model descriptor adapterMetadata.${ANTHROPIC_MESSAGES_METADATA_NAMESPACE}`,
  );

  const thinking = record["thinking"];
  if (thinking === undefined) return {};
  return { thinking: parseThinkingMetadata(thinking) };
}

/**
 * Parse the adapter-private provider compatibility metadata.
 *
 * The same namespace key carries both model metadata and connection metadata, but
 * they are read from two different frozen contracts and are therefore parsed by two
 * different functions. A descriptor can never configure an endpoint, and a binding
 * can never configure thinking.
 */
export function parseAnthropicMessagesConnectionMetadata(
  compatibility: JsonObject | undefined,
): AnthropicMessagesConnectionMetadata {
  const namespace = compatibility?.[ANTHROPIC_MESSAGES_COMPATIBILITY_NAMESPACE];
  if (namespace === undefined) return {};

  const record = requireRecord(
    namespace,
    `AI provider binding compatibility.${ANTHROPIC_MESSAGES_COMPATIBILITY_NAMESPACE}`,
  );
  assertKnownKeys(
    record,
    ["messagesPath", "authMode"],
    `AI provider binding compatibility.${ANTHROPIC_MESSAGES_COMPATIBILITY_NAMESPACE}`,
  );

  const messagesPath = record["messagesPath"];
  if (messagesPath !== undefined && typeof messagesPath !== "string") {
    throw new TypeError(
      `${label("messagesPath")} must be a string, received ${describeValue(messagesPath)}.`,
    );
  }

  const authMode = record["authMode"];
  if (authMode !== undefined && authMode !== "api-key" && authMode !== "bearer") {
    throw new TypeError(
      `${label("authMode")} must be "api-key" or "bearer", received ${describeValue(authMode)}.`,
    );
  }

  return {
    ...(messagesPath === undefined ? {} : { messagesPath }),
    ...(authMode === undefined ? {} : { authMode }),
  };
}

function parseThinkingMetadata(value: unknown): AnthropicThinkingMetadata {
  const record = requireRecord(value, label("thinking"));
  assertKnownKeys(
    record,
    [
      "supported",
      "defaultEnabled",
      "disableSupported",
      "display",
      "budgetTokensByLevel",
      "effortByLevel",
      "temperatureWithThinking",
    ],
    label("thinking"),
  );

  const supported = requireBoolean(record["supported"], label("thinking.supported"));
  const defaultEnabled = requireBoolean(record["defaultEnabled"], label("thinking.defaultEnabled"));
  const disableSupported = requireBoolean(
    record["disableSupported"],
    label("thinking.disableSupported"),
  );

  const display = record["display"];
  if (display !== undefined && display !== "summarized" && display !== "omitted") {
    throw new TypeError(
      `${label("thinking.display")} must be "summarized" or "omitted", received ${describeValue(display)}.`,
    );
  }

  const temperatureWithThinking = record["temperatureWithThinking"];
  if (temperatureWithThinking !== undefined && typeof temperatureWithThinking !== "boolean") {
    throw new TypeError(
      `${label("thinking.temperatureWithThinking")} must be a boolean, received ${describeValue(temperatureWithThinking)}.`,
    );
  }

  const budgetTokensByLevel = parseBudgetMap(record["budgetTokensByLevel"]);
  const effortByLevel = parseEffortMap(record["effortByLevel"]);

  return {
    supported,
    defaultEnabled,
    disableSupported,
    ...(display === undefined ? {} : { display }),
    ...(budgetTokensByLevel === undefined ? {} : { budgetTokensByLevel }),
    ...(effortByLevel === undefined ? {} : { effortByLevel }),
    ...(temperatureWithThinking === undefined ? {} : { temperatureWithThinking }),
  };
}

function parseEffortMap(value: unknown): Partial<Record<ReasoningLevel, string>> | undefined {
  if (value === undefined) return undefined;

  const record = requireRecord(value, label("thinking.effortByLevel"));
  const efforts: Partial<Record<ReasoningLevel, string>> = {};

  for (const [key, effort] of Object.entries(record)) {
    if (!isReasoningLevel(key) || key === "OFF") {
      throw new TypeError(
        `${label("thinking.effortByLevel")} has an unknown level "${key}"; only MINIMAL, LOW, MEDIUM, HIGH and XHIGH can carry a native effort.`,
      );
    }
    if (typeof effort !== "string" || effort.length === 0) {
      throw new TypeError(
        `${label(`thinking.effortByLevel.${key}`)} must be a non-empty string, received ${describeValue(effort)}.`,
      );
    }
    efforts[key] = effort;
  }

  return efforts;
}

function parseBudgetMap(value: unknown): Partial<Record<ReasoningLevel, number>> | undefined {
  if (value === undefined) return undefined;

  const record = requireRecord(value, label("thinking.budgetTokensByLevel"));
  const budgets: Partial<Record<ReasoningLevel, number>> = {};

  for (const [key, budget] of Object.entries(record)) {
    if (!isReasoningLevel(key) || key === "OFF") {
      throw new TypeError(
        `${label("thinking.budgetTokensByLevel")} has an unknown level "${key}"; only MINIMAL, LOW, MEDIUM, HIGH and XHIGH can carry a native budget.`,
      );
    }
    if (!Number.isSafeInteger(budget) || (budget as number) <= 0) {
      throw new TypeError(
        `${label(`thinking.budgetTokensByLevel.${key}`)} must be a positive safe integer, received ${describeValue(budget)}.`,
      );
    }
    budgets[key] = budget as number;
  }

  return budgets;
}

function label(field: string): string {
  return `AI adapter metadata ${ANTHROPIC_MESSAGES_METADATA_NAMESPACE}.${field}`;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object, received ${describeValue(value)}.`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean, received ${describeValue(value)}.`);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      throw new TypeError(`${field} has an unknown field "${key}".`);
    }
  }
}
