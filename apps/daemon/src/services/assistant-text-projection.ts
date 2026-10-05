import { redactText } from "@caelush/security";

/** Public assistant text stays within the presentation contract and secret-scanner budget. */
export const MAX_PUBLIC_ASSISTANT_TEXT_BYTES = 64 * 1024;

const TRUNCATION_MARKER = "\n… [内容已截断]";

export function projectPublicAssistantText(text: string): string {
  const redacted = redactText(text);
  if (Buffer.byteLength(redacted, "utf8") <= MAX_PUBLIC_ASSISTANT_TEXT_BYTES) return redacted;

  const prefixBudget =
    MAX_PUBLIC_ASSISTANT_TEXT_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let prefix = "";
  let prefixBytes = 0;
  for (const character of redacted) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + characterBytes > prefixBudget) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${TRUNCATION_MARKER}`;
}
