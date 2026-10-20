import type { ApprovalPolicy } from "@caelush/protocol";

import type { ToolExecutionMode } from "../types/execution-mode.js";

/**
 * How a Tool batch is allowed to run in parallel.
 *
 * ```text
 * a maximal run of consecutive PARALLEL_SAFE calls   → one PARALLEL segment
 * everything else                                    → SEQUENTIAL, one call at a time
 * ```
 *
 * The batch contract has always been "one call at a time, in order". Parallelism is therefore a
 * *narrowing* of that contract, never a widening of what a call may do:
 *
 * ```text
 * preparation            still sequential and synchronous
 * durable lifecycle      one invocation per call, unchanged
 * result assembly        original call order, unchanged
 * ```
 *
 * ## The two conditions
 *
 * A call may join a parallel segment only when **both** hold:
 *
 * 1. it declares `PARALLEL_SAFE` — the opt-in that says "I read, I do not mutate";
 * 2. the Run is not under `ALWAYS_ASK`, because then *every* call can park on an approval, and a
 *    parked call in the middle of a parallel window would mean later calls ran before an earlier
 *    one was decided.
 *
 * 3. the host confirms that admission cannot request an approval. A Tool Guard can require approval
 *    under policies other than `ALWAYS_ASK`, so an unknown admission path also stays sequential.
 *
 * The last two conditions keep an earlier approval decision from being bypassed by a later sibling.
 */
export interface ToolBatchSegment {
  readonly kind: "SEQUENTIAL" | "PARALLEL";
  /** Inclusive index of the first call in this segment. */
  readonly start: number;
  /** Number of calls in this segment; always `>= 2` for a `PARALLEL` segment. */
  readonly count: number;
}

export interface ToolBatchPlanInput {
  readonly calls: readonly { readonly executionMode: ToolExecutionMode }[];
  readonly maxConcurrency: number;
  readonly approvalPolicy: ApprovalPolicy;
  /** Omitted means admission may pause a call for approval. */
  readonly admissionMayRequireApproval?: boolean;
  /** Set false to force the historical behaviour regardless of declared modes. */
  readonly enabled?: boolean;
}

export function planToolBatchSegments(input: ToolBatchPlanInput): readonly ToolBatchSegment[] {
  const { calls, approvalPolicy } = input;
  if (
    input.enabled === false ||
    approvalPolicy === "ALWAYS_ASK" ||
    input.admissionMayRequireApproval !== false ||
    input.maxConcurrency <= 1
  ) {
    return calls.map((_, index) => ({ kind: "SEQUENTIAL" as const, start: index, count: 1 }));
  }
  if (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1) {
    throw new RangeError("Tool batch maxConcurrency must be a safe positive integer.");
  }

  const segments: ToolBatchSegment[] = [];
  let index = 0;
  while (index < calls.length) {
    if (calls[index]?.executionMode !== "PARALLEL_SAFE") {
      segments.push({ kind: "SEQUENTIAL", start: index, count: 1 });
      index += 1;
      continue;
    }
    let end = index;
    while (end < calls.length && calls[end]?.executionMode === "PARALLEL_SAFE") end += 1;
    const runLength = end - index;
    if (runLength === 1) {
      // A single read is not a parallel window; saying so keeps the plan honest.
      segments.push({ kind: "SEQUENTIAL", start: index, count: 1 });
      index += 1;
      continue;
    }
    for (let cursor = index; cursor < end; cursor += input.maxConcurrency) {
      const count = Math.min(input.maxConcurrency, end - cursor);
      segments.push({
        kind: count > 1 ? "PARALLEL" : "SEQUENTIAL",
        start: cursor,
        count,
      });
    }
    index = end;
  }
  return segments;
}

/**
 * Run the indices through `run`, at most `maxConcurrency` at a time, preserving index order.
 *
 * It never rejects early and never drops a result: a parallel window is interpreted **after every
 * call in it has settled**, because a call that settled is a durable fact that the batch must
 * report regardless of what its siblings did.
 */
export async function runBoundedByIndex<T>(
  count: number,
  maxConcurrency: number,
  run: (index: number) => Promise<T>,
): Promise<readonly T[]> {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("Bounded run count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("Bounded run concurrency must be a safe positive integer.");
  }
  const results = new Array<T>(count);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(maxConcurrency, Math.max(count, 1)) }, async () => {
    for (;;) {
      if (failed) return;
      const index = cursor;
      cursor += 1;
      if (index >= count) return;
      try {
        results[index] = await run(index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}
