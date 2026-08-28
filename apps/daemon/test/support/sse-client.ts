export async function nextSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initial = "",
): Promise<{ frame: string; rest: string }> {
  let text = initial;
  while (!text.includes("\n\n")) {
    const result = await reader.read();
    if (result.done) throw new Error("SSE stream ended before a frame");
    text += new TextDecoder().decode(result.value);
  }
  const [frame, ...rest] = text.split("\n\n");
  return { frame, rest: rest.join("\n\n") };
}

export function sseFrameId(frame: string): string | undefined {
  return frame.match(/^id: (.+)$/m)?.[1];
}
