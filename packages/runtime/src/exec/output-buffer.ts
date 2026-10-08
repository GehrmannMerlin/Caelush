import { splitUtf8ByBytes, utf8ByteLength, utf8PrefixByBytes, utf8SuffixByBytes } from "./utf8.js";

const MAX_OUTPUT_TAIL_CHUNK_BYTES = 256;

export interface OutputBufferSnapshot {
  readonly text: string;
  readonly totalBytes: number;
  readonly omittedBytes: number;
}

interface TailChunk {
  readonly text: string;
  readonly bytes: number;
}

export class HeadTailOutputBuffer {
  private retainedChunks: TailChunk[] = [];
  private retainedBytes = 0;
  private headPart = "";
  private headRetainedBytes = 0;
  private tailChunks: TailChunk[] = [];
  private tailHead = 0;
  private tailRetainedBytes = 0;
  private truncated = false;
  private total = 0;
  private lastCodeUnit = 0;

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
    const inputBytes = utf8ByteLength(text);
    const joinsSurrogatePair =
      isHighSurrogate(this.lastCodeUnit) && isLowSurrogate(text.charCodeAt(0));
    // A high surrogate counted as three bytes in the preceding append, and this leading low
    // surrogate counted as three in this one. Together they encode as one four-byte code point.
    const bytes = inputBytes - (joinsSurrogatePair ? 2 : 0);
    const remainingText = joinsSurrogatePair ? text.slice(1) : text;
    const remainingBytes = inputBytes - (joinsSurrogatePair ? 3 : 0);
    this.total += bytes;

    if (!this.truncated) {
      if (this.retainedBytes + bytes <= this.maxBytes) {
        if (joinsSurrogatePair) this.appendRetainedSurrogatePair(text[0]!);
        if (remainingText.length > 0) {
          this.appendRetainedChunk(remainingText, remainingBytes);
          this.retainedBytes += remainingBytes;
        }
        this.lastCodeUnit = text.charCodeAt(text.length - 1);
        return;
      }

      if (joinsSurrogatePair) this.appendRetainedSurrogatePair(text[0]!);
      if (remainingText.length > 0) {
        this.appendRetainedChunk(remainingText, remainingBytes);
        this.retainedBytes += remainingBytes;
      }
      this.truncated = true;
      const combinedChunks = [...this.retainedChunks];
      this.initializeHead(combinedChunks);
      this.initializeTail(combinedChunks, this.tailByteLimit());
      this.retainedChunks = [];
      this.retainedBytes = 0;
      this.lastCodeUnit = text.charCodeAt(text.length - 1);
      return;
    }

    if (joinsSurrogatePair) this.appendTailSurrogatePair(text[0]!);
    if (remainingText.length > 0) this.appendTail(remainingText, remainingBytes);
    this.lastCodeUnit = text.charCodeAt(text.length - 1);
  }

  snapshot(): OutputBufferSnapshot {
    const tail = this.materializeTail();
    const omittedBytes = this.truncated
      ? Math.max(0, this.total - this.headRetainedBytes - this.tailRetainedBytes)
      : 0;
    const marker = this.truncated ? `\n... ${omittedBytes} bytes omitted ...\n` : "";
    return {
      text: this.truncated
        ? `${this.headPart}${marker}${tail}`
        : this.retainedChunks.map((chunk) => chunk.text).join(""),
      totalBytes: this.total,
      omittedBytes,
    };
  }

  drain(): OutputBufferSnapshot {
    const result = this.snapshot();
    this.retainedChunks = [];
    this.retainedBytes = 0;
    this.headPart = "";
    this.headRetainedBytes = 0;
    this.tailChunks = [];
    this.tailHead = 0;
    this.tailRetainedBytes = 0;
    this.truncated = false;
    this.total = 0;
    this.lastCodeUnit = 0;
    return result;
  }

  private appendTail(text: string, bytes: number): void {
    const tailLimit = this.tailByteLimit();
    if (tailLimit === 0) {
      this.clearTail();
      return;
    }

    if (bytes > tailLimit) {
      const suffix = utf8SuffixByBytes(text, tailLimit);
      this.replaceTail(suffix);
      return;
    }

    for (const tailChunk of splitUtf8ByBytes(text, MAX_OUTPUT_TAIL_CHUNK_BYTES)) {
      const tailChunkBytes = utf8ByteLength(tailChunk);
      this.tailChunks.push({ text: tailChunk, bytes: tailChunkBytes });
      this.tailRetainedBytes += tailChunkBytes;
    }
    this.evictTailOverflow(tailLimit);
    this.compactTailQueue();
  }

  private initializeHead(chunks: readonly TailChunk[]): void {
    const headParts: string[] = [];
    let remaining = this.headBytes;
    for (const chunk of chunks) {
      if (remaining <= 0) break;
      if (chunk.bytes <= remaining) {
        headParts.push(chunk.text);
        this.headRetainedBytes += chunk.bytes;
        remaining -= chunk.bytes;
        continue;
      }
      const prefix = utf8PrefixByBytes(chunk.text, remaining);
      headParts.push(prefix);
      this.headRetainedBytes += utf8ByteLength(prefix);
      break;
    }
    this.headPart = headParts.join("");
  }

  private initializeTail(chunks: readonly TailChunk[], tailLimit: number): void {
    this.clearTail();
    if (tailLimit <= 0) return;

    const reversedParts: string[] = [];
    let remaining = tailLimit;
    for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = chunks[index]!;
      if (chunk.bytes <= remaining) {
        reversedParts.push(chunk.text);
        remaining -= chunk.bytes;
        continue;
      }
      const suffix = utf8SuffixByBytes(chunk.text, remaining);
      if (suffix.length > 0) {
        reversedParts.push(suffix);
        remaining -= utf8ByteLength(suffix);
      }
      break;
    }

    for (let index = reversedParts.length - 1; index >= 0; index -= 1) {
      this.appendTailParts(reversedParts[index]!);
    }
  }

  private evictTailOverflow(tailLimit: number): void {
    while (this.tailRetainedBytes > tailLimit && this.tailHead < this.tailChunks.length) {
      const oldest = this.tailChunks[this.tailHead]!;
      const overflow = this.tailRetainedBytes - tailLimit;
      if (oldest.bytes <= overflow) {
        this.tailRetainedBytes -= oldest.bytes;
        this.tailHead += 1;
        continue;
      }

      const suffix = utf8SuffixByBytes(oldest.text, oldest.bytes - overflow);
      const suffixBytes = utf8ByteLength(suffix);
      this.tailRetainedBytes -= oldest.bytes - suffixBytes;
      if (suffixBytes === 0) {
        this.tailHead += 1;
      } else {
        this.tailChunks[this.tailHead] = { text: suffix, bytes: suffixBytes };
      }
    }
  }

  private replaceTail(text: string): void {
    this.clearTail();
    if (text.length === 0) return;
    this.appendTailParts(text);
  }

  private appendTailParts(text: string): void {
    for (const tailChunk of splitUtf8ByBytes(text, MAX_OUTPUT_TAIL_CHUNK_BYTES)) {
      const bytes = utf8ByteLength(tailChunk);
      this.tailChunks.push({ text: tailChunk, bytes });
      this.tailRetainedBytes += bytes;
    }
  }

  private appendRetainedChunk(text: string, bytes: number): void {
    const lastIndex = this.retainedChunks.length - 1;
    const last = this.retainedChunks[lastIndex];
    if (last !== undefined && last.bytes + bytes <= MAX_OUTPUT_TAIL_CHUNK_BYTES) {
      this.retainedChunks[lastIndex] = { text: last.text + text, bytes: last.bytes + bytes };
      return;
    }
    this.retainedChunks.push({ text, bytes });
  }

  private appendRetainedSurrogatePair(lowSurrogate: string): void {
    const lastIndex = this.retainedChunks.length - 1;
    const last = this.retainedChunks[lastIndex];
    if (last === undefined || !isHighSurrogate(last.text.charCodeAt(last.text.length - 1))) {
      throw new Error("output buffer lost its retained surrogate boundary");
    }
    const prefix = last.text.slice(0, -1);
    if (prefix.length === 0) {
      this.retainedChunks.pop();
    } else {
      this.retainedChunks[lastIndex] = { text: prefix, bytes: last.bytes - 3 };
    }
    this.retainedChunks.push({ text: last.text.slice(-1) + lowSurrogate, bytes: 4 });
    this.retainedBytes += 1;
  }

  private appendTailSurrogatePair(lowSurrogate: string): void {
    const lastIndex = this.tailChunks.length - 1;
    if (lastIndex < this.tailHead) return;
    const last = this.tailChunks[lastIndex]!;
    if (!isHighSurrogate(last.text.charCodeAt(last.text.length - 1))) return;
    const prefix = last.text.slice(0, -1);
    if (prefix.length === 0) {
      this.tailChunks.pop();
    } else {
      this.tailChunks[lastIndex] = { text: prefix, bytes: last.bytes - 3 };
    }
    this.tailChunks.push({ text: last.text.slice(-1) + lowSurrogate, bytes: 4 });
    this.tailRetainedBytes += 1;
    this.evictTailOverflow(this.tailByteLimit());
    this.compactTailQueue();
  }

  private clearTail(): void {
    this.tailChunks = [];
    this.tailHead = 0;
    this.tailRetainedBytes = 0;
  }

  private compactTailQueue(): void {
    if (this.tailHead > 64 && this.tailHead * 2 >= this.tailChunks.length) {
      this.tailChunks = this.tailChunks.slice(this.tailHead);
      this.tailHead = 0;
    }
  }

  private materializeTail(): string {
    return this.tailChunks
      .slice(this.tailHead)
      .map((chunk) => chunk.text)
      .join("");
  }

  private tailByteLimit(): number {
    return Math.max(0, this.maxBytes - this.headBytes);
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
