import { createAIError } from "../errors/ai-error.js";
import { modelDescriptorSourceRank } from "./model-descriptor-source.js";
import { resolveSourceDescriptor } from "./model-descriptor-snapshot.js";
import { isEnumerableSource } from "./model-descriptor-source-port.js";
import { sameModelIdentity } from "./model-ref.js";
import type { ModelDescriptor } from "./model-descriptor.js";
import type { ModelDescriptorSourcePort } from "./model-descriptor-source-port.js";
import type { ModelRef } from "./model-ref.js";

/**
 * The immutable AI-layer authority over model metadata.
 *
 * A catalog answers three questions and never performs I/O: what describes this
 * model, is this model describable, and what models are known.
 */
export interface ModelCatalog {
  /** Resolve one legal model; throws `AI_MODEL_METADATA_INCOMPLETE` when it cannot. */
  resolve(ref: ModelRef): ModelDescriptor;
  /** True when {@link ModelCatalog.resolve} would succeed for this ref. */
  has(ref: ModelRef): boolean;
  /** The known descriptor set, sorted by provider then model. */
  list(): readonly ModelDescriptor[];
}

/** One resolution candidate, ordered by the frozen precedence. */
interface Candidate {
  readonly descriptor: ModelDescriptor;
  readonly rank: number;
  readonly priority: number;
  readonly order: number;
}

/**
 * The runtime catalog implementation.
 *
 * Constructed only through the builder, so a catalog is always complete and
 * frozen by the time anyone can resolve against it.
 */
export class ImmutableModelCatalog implements ModelCatalog {
  readonly #sources: readonly ModelDescriptorSourcePort[];
  readonly #descriptors: readonly ModelDescriptor[];

  constructor(
    sources: readonly ModelDescriptorSourcePort[],
    descriptors: readonly ModelDescriptor[],
  ) {
    this.#sources = Object.freeze([...sources]);
    this.#descriptors = descriptors;
    Object.freeze(this);
  }

  resolve(ref: ModelRef): ModelDescriptor {
    const selected = this.#select(ref);
    if (selected === undefined) {
      throw createAIError(
        "AI_MODEL_METADATA_INCOMPLETE",
        `No AI model descriptor is available for "${ref.provider}/${ref.model}".`,
        { providerId: ref.provider, model: ref },
      );
    }
    return selected;
  }

  has(ref: ModelRef): boolean {
    return this.#select(ref) !== undefined;
  }

  list(): readonly ModelDescriptor[] {
    return this.#descriptors;
  }

  /**
   * Ask every source and choose the strongest answer.
   *
   * Precedence is `ModelDescriptor.source` rank first, then the source `priority`,
   * then registration order. Because a source is a pure lookup table, asking all
   * of them is deterministic and side-effect free.
   */
  #select(ref: ModelRef): ModelDescriptor | undefined {
    let best: Candidate | undefined;

    this.#sources.forEach((source, order) => {
      const resolved = source.resolve(ref);
      if (resolved === undefined) return;

      const descriptor = resolveSourceDescriptor(resolved, ref, source.id);
      const rank = modelDescriptorSourceRank(descriptor.source);
      if (rank === undefined) {
        throw new TypeError(
          `Model descriptor source "${source.id}" returned an unknown descriptor source.`,
        );
      }

      const candidate: Candidate = { descriptor, rank, priority: source.priority, order };
      if (best === undefined || compareCandidates(candidate, best) < 0) best = candidate;
    });

    return best?.descriptor;
  }
}

/** Sort candidates by frozen precedence: descriptor source, then priority, then registration. */
function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.order - right.order;
}

/**
 * Collect the known descriptor set from enumerable sources.
 *
 * Deduplicated by model identity with the same precedence as resolution, then
 * sorted by provider and model so `list()` is stable regardless of registration
 * order.
 */
export function collectCatalogDescriptors(
  sources: readonly ModelDescriptorSourcePort[],
): readonly ModelDescriptor[] {
  const byIdentity = new Map<string, Candidate>();

  sources.forEach((source, order) => {
    if (!isEnumerableSource(source)) return;

    for (const descriptor of source.list()) {
      const ref: ModelRef = descriptor.ref;
      const snapshot = resolveSourceDescriptor(descriptor, ref, source.id);
      const rank = modelDescriptorSourceRank(snapshot.source);
      if (rank === undefined) {
        throw new TypeError(
          `Model descriptor source "${source.id}" listed an unknown descriptor source.`,
        );
      }

      const candidate: Candidate = { descriptor: snapshot, rank, priority: source.priority, order };
      const key = `${ref.provider}\u0000${ref.model}`;
      const existing = byIdentity.get(key);
      if (existing === undefined || compareCandidates(candidate, existing) < 0) {
        byIdentity.set(key, candidate);
      }
    }
  });

  const descriptors = [...byIdentity.values()].map((candidate) => candidate.descriptor);
  descriptors.sort((left, right) => compareDescriptorIdentity(left.ref, right.ref));
  return Object.freeze(descriptors);
}

function compareDescriptorIdentity(left: ModelRef, right: ModelRef): number {
  if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
  if (left.model !== right.model) return left.model < right.model ? -1 : 1;
  return 0;
}

/** True when two descriptors describe the same model. */
export function describesSameModel(left: ModelDescriptor, right: ModelDescriptor): boolean {
  return sameModelIdentity(left.ref, right.ref);
}
