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
