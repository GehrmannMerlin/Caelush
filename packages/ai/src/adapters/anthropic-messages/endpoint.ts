import { createAIError } from "../../errors/ai-error.js";
import { describeValue } from "../../internal/assertions.js";
import type { AnthropicMessagesConnectionMetadata } from "./adapter-metadata.js";
import type { ModelRef } from "../../models/model-ref.js";

/** The canonical Messages path below a provider root. */
const MESSAGES_PATH = "/v1/messages";

/**
 * The resolved native request target.
 *
 * The endpoint always comes from `ResolvedProviderConnection.endpoint`, which the
 * gateway built from the provider registry. `ModelRef.baseUrl` is a legacy hint and
 * is never read here, and neither is any endpoint-shaped descriptor metadata.
 */
export interface AnthropicMessagesTarget {
  readonly url: string;
}

/**
 * Resolve the native Messages URL from the provider endpoint.
 *
 * The interpretation is deterministic and never guesses:
 *
 * ```text
 * https://api.anthropic.com          -> https://api.anthropic.com/v1/messages
 * https://api.anthropic.com/         -> https://api.anthropic.com/v1/messages
 * https://proxy.example/anthropic/   -> ambiguous -> configuration required
 * https://proxy.example/v1/messages  -> used unchanged
 * ```
 *
 * A proxy may expose Messages at any path, and a non-root path cannot be
 * distinguished from a root that merely has a suffix, so an ambiguous endpoint
 * without explicit `messagesPath` metadata is a configuration defect that fails
 * before any transport call rather than a path the adapter invents.
 *
 * Query parameters already on the endpoint are preserved, and the connection's
 * configured parameters are added without overwriting them.
 */
export function resolveAnthropicMessagesTarget(
  endpoint: string,
  metadata: AnthropicMessagesConnectionMetadata,
  queryParams: Readonly<Record<string, string>>,
  model: ModelRef,
): AnthropicMessagesTarget {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw invalidRequest(
      `AI provider endpoint for "${model.provider}" must be an absolute URL.`,
      model,
    );
  }

  const declaredPath = metadata.messagesPath;
  if (declaredPath !== undefined) {
    if (!declaredPath.startsWith("/")) {
      throw invalidRequest(
        `AI provider compatibility metadata anthropicMessages.messagesPath must start with "/", received ${describeValue(declaredPath)}.`,
        model,
      );
    }
    base.pathname = declaredPath;
  } else {
    const path = normalizePath(base.pathname);
    if (path === "" || path === "/") {
      base.pathname = MESSAGES_PATH;
    } else if (path === MESSAGES_PATH) {
      base.pathname = MESSAGES_PATH;
    } else {
      throw invalidRequest(
        `AI provider endpoint for "${model.provider}" has the non-root path "${path}", which cannot be interpreted as an Anthropic Messages endpoint unambiguously. Configure compatibility.anthropicMessages.messagesPath explicitly.`,
        model,
      );
    }
  }

  for (const [name, value] of Object.entries(queryParams)) {
    if (!base.searchParams.has(name)) base.searchParams.set(name, value);
  }

  return { url: base.href };
}

/** Drop trailing slashes so `/` and `` and `//` all compare equal. */
function normalizePath(pathname: string): string {
  let path = pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function invalidRequest(message: string, model: ModelRef) {
  return createAIError("AI_INVALID_REQUEST", message, {
    providerId: model.provider,
    model,
  });
}
