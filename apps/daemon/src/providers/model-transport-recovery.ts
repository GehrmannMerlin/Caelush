import type { ModelTransportRecoveryPort } from "@caelush/core";
import type { ProviderRegistry } from "@caelush/ai";

/**
 * Adapt immutable AI provider bindings to Core's provider-neutral recovery port.
 * Only candidate ids and explicit rate-limit domains cross this seam; endpoint,
 * credentials, headers and fetch implementations remain inside the AI gateway.
 */
export function createModelTransportRecoveryPort(
  providers: ProviderRegistry,
  modelApiFor: (input: { readonly providerId: string; readonly modelId: string }) => string,
): ModelTransportRecoveryPort {
  return {
    initial: ({ providerId, modelId }) => ({
      providerId,
      modelId,
      transportId: "default",
    }),
    next: ({ current, attemptedTransportIds, errorCode }) => {
      const provider = providers.get(current.providerId);
      const modelApi = modelApiFor({
        providerId: current.providerId,
        modelId: current.modelId,
      });
      const candidates = [
        { id: "default", api: modelApi, rateLimitDomain: provider.rateLimitDomain },
        ...(provider.transportCandidates ?? [])
          .filter((candidate) => candidate.api === modelApi)
          .map(({ id, rateLimitDomain, api }) => ({
            id,
            api,
            rateLimitDomain,
          })),
      ];
      const currentCandidate = candidates.find((candidate) => candidate.id === current.transportId);
      if (currentCandidate === undefined) return undefined;

      const next = candidates.find((candidate) => {
        if (candidate.id === current.transportId || attemptedTransportIds.includes(candidate.id)) {
          return false;
        }
        if (errorCode !== "LLM_RATE_LIMIT") return true;
        return (
          currentCandidate.rateLimitDomain !== undefined &&
          candidate.rateLimitDomain !== undefined &&
          currentCandidate.rateLimitDomain !== candidate.rateLimitDomain
        );
      });
      return next === undefined ? undefined : { ...current, transportId: next.id };
    },
  };
}
