/**
 * A minimal, dependency-free SSE parser for the Anthropic Messages event stream.
 *
 * The browser `EventSource` cannot be used at all here: this dialect needs a POST
 * with custom headers and a JSON body, which `EventSource` does not support. The
 * parser therefore reads `Response.body` directly and implements the small part of
 * the Server-Sent Events grammar this dialect uses.
 *
 * It deliberately handles the transport realities a chunked body creates:
 *
 * ```text
 * LF and CRLF line endings
 * `event:` and `data:` fields
 * multi-line `data:` joined with "\n"
 * a blank line as the event delimiter
 * comment lines beginning with ":"
 * a field split across two network chunks
 * ```
 *
 * Parsing is pure: it never inspects a provider payload's meaning, so an unparsable
 * event is the stream translator's problem, not the parser's.
 */

/** One parsed SSE event. */
export interface ServerSentEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * An incremental SSE parser.
 *
 * Feed it decoded text as it arrives and it emits every complete event; call
 * {@link ServerSentEventParser.end} once the body ends to emit a final event that
 * was not terminated by a blank line.
 */
export interface ServerSentEventParser {
  push(chunk: string): readonly ServerSentEvent[];
  end(): readonly ServerSentEvent[];
}

/** Create an incremental SSE parser. */
export function createServerSentEventParser(
  options: { readonly maxEventBytes?: number } = {},
): ServerSentEventParser {
  const maxEventBytes = options.maxEventBytes ?? 1_048_576;
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let dataBytes = 0;

  const flush = (): ServerSentEvent | undefined => {
    if (dataLines.length === 0 && eventName === undefined) return undefined;
    const event: ServerSentEvent = {
      event: eventName,
      data: dataLines.join("\n"),
    };
    eventName = undefined;
    dataLines = [];
    dataBytes = 0;
    return event;
  };

  const parseLine = (line: string): ServerSentEvent | undefined => {
    // A comment line is a keep-alive or a diagnostic; it is never an event.
    if (line.startsWith(":")) return undefined;
    if (line.length === 0) return flush();

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    // A single leading space after the colon is part of the grammar, not the value.
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      eventName = value;
      return undefined;
    }
    if (field === "data") {
      dataBytes += value.length;
      if (dataBytes > maxEventBytes) {
        // An unbounded event is a hostile or broken provider, not a big message.
        throw new RangeError("Server-sent event exceeded the maximum size.");
      }
      dataLines.push(value);
      return undefined;
    }
    // `id:` and `retry:` are transport-level fields this dialect does not use.
    return undefined;
  };

  return {
    push(chunk: string): readonly ServerSentEvent[] {
      buffer += chunk;
      const events: ServerSentEvent[] = [];

      while (true) {
        const breakIndex = findLineBreak(buffer);
        if (breakIndex === undefined) break;
        const line = buffer.slice(0, breakIndex.index);
        buffer = buffer.slice(breakIndex.index + breakIndex.length);
        const event = parseLine(line);
        if (event !== undefined) events.push(event);
      }

      return events;
    },

    end(): readonly ServerSentEvent[] {
      const events: ServerSentEvent[] = [];

      // A final line without a terminating newline is still a line.
      if (buffer.length > 0) {
        const line = buffer;
        buffer = "";
        const event = parseLine(line);
        if (event !== undefined) events.push(event);
      }

      const trailing = flush();
      if (trailing !== undefined) events.push(trailing);
      return events;
    },
  };
}

function findLineBreak(
  text: string,
): { readonly index: number; readonly length: number } | undefined {
  const lf = text.indexOf("\n");
  if (lf === -1) return undefined;
  // CRLF is one break, not two: an empty line between events must stay empty.
  if (lf > 0 && text[lf - 1] === "\r") return { index: lf - 1, length: 2 };
  return { index: lf, length: 1 };
}
