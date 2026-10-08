import type { AIPrivateReplayResolver } from "@caelush/ai";
import { PRIVATE_REPLAY_REFERENCE_KIND, PrivateReplayError } from "@caelush/agent";
import type {
  PrivateReplayIdentity,
  PrivateReplayReadScope,
  PrivateReplayStorePort,
} from "@caelush/agent";

/** Build the only AI-facing resolver over a Store reader already scoped to one execution. */
export function createDaemonPrivateReplayResolver(
  store: PrivateReplayStorePort,
  scope: PrivateReplayReadScope,
): AIPrivateReplayResolver {
  const reader = store.forExecution(scope);
  const selectedMessageIds = new Set(scope.selectedMessageIds);
  let assistantIndex = 0;
  return Object.freeze({
    ...(scope.selectedAssistantMessageIds === undefined
      ? {}
      : { selectedAssistantMessageIds: scope.selectedAssistantMessageIds }),
    async resolve(input: Parameters<AIPrivateReplayResolver["resolve"]>[0]): Promise<Uint8Array> {
      const { providerState, providerId, model, api } = input;
      const payload = record(providerState.payload);
      const expectedMessageId = scope.selectedAssistantMessageIds?.[assistantIndex];
      assistantIndex += 1;
      if (
        providerState.version !== 1 ||
        providerState.providerId !== providerId ||
        providerState.api !== api ||
        providerId !== scope.providerId ||
        model.model !== scope.model ||
        api !== scope.api ||
        !hasExactKeys(payload, [
          "kind",
          "replayId",
          "sessionId",
          "runId",
          "callId",
          "model",
          "replayVersion",
        ]) ||
        payload.kind !== PRIVATE_REPLAY_REFERENCE_KIND ||
        payload.replayVersion !== 1 ||
        typeof payload.replayId !== "string" ||
        typeof payload.sessionId !== "string" ||
        typeof payload.runId !== "string" ||
        typeof payload.callId !== "string" ||
        typeof payload.model !== "string" ||
        payload.sessionId !== scope.sessionId ||
        (expectedMessageId !== undefined && payload.replayId !== expectedMessageId) ||
        payload.model !== model.model ||
        !selectedMessageIds.has(payload.replayId)
      )
        throw new PrivateReplayError();

      const identity: PrivateReplayIdentity = Object.freeze({
        sessionId: payload.sessionId,
        runId: payload.runId,
        messageId: payload.replayId,
        callId: payload.callId,
        providerId,
        model: payload.model,
        api,
        replayVersion: 1,
      });
      return reader.read(identity);
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
