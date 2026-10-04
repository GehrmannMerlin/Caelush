/**
 * Parse a Provider `Retry-After` hint into milliseconds.
 *
 * Numeric seconds may be fractional for compatibility with existing providers. HTTP dates are
 * accepted only in the three date forms defined by HTTP, so permissive `Date.parse()` inputs such
 * as a bare year cannot accidentally become a retry instruction.
 */
export function parseRetryAfterMs(raw: string | undefined, nowMs: number): number | undefined {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;

  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const milliseconds = Math.round(Number(value) * 1_000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }

  if (!isHttpDate(value)) return undefined;
  const timestampMs = Date.parse(value);
  if (!Number.isSafeInteger(timestampMs)) return undefined;
  const delayMs = Math.max(0, timestampMs - nowMs);
  return Number.isSafeInteger(delayMs) ? delayMs : undefined;
}

function isHttpDate(value: string): boolean {
  const day = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
  const longDay = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  return (
    new RegExp(`^${day}, \\d{2} ${month} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT$`, "u").test(value) ||
    new RegExp(`^${longDay}, \\d{2}-${month}-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT$`, "u").test(
      value,
    ) ||
    new RegExp(`^${day} ${month} {1,2}\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\d{4}$`, "u").test(
      value,
    )
  );
}
