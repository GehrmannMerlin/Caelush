import { describe, expect, it, vi } from "vitest";
import { createPrivateReplayReference } from "@caelush/agent";
import type {
  PrivateReplayIdentity,
  PrivateReplayReadScope,
  PrivateReplayStorePort,
} from "@caelush/agent";
import type { AIPrivateReplayResolver } from "@caelush/ai";
import { createDaemonPrivateReplayResolver } from "../src/replay/private-replay-resolver.js";

const identity: PrivateReplayIdentity = {
  sessionId: "session-a",
  runId: "run-1",
  messageId: "message-1",
  callId: "call-1",
  providerId: "deepseek",
  model: "deepseek-reasoner",
  api: "openai-compatible-chat",
  replayVersion: 1,
};

const scope: PrivateReplayReadScope = {
  sessionId: identity.sessionId,
  executionRunId: "run-2",
  providerId: identity.providerId,
  model: identity.model,
  api: identity.api,
  selectedMessageIds: [identity.messageId],
  selectedAssistantMessageIds: [identity.messageId],
};

function resolverFixture() {
  const read = vi.fn(async () => new TextEncoder().encode("private"));
  const store = {
    forExecution: vi.fn(() => ({ read })),
  } as unknown as PrivateReplayStorePort;
  const resolver: AIPrivateReplayResolver = createDaemonPrivateReplayResolver(store, scope);
  return { resolver, read };
}

describe("daemon private replay resolver", () => {
  it("resolves the full opaque identity for a Context-selected same-Session historical Assistant", async () => {
    const { resolver, read } = resolverFixture();
    const state = createPrivateReplayReference(identity);
    const bytes = await resolver.resolve({
      providerState: state,
      providerId: identity.providerId as never,
      model: { provider: identity.providerId, model: identity.model },
      api: identity.api as never,
    });
    expect(new TextDecoder().decode(bytes)).toBe("private");
    expect(read).toHaveBeenCalledWith(identity);
  });

  it("rejects a reference outside the actual selected-message scope before Store access", async () => {
    const { resolver, read } = resolverFixture();
    const unselected = createPrivateReplayReference({ ...identity, messageId: "message-2" });
    await expect(
      resolver.resolve({
        providerState: unselected,
        providerId: identity.providerId as never,
        model: { provider: identity.providerId, model: identity.model },
        api: identity.api as never,
      }),
    ).rejects.toThrow("Private replay unavailable.");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a selected reference attached to a different Assistant position", async () => {
    const { resolver, read } = resolverFixture();
    const secondIdentity = { ...identity, messageId: "message-2" };
    const scopedResolver = createDaemonPrivateReplayResolver(
      { forExecution: vi.fn(() => ({ read })) } as unknown as PrivateReplayStorePort,
      {
        ...scope,
        selectedMessageIds: [identity.messageId, secondIdentity.messageId],
        selectedAssistantMessageIds: [identity.messageId, secondIdentity.messageId],
      },
    );
    const reference = createPrivateReplayReference(secondIdentity);
    await expect(
      scopedResolver.resolve({
        providerState: reference,
        providerId: identity.providerId as never,
        model: { provider: identity.providerId, model: identity.model },
        api: identity.api as never,
      }),
    ).rejects.toThrow("Private replay unavailable.");
    expect(read).not.toHaveBeenCalled();
  });
});
