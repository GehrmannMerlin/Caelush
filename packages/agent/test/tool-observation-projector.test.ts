import { describe, expect, it } from "vitest";

import { createToolObservationBatchProjector } from "../src/index.js";

describe("Agent Tool observation projector", () => {
  it("keeps the head and tail of bounded command output around the omission marker", () => {
    const content = `HEAD-${"middle-".repeat(40)}TAIL`;
    const summaries = createToolObservationBatchProjector().projectBatch({
      candidates: [
        {
          sourceToolInvocationId: "invocation-1",
          toolName: "exec_command",
          content,
        },
      ],
      policy: {
        maxSingleObservationTokens: 32,
        maxObservationBatchTokens: 32,
      },
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("[output omitted; see artifact]");
    expect(summaries[0]?.startsWith("HEAD-")).toBe(true);
    expect(summaries[0]?.endsWith("TAIL")).toBe(true);
    expect(summaries[0]).not.toBe(content);
  });

  it("returns short observations unchanged", () => {
    const summaries = createToolObservationBatchProjector().projectBatch({
      candidates: [
        {
          sourceToolInvocationId: "invocation-1",
          toolName: "read_file",
          content: "short result",
        },
      ],
      policy: {
        maxSingleObservationTokens: 16,
        maxObservationBatchTokens: 16,
      },
    });

    expect(summaries).toEqual(["short result"]);
  });
});
