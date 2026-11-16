const HOST_PATH = /(?:[A-Za-z]:[\\/]{1,2}|\\\\[^\s\\/]+[\\/]|\/(?:Users|home|root|var|etc|opt|tmp)\/)/;

/** Apply the Context's existing credential redaction and host-path rejection to model input text. */
export function safeContextText(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
  return HOST_PATH.test(redacted) ? "[REDACTED:HOST_PATH]" : redacted;
}
