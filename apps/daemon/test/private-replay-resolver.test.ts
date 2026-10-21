import { describe, expect, it, vi } from "vitest";
import { createPrivateReplayReference } from "@caelush/agent";
import type {
  PrivateReplayIdentity,
  PrivateReplayReadScope,
  PrivateReplayStorePort,
} from "@caelush/agent";
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

async function resolverFixture() {
  const read = vi.fn(async () => new TextEncoder().encode("private"));
  const store = {
    openExecution: vi.fn(async () => ({ read, dispose: vi.fn() })),
  } as unknown as PrivateReplayStorePort;
  const execution = await createDaemonPrivateReplayResolver(store, scope);
  return { execution, resolver: execution.resolver, read };
}

describe("daemon private replay resolver", () => {
  it("resolves the full opaque identity for a Context-selected same-Session historical Assistant", async () => {
    const { execution, resolver, read } = await resolverFixture();
    const state = createPrivateReplayReference(identity);
    const bytes = await resolver.resolve({
      providerState: state,
      providerId: identity.providerId as never,
      model: { provider: identity.providerId, model: identity.model },
      api: identity.api as never,
    });
    expect(new TextDecoder().decode(bytes)).toBe("private");
    expect(read).toHaveBeenCalledWith(identity);
    await execution.dispose();
  });

  it("rejects a reference outside the actual selected-message scope before Store access", async () => {
    const { execution, resolver, read } = await resolverFixture();
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
    await execution.dispose();
  });

  it("rejects a selected reference attached to a different Assistant position", async () => {
    const { read } = await resolverFixture();
    const secondIdentity = { ...identity, messageId: "message-2" };
    const scopedExecution = await createDaemonPrivateReplayResolver(
      {
        openExecution: vi.fn(async () => ({ read, dispose: vi.fn() })),
      } as unknown as PrivateReplayStorePort,
      {
        ...scope,
        selectedMessageIds: [identity.messageId, secondIdentity.messageId],
        selectedAssistantMessageIds: [identity.messageId, secondIdentity.messageId],
      },
    );
    const reference = createPrivateReplayReference(secondIdentity);
    await expect(
      scopedExecution.resolver.resolve({
        providerState: reference,
        providerId: identity.providerId as never,
        model: { provider: identity.providerId, model: identity.model },
        api: identity.api as never,
      }),
    ).rejects.toThrow("Private replay unavailable.");
    expect(read).not.toHaveBeenCalled();
    await scopedExecution.dispose();
  });
});
