export interface BoundedLiveText {
  readonly text: string;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  readonly omittedBytes: number;
}

export interface BoundedLiveTextOperations {
  readonly utf8ByteLength: (value: string) => number;
  readonly utf8PrefixByBytes: (value: string, maxBytes: number) => string;
}

const DEFAULT_OPERATIONS: BoundedLiveTextOperations = {
  utf8ByteLength,
  utf8PrefixByBytes,
};

export function createEmptyBoundedLiveText(): BoundedLiveText {
  return { text: "", retainedBytes: 0, truncated: false, omittedBytes: 0 };
}

export function appendBoundedLiveText(
  state: BoundedLiveText,
  next: string,
  maxBytes: number,
  operations: BoundedLiveTextOperations = DEFAULT_OPERATIONS,
): BoundedLiveText {
  if (state.truncated) {
    if (next.length === 0) return state;
    return {
      ...state,
      omittedBytes: state.omittedBytes + operations.utf8ByteLength(next),
    };
  }

  const byteLimit = Math.max(0, maxBytes);
  const nextBytes = operations.utf8ByteLength(next);
  if (state.retainedBytes + nextBytes <= byteLimit) {
    if (next.length === 0) return state;
    return {
      ...state,
      text: state.text + next,
      retainedBytes: state.retainedBytes + nextBytes,
    };
  }

  const remainingBytes = Math.max(0, byteLimit - state.retainedBytes);
  const prefix = operations.utf8PrefixByBytes(next, remainingBytes);
  const prefixBytes = operations.utf8ByteLength(prefix);
  return {
    text: state.text + prefix,
    retainedBytes: state.retainedBytes + prefixBytes,
    truncated: true,
    omittedBytes: state.omittedBytes + nextBytes - prefixBytes,
  };
}

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
