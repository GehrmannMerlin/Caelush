import { ToolRegistrationError } from "./errors.js";

export interface ToolOutputPolicy {
  readonly maxModelContentBytes: number;
}

export const DEFAULT_TOOL_OUTPUT_POLICY: ToolOutputPolicy = Object.freeze({
  maxModelContentBytes: 64 * 1024,
});

const truncationMarker = "\n[output truncated]";

export function validateToolOutputPolicy(policy: ToolOutputPolicy): ToolOutputPolicy {
  if (!Number.isSafeInteger(policy.maxModelContentBytes) || policy.maxModelContentBytes <= 0) {
    throw new ToolRegistrationError(
      "Tool output policy maxModelContentBytes must be a positive integer.",
      { reason: "INVALID_OUTPUT_POLICY" },
    );
  }
  return policy;
}

export function boundToolModelContent(
  content: string,
  policy: ToolOutputPolicy = DEFAULT_TOOL_OUTPUT_POLICY,
): string {
  validateToolOutputPolicy(policy);
  if (Buffer.byteLength(content, "utf8") <= policy.maxModelContentBytes) return content;

  const markerBytes = Buffer.byteLength(truncationMarker, "utf8");
  if (markerBytes > policy.maxModelContentBytes) {
    let prefix = "";
    for (const character of content) {
      if (Buffer.byteLength(prefix + character, "utf8") > policy.maxModelContentBytes) break;
      prefix += character;
    }
    return prefix;
  }

  const prefixBudget = policy.maxModelContentBytes - markerBytes;
  let prefix = "";
  for (const character of content) {
    if (Buffer.byteLength(prefix + character, "utf8") > prefixBudget) break;
    prefix += character;
  }
  return `${prefix}${truncationMarker}`;
}
