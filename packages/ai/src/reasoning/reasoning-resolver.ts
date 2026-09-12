import { createAIError } from "../errors/ai-error.js";
import { assertModelDescriptor } from "../models/model-descriptor.js";
import { reasoningLevelIndex } from "./reasoning-level.js";
import { isReasoningResolutionPolicy } from "./reasoning-resolution.js";
import type { ModelDescriptor } from "../models/model-descriptor.js";
import type { ReasoningLevel } from "./reasoning-level.js";
import type {
  AIReasoningRequest,
  ReasoningResolution,
  ReasoningResolutionPolicy,
} from "./reasoning-resolution.js";

/** Input for one reasoning resolution. */
export interface ReasoningResolverInput {
  readonly request?: AIReasoningRequest;
  readonly model: ModelDescriptor;
  readonly policy: ReasoningResolutionPolicy;
}

/**
 * Settles a reasoning request against a model's real levels.
 *
 * Pure and deterministic: it reads the descriptor and nothing else, so it never
 * performs I/O and can be called during preflight.
 */
export interface ReasoningResolver {
  resolve(input: ReasoningResolverInput): ReasoningResolution;
}

/** The default, stateless reasoning resolver. */
export function createReasoningResolver(): ReasoningResolver {
  return {
    resolve(input: ReasoningResolverInput): ReasoningResolution {
      const { request, model, policy } = input;
      assertModelDescriptor(model);
      if (!isReasoningResolutionPolicy(policy)) {
        throw new TypeError(`Reasoning resolution policy is unknown: ${String(policy)}.`);
      }

      if (request === undefined) {
        return { mode: "NOT_REQUESTED", policy };
      }

      const supported = usableLevels(model, request.level);
      const requestedIndex = reasoningLevelIndex(request.level);
      if (requestedIndex === undefined) {
        throw new TypeError(`Reasoning request level is unknown: ${String(request.level)}.`);
      }

      if (supported.includes(request.level)) {
        return { requested: request.level, effective: request.level, mode: "EXACT", policy };
      }

      if (policy === "STRICT") {
        throw unsupported(model, request.level, "STRICT does not allow clamping");
      }

      // Frozen PREFER_BUDGET order: highest supported level at or below the
      // request first, and only then the lowest level above it.
      const below = highestAtOrBelow(supported, requestedIndex);
      if (below !== undefined) {
        return {
          requested: request.level,
          effective: below,
          mode: "CLAMPED_DOWN",
          policy,
        };
      }

      const above = lowestAbove(supported, requestedIndex);
      if (above !== undefined) {
        return {
          requested: request.level,
          effective: above,
          mode: "CLAMPED_UP",
          policy,
        };
      }

      throw unsupported(model, request.level, "the model offers no reasoning level at all");
    },
  };
}

/**
 * The levels a descriptor can actually resolve against.
 *
 * An explicit request needs a real profile. A model with no profile, an empty
 * profile, or an explicitly unsupported reasoning capability cannot satisfy one,
 * under either policy: guessing a level would silently change what the caller
 * asked for.
 */
function usableLevels(
  model: ModelDescriptor,
  requested: ReasoningLevel,
): readonly ReasoningLevel[] {
  if (model.capabilities.reasoning === "UNSUPPORTED") {
    throw unsupported(model, requested, "the model declares reasoning UNSUPPORTED");
  }

  const levels = model.reasoning?.supportedLevels;
  if (levels === undefined) {
    throw unsupported(model, requested, "the model has no reasoning profile");
  }
  if (levels.length === 0) {
    throw unsupported(model, requested, "the model reasoning profile offers no levels");
  }
  return levels;
}

function highestAtOrBelow(
  levels: readonly ReasoningLevel[],
  requestedIndex: number,
): ReasoningLevel | undefined {
  let best: ReasoningLevel | undefined;
  let bestIndex = -1;

  for (const level of levels) {
    const index = reasoningLevelIndex(level);
    if (index === undefined || index > requestedIndex || index <= bestIndex) continue;
    best = level;
    bestIndex = index;
  }
  return best;
}

function lowestAbove(
  levels: readonly ReasoningLevel[],
  requestedIndex: number,
): ReasoningLevel | undefined {
  let best: ReasoningLevel | undefined;
  let bestIndex = Number.POSITIVE_INFINITY;

  for (const level of levels) {
    const index = reasoningLevelIndex(level);
    if (index === undefined || index <= requestedIndex || index >= bestIndex) continue;
    best = level;
    bestIndex = index;
  }
  return best;
}

function unsupported(
  model: ModelDescriptor,
  requested: ReasoningLevel,
  reason: string,
): ReturnType<typeof createAIError> {
  return createAIError(
    "AI_CAPABILITY_UNSUPPORTED",
    `AI model "${model.ref.model}" cannot resolve reasoning level "${requested}": ${reason}.`,
    { providerId: model.ref.provider, model: model.ref },
  );
}
