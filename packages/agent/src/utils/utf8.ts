export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const width = codePointByteWidthAt(value, index);
    bytes += width;
    index += width === 4 ? 2 : 1;
  }
  return bytes;
}

export function utf8PrefixByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return "";

  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const width = codePointByteWidthAt(value, end);
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += width === 4 ? 2 : 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export function splitUtf8ByBytes(
  value: string,
  maxBytes: number,
  onCodePointProcessed?: () => void,
): readonly string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("UTF-8 split byte limit must be a positive safe integer.");
  }
  if (value.length === 0) return [""];

  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const width = codePointByteWidthAt(value, index);
    if (width > maxBytes) {
      throw new RangeError("UTF-8 split byte limit is smaller than one code point.");
    }
    if (bytes > 0 && bytes + width > maxBytes) {
      chunks.push(value.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += width === 4 ? 2 : 1;
    onCodePointProcessed?.();
  }
  chunks.push(value.slice(start));
  return chunks;
}

export function utf8SuffixByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return "";

  let bytes = 0;
  let start = value.length;
  while (start > 0) {
    let codeUnit = value.charCodeAt(start - 1);
    let width: number;
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 1) {
      const high = value.charCodeAt(start - 2);
      if (high >= 0xd800 && high <= 0xdbff) {
        start -= 2;
        width = 4;
      } else {
        start -= 1;
        width = 3;
      }
    } else {
      start -= 1;
      width = codeUnit <= 0x7f ? 1 : codeUnit <= 0x7ff ? 2 : 3;
    }
    if (bytes + width > maxBytes) {
      if (width === 4) start += 2;
      else start += 1;
      break;
    }
    bytes += width;
  }
  return value.slice(start);
}

function codePointByteWidthAt(value: string, index: number): number {
  const first = value.charCodeAt(index);
  if (first <= 0x7f) return 1;
  if (first <= 0x7ff) return 2;
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = value.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return 4;
  }
  return 3;
}
