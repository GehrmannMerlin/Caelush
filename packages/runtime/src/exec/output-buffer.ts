export interface OutputBufferSnapshot {
  readonly text: string;
  readonly totalBytes: number;
  readonly omittedBytes: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function prefixBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

function suffixBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

export class HeadTailOutputBuffer {
  private retained = "";
  private headPart = "";
  private tailPart = "";
  private truncated = false;
  private total = 0;
  private omitted = 0;

  constructor(
    private readonly maxBytes = 1024 * 1024,
    private readonly headBytes = Math.floor(maxBytes / 2),
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || !Number.isSafeInteger(headBytes)) {
      throw new RangeError("output buffer bounds are invalid");
    }
  }

  append(text: string): void {
    if (text.length === 0) return;
    const bytes = byteLength(text);
    this.total += bytes;
    if (!this.truncated) {
      const combined = this.retained + text;
      if (byteLength(combined) <= this.maxBytes) {
        this.retained = combined;
        return;
      }
      this.truncated = true;
      const tailBytes = this.maxBytes - this.headBytes;
      this.headPart = prefixBytes(combined, this.headBytes);
      this.tailPart = suffixBytes(combined, tailBytes);
      this.retained = "";
    } else {
      const tailBytes = this.maxBytes - this.headBytes;
      this.tailPart = suffixBytes(this.tailPart + text, tailBytes);
    }
    this.omitted = Math.max(
      0,
      this.total - byteLength(this.truncated ? this.headPart + this.tailPart : this.retained),
    );
  }

  snapshot(): OutputBufferSnapshot {
    const marker = this.truncated ? `\n... ${this.omitted} bytes omitted ...\n` : "";
    return {
      text: this.truncated ? `${this.headPart}${marker}${this.tailPart}` : this.retained,
      totalBytes: this.total,
      omittedBytes: this.omitted,
    };
  }

  drain(): OutputBufferSnapshot {
    const result = this.snapshot();
    this.retained = "";
    this.headPart = "";
    this.tailPart = "";
    this.truncated = false;
    this.total = 0;
    this.omitted = 0;
    return result;
  }
}
