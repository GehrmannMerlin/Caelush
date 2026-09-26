import type {
  ModelObservationBatchProjector,
  ModelObservationCandidate,
} from "./model-feedback-projector.js";

const OMITTED = "\n[output omitted; see artifact]";

/**
 * The canonical bounded Tool observation projection.
 *
 * It is intentionally owned by the Agent Tool observation layer: Context V2 produces an
 * observation policy, while this projector turns already-safe durable observation content into a
 * bounded model view. Large file/command output keeps both its head and tail around the omission
 * marker, and the batch allocator preserves one result per input in source order.
 */
export function createToolObservationBatchProjector(): ModelObservationBatchProjector {
  return {
    projectBatch(input) {
      assertPolicy(input.policy);
      if (input.candidates.length === 0) return Object.freeze([]);
      if (input.policy.maxObservationBatchTokens < input.candidates.length) {
        throw new RangeError("Observation batch budget cannot preserve every Tool Result");
      }
      const weights = input.candidates.map((candidate) =>
        Math.max(1, estimateText(candidate.content)),
      );
      const totalWeight = weights.reduce((total, weight) => total + weight, 0);
      let remainingTokens = input.policy.maxObservationBatchTokens;
      let remainingWeight = totalWeight;
      return Object.freeze(
        input.candidates.map((candidate, index) => {
          const weight = weights[index] ?? 1;
          const proportional = Math.floor((remainingTokens * weight) / remainingWeight);
          const allocation = Math.max(
            1,
            Math.min(
              input.policy.maxSingleObservationTokens,
              proportional,
              remainingTokens - Math.max(0, input.candidates.length - index - 1),
            ),
          );
          remainingTokens = Math.max(0, remainingTokens - allocation);
          remainingWeight = Math.max(1, remainingWeight - weight);
          return projectObservation(candidate, allocation);
        }),
      );
    },
  };
}

function projectObservation(
  candidate: ModelObservationCandidate,
  maxObservationTokens: number,
): string {
  const bounded = boundObservation(candidate.content, candidate.toolName, maxObservationTokens);
  return bounded.text;
}

function boundObservation(
  content: string,
  toolName: string,
  maxTokens: number,
): { readonly text: string; readonly truncated: boolean } {
  if (estimateText(content) <= maxTokens) return { text: content, truncated: false };
  const marker = estimateText(OMITTED) <= maxTokens ? OMITTED : "[omitted]";
  const available = Math.max(0, maxTokens - estimateText(marker));
  if (toolName === "read_file" || toolName === "exec_command" || toolName === "write_stdin") {
    const characters = [...content];
    const half = Math.floor(available / 2);
    const head = boundedPrefix(content, half);
    const tail = boundedPrefix(
      characters.slice(Math.max(0, characters.length - Math.max(1, half))).join(""),
      available - estimateText(head),
    );
    return { text: `${head}${marker}${tail}`, truncated: true };
  }
  return { text: `${boundedPrefix(content, available)}${marker}`, truncated: true };
}

function boundedPrefix(content: string, maxTokens: number): string {
  const characters = [...content];
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (estimateText(candidate) <= maxTokens) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function estimateText(text: string): number {
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes === 0 ? 0 : Math.ceil(bytes / 3);
}

function assertPolicy(policy: {
  readonly maxSingleObservationTokens: number;
  readonly maxObservationBatchTokens: number;
}): void {
  if (
    !Number.isSafeInteger(policy.maxSingleObservationTokens) ||
    policy.maxSingleObservationTokens < 1 ||
    !Number.isSafeInteger(policy.maxObservationBatchTokens) ||
    policy.maxObservationBatchTokens < 1
  ) {
    throw new RangeError("Observation policy limits must be positive safe integers");
  }
}
