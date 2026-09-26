import type { ContextSourceInput, ContextSourceProvider } from "./context-source.js";
import { createSourceResult, createSourceTextItem } from "./generic-provider-helpers.js";
import { AGENT_CONTEXT_SOURCE_IDS } from "./source-ids.js";

const PROVIDER_ID = AGENT_CONTEXT_SOURCE_IDS.corePolicy;
const PROVIDER_VERSION = "core-policy-v1";
const MAX_POLICY_BYTES = 64 * 1024;

export interface CorePolicyContextSourceProviderOptions {
  readonly text: string;
  readonly version?: string;
}

/**
 * The host's canonical base instruction as an ordinary, pinned ContextItem.
 *
 * The Agent kernel does not know what a coding host's system prompt means. It only
 * preserves the generic CORE_POLICY item and lets the document builder place it in
 * the stable system block. The small redaction pass keeps a misconfigured host from
 * copying an obvious credential into an audit-facing Context source.
 */
export function createCorePolicyContextSourceProvider(
  options: CorePolicyContextSourceProviderOptions,
): ContextSourceProvider {
  const text = redactAndBound(options.text);
  const version = options.version ?? PROVIDER_VERSION;
  return Object.freeze({
    id: PROVIDER_ID,
    async collect(input: ContextSourceInput) {
      void input;
      return createSourceResult(PROVIDER_ID, version, [
        createSourceTextItem({
          id: "agent.core-policy:canonical",
          providerId: PROVIDER_ID,
          sourceRef: "core-policy:canonical",
          version,
          type: "agent.core-policy",
          scope: "GLOBAL",
          retention: "PINNED",
          priorityClass: "CRITICAL",
          tokenEstimate: Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3)),
          cacheStability: "STABLE",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          whyLoaded: "canonical host core policy",
          text,
        }),
      ]);
    },
  });
}

export { PROVIDER_ID as CORE_POLICY_CONTEXT_SOURCE_ID };

function redactAndBound(value: string): string {
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError("Core policy text must be non-empty and NUL-free.");
  }
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
  if (new TextEncoder().encode(redacted).byteLength > MAX_POLICY_BYTES) {
    throw new TypeError("Core policy text exceeds its bounded contract.");
  }
  return redacted;
}
