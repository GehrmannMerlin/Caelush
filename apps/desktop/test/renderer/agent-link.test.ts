import { describe, expect, it } from "vitest";
import { createSessionId } from "@caelush/protocol";
import { createAgentDeepLink } from "../../src/renderer/agent-link.js";

describe("Desktop workbench deep links", () => {
  it("encodes a recent session and model settings route without changing the shared workbench host", () => {
    const sessionId = createSessionId();
    expect(createAgentDeepLink({ sessionId })).toBe(
      `caelush-app://app/agent/?session=${encodeURIComponent(sessionId)}`,
    );
    expect(createAgentDeepLink({ settings: "models" })).toBe(
      "caelush-app://app/agent/?settings=models",
    );
  });
});
