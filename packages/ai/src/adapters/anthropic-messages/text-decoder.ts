/**
 * A streaming UTF-8 decoder over a byte stream.
 *
 * `TextDecoder.decode` with `{ stream: true }` is what keeps a multi-byte character
 * split across two network chunks from becoming a replacement character, so the SSE
 * parser above it only ever sees valid text.
 */
export function createTextDecoderStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let reachedEnd = false;
  let cancelPromise: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    cancelPromise ??= reader.cancel().then(
      () => undefined,
      () => undefined,
    );
    return cancelPromise;
  };
  const onAbort = (): void => {
    void cancelReader();
  };

  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return (async function* decode(): AsyncGenerator<string> {
    try {
      while (true) {
        const step = await reader.read();
        if (step.done === true) {
          reachedEnd = true;
          break;
        }
        if (step.value === undefined) continue;
        const text = decoder.decode(step.value, { stream: true });
        if (text.length > 0) yield text;
      }
      const trailing = decoder.decode();
      if (trailing.length > 0) yield trailing;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!reachedEnd) void cancelReader();
      reader.releaseLock();
    }
  })();
}
