import { StringDecoder } from "node:string_decoder";

export function sanitizeTerminalOutput(value: string): string {
  return new TerminalOutputSanitizer().end(value);
}

export class TerminalOutputSanitizer {
  private pendingEscape = "";
  private pendingCarriageReturn = false;

  push(value: string): string {
    const result = sanitizeChunk(value, this.pendingEscape, false, this.pendingCarriageReturn);
    this.pendingEscape = result.pendingEscape;
    this.pendingCarriageReturn = result.pendingCarriageReturn;
    return result.text;
  }

  end(value = ""): string {
    const result = sanitizeChunk(value, this.pendingEscape, true, this.pendingCarriageReturn);
    this.pendingEscape = "";
    this.pendingCarriageReturn = false;
    return result.text;
  }
}

export class TerminalOutputDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private readonly sanitizer = new TerminalOutputSanitizer();

  push(chunk: Uint8Array): string {
    return this.sanitizer.push(this.decoder.write(Buffer.from(chunk)));
  }

  end(): string {
    return this.sanitizer.end(this.decoder.end());
  }
}

interface SanitizedChunk {
  readonly text: string;
  readonly pendingEscape: string;
  readonly pendingCarriageReturn: boolean;
}

function sanitizeChunk(
  value: string,
  pendingEscape: string,
  final: boolean,
  pendingCarriageReturn = false,
): SanitizedChunk {
  const input = pendingEscape + value;
  let text = "";
  let index = 0;

  if (pendingCarriageReturn && input.startsWith("\n")) index = 1;

  while (index < input.length) {
    const character = input[index]!;
    if (pendingCarriageReturn && character === "\n") {
      pendingCarriageReturn = false;
      index += 1;
      continue;
    }
    if (character === "\u001b") {
      const sequenceEnd = findEscapeEnd(input, index);
      if (sequenceEnd === undefined) {
        if (!final) {
          return {
            text,
            pendingEscape: input.slice(index),
            pendingCarriageReturn,
          };
        }
        break;
      }
      index = sequenceEnd + 1;
      continue;
    }
    if (character === "\r") {
      text += "\n";
      pendingCarriageReturn = true;
    } else if (character === "\t" || character === "\n") {
      text += character;
      pendingCarriageReturn = false;
    } else if (!isUnsafeControl(character)) {
      text += character;
      pendingCarriageReturn = false;
    }
    index += 1;
  }

  return { text, pendingEscape: "", pendingCarriageReturn };
}

function isUnsafeControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 0 && code <= 8) ||
    code === 11 ||
    code === 12 ||
    (code >= 14 && code <= 31) ||
    code === 127
  );
}

function findEscapeEnd(value: string, start: number): number | undefined {
  if (start + 1 >= value.length) return undefined;
  const kind = value[start + 1];
  if (kind === "[") {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index;
    }
    return undefined;
  }
  if (kind === "]") {
    for (let index = start + 2; index < value.length; index += 1) {
      if (value[index] === "\u0007") return index;
      if (value[index] === "\u001b" && value[index + 1] === "\\") return index + 1;
    }
    return undefined;
  }
  return start + 1;
}
