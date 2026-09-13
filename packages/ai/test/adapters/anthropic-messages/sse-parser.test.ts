import { describe, expect, it } from "vitest";
import { createServerSentEventParser } from "../../../src/adapters/anthropic-messages/sse-parser.js";

describe("SSE parser", () => {
  it("parses a single complete event", () => {
    const parser = createServerSentEventParser();

    expect(parser.push('event: message_start\ndata: {"a":1}\n\n')).toEqual([
      { event: "message_start", data: '{"a":1}' },
    ]);
  });

  it("handles CRLF line endings", () => {
    const parser = createServerSentEventParser();

    expect(parser.push('event: ping\r\ndata: {"type":"ping"}\r\n\r\n')).toEqual([
      { event: "ping", data: '{"type":"ping"}' },
    ]);
  });

  it("does not emit an event before the blank-line delimiter arrives", () => {
    const parser = createServerSentEventParser();

    expect(parser.push('event: ping\ndata: {"type":"ping"}\n')).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "ping", data: '{"type":"ping"}' }]);
  });

  it("joins multi-line data with newlines", () => {
    const parser = createServerSentEventParser();

    expect(parser.push("data: one\ndata: two\ndata: three\n\n")).toEqual([
      { event: undefined, data: "one\ntwo\nthree" },
    ]);
  });

  it("ignores comment lines", () => {
    const parser = createServerSentEventParser();

    expect(parser.push(': keep-alive\ndata: {"x":1}\n\n')).toEqual([
      { event: undefined, data: '{"x":1}' },
    ]);
  });

  it("survives a field split across two network chunks", () => {
    const parser = createServerSentEventParser();

    expect(parser.push('event: message_delta\ndata: {"type":"mess')).toEqual([]);
    expect(parser.push('age_delta"}\n\n')).toEqual([
      { event: "message_delta", data: '{"type":"message_delta"}' },
    ]);
  });

  it("survives a delimiter split across two network chunks", () => {
    const parser = createServerSentEventParser();

    expect(parser.push('event: ping\ndata: {"type":"ping"}\n')).toEqual([]);
    expect(parser.push('\ndata: {"type":"ping2"}\n\n')).toEqual([
      { event: "ping", data: '{"type":"ping"}' },
      { event: undefined, data: '{"type":"ping2"}' },
    ]);
  });

  it("handles a CRLF pair split across two network chunks", () => {
    const parser = createServerSentEventParser();

    expect(parser.push('data: {"a":1}\r')).toEqual([]);
    expect(parser.push("\n\r\n")).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it("emits several events from one chunk", () => {
    const parser = createServerSentEventParser();

    expect(parser.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n")).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("strips exactly one leading space from a value", () => {
    const parser = createServerSentEventParser();

    expect(parser.push("data:  two-spaces\n\n")).toEqual([
      { event: undefined, data: " two-spaces" },
    ]);
  });

  it("treats a field with no colon as a field with an empty value", () => {
    const parser = createServerSentEventParser();

    expect(parser.push("data\n\n")).toEqual([{ event: undefined, data: "" }]);
  });

  it("emits an unterminated final event on end()", () => {
    const parser = createServerSentEventParser();
    parser.push('event: message_stop\ndata: {"type":"message_stop"}');

    expect(parser.end()).toEqual([{ event: "message_stop", data: '{"type":"message_stop"}' }]);
  });

  it("emits nothing on end() for an empty stream", () => {
    const parser = createServerSentEventParser();

    expect(parser.end()).toEqual([]);
  });

  it("does not confuse a blank line inside a value with a delimiter", () => {
    const parser = createServerSentEventParser();

    expect(parser.push("data: a\n\ndata: b\n\n")).toEqual([
      { event: undefined, data: "a" },
      { event: undefined, data: "b" },
    ]);
  });

  it("rejects an unbounded event rather than buffering forever", () => {
    const parser = createServerSentEventParser({ maxEventBytes: 8 });

    expect(() => parser.push("data: 123456789\n\n")).toThrow(RangeError);
  });

  it("ignores transport-level id and retry fields", () => {
    const parser = createServerSentEventParser();

    expect(parser.push('id: 42\nretry: 1000\ndata: {"a":1}\n\n')).toEqual([
      { event: undefined, data: '{"a":1}' },
    ]);
  });
});
