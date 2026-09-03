import { describe, expect, it } from "vitest";
import {
  createInMemoryArtifactStore,
  projectToolObservation,
} from "../src/observation-projector.js";

const estimator = { estimateText: (text: string) => text.length };

describe("ModelObservation projection", () => {
  it("keeps a large raw result out of the bounded model observation", async () => {
    const raw = `${"头部日志\n".repeat(40_000)}TAIL-SENTINEL`;
    const artifacts = createInMemoryArtifactStore();
    const artifact = await artifacts.put({
      runId: "run-1",
      kind: "BUILD_LOG",
      sourceRef: "tool-1",
      content: raw,
      mimeType: "text/plain",
      sensitivity: "INTERNAL",
      createdSequence: 10,
      createdAt: 10,
    });
    const observation = projectToolObservation({
      sourceToolInvocationId: "tool-1",
      toolName: "exec_command",
      content: raw,
      rawArtifactRef: artifact.artifactId,
      maxObservationTokens: 120,
      estimator,
    });

    expect(observation.truncated).toBe(true);
    expect(observation.summary).toContain("[output omitted");
    expect(observation.summary).toContain("TAIL-SENTINEL");
    expect(estimator.estimateText(observation.summary)).toBeLessThanOrEqual(120);
    expect(observation.rawArtifactRef).toBe(artifact.artifactId);
    expect((await artifacts.get(artifact.artifactId))?.content).toBe(raw);
  });

  it("uses a tool-specific cap while keeping protocol identity separate", () => {
    const observation = projectToolObservation({
      sourceToolInvocationId: "tool-2",
      toolName: "list_directory",
      content: Array.from({ length: 100 }, (_, index) => `entry-${index}`).join("\n"),
      maxObservationTokens: 40,
      estimator,
    });

    expect(observation.sourceToolInvocationId).toBe("tool-2");
    expect(observation.summary).toContain("entry-0");
    expect(observation.truncated).toBe(true);
    expect(observation.summary).not.toContain("entry-99");
  });
});
