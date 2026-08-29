import { open } from "node:fs/promises";
import {
  RuntimeError,
  RuntimeBinaryFileError,
  RuntimeFileReadError,
  RuntimeInvalidUtf8Error,
} from "../runtime-errors.js";
import { isBinarySample } from "./binary-detection.js";
import type { RuntimeTextRead } from "./types.js";

export const DEFAULT_READ_MODEL_BYTES = 50 * 1024;
export const MAX_READ_LINE_CHARS = 2000;
const READ_CHUNK_BYTES = 16 * 1024;
const BINARY_SAMPLE_BYTES = 4096;
const LINE_TRUNCATION_SUFFIX = "... [line truncated]";

interface MutableReadState {
  readonly lines: string[];
  lineNumber: number;
  current: string;
  currentCharacters: number;
  lineStart: number;
  bytesReturned: number;
  truncated: boolean;
  more: boolean;
  utf8Bom: boolean;
  sawContent: boolean;
}

function appendCharacter(state: MutableReadState, character: string): void {
  if (state.currentCharacters < MAX_READ_LINE_CHARS + 1) state.current += character;
  state.currentCharacters += 1;
}

function finishLine(
  state: MutableReadState,
  offset: number,
  limit: number,
  maxBytes: number,
): boolean {
  const line = state.current.endsWith("\r") ? state.current.slice(0, -1) : state.current;
  if (state.lineNumber >= offset && state.lines.length < limit) {
    const displayed =
      state.currentCharacters > MAX_READ_LINE_CHARS
        ? `${Array.from(line).slice(0, MAX_READ_LINE_CHARS).join("")}${LINE_TRUNCATION_SUFFIX}`
        : line;
    const rendered = `${state.lineNumber}: ${displayed}`;
    const renderedBytes = Buffer.byteLength(rendered, "utf8") + (state.lines.length === 0 ? 0 : 1);
    if (state.bytesReturned + renderedBytes > maxBytes) {
      state.truncated = true;
      state.more = true;
      return true;
    }
    state.lines.push(rendered);
    state.bytesReturned += renderedBytes;
  } else if (state.lineNumber > offset + limit - 1) {
    state.more = true;
    return true;
  }
  state.lineNumber += 1;
  state.current = "";
  state.currentCharacters = 0;
  state.sawContent = false;
  return false;
}

export async function readBoundedUtf8Text(
  filePath: string,
  options: { readonly offset: number; readonly limit: number; readonly maxBytes: number },
): Promise<RuntimeTextRead> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    throw new RuntimeFileReadError("file could not be opened", { cause: error });
  }
  try {
    const sample = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const sampleRead = await handle.read(sample, 0, sample.length, 0);
    if (isBinarySample(filePath, sample.subarray(0, sampleRead.bytesRead))) {
      throw new RuntimeBinaryFileError("binary files cannot be read as model text");
    }

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const utf8Bom =
      sampleRead.bytesRead >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf;
    const state: MutableReadState = {
      lines: [],
      lineNumber: 1,
      current: "",
      currentCharacters: 0,
      lineStart: options.offset,
      bytesReturned: 0,
      truncated: false,
      more: false,
      utf8Bom,
      sawContent: false,
    };
    let position = 0;
    let stop = false;
    const consume = (text: string): void => {
      for (const character of text) {
        if (state.lineNumber === 1 && !state.sawContent && character === "\uFEFF") {
          state.utf8Bom = true;
          continue;
        }
        if (character === "\n") {
          stop = finishLine(state, options.offset, options.limit, options.maxBytes);
          if (stop) return;
          continue;
        }
        state.sawContent = true;
        if (
          state.lines.length >= options.limit &&
          state.lineNumber >= options.offset + options.limit
        ) {
          state.more = true;
          stop = true;
          return;
        }
        appendCharacter(state, character);
      }
    };

    while (!stop) {
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) {
        try {
          consume(decoder.decode());
        } catch (error) {
          throw new RuntimeInvalidUtf8Error("file contains invalid UTF-8", { cause: error });
        }
        break;
      }
      position += result.bytesRead;
      try {
        consume(decoder.decode(buffer.subarray(0, result.bytesRead), { stream: true }));
      } catch (error) {
        throw new RuntimeInvalidUtf8Error("file contains invalid UTF-8", { cause: error });
      }
    }
    if (!stop && state.currentCharacters > 0) {
      finishLine(state, options.offset, options.limit, options.maxBytes);
    }
    const nextOffset =
      state.truncated || state.more ? options.offset + state.lines.length : undefined;
    return {
      lines: state.lines,
      lineStart: options.offset,
      bytesReturned: state.bytesReturned,
      truncated: state.truncated || state.more,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      utf8Bom: state.utf8Bom,
    };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeFileReadError("file could not be read", { cause: error });
  } finally {
    await handle.close();
  }
}
