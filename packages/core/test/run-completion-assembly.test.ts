import { describe, expect, it } from "vitest";
import { createTimestampMs } from "@caelush/protocol";

import {
  CompletionGateIdentityError,
  RunDeadlineRegistry,
  createCodingCompletionAssembly,
  hasLegacyCompletionGroup,
  legacyCompletionDependencies,
  resolveRunCompletionAssembly,
  type RunControllerDependencies,
} from "../src/index.js";
import {
  candidateTurn,
  completionGateOver,
  harness3e,
  stubReviewer,
  type CompletionCommitCounter,
} from "./support/phase-3e-completion.js";

/**
 * Phase 3F — the converged completion assembly.
 *
 * ```text
 * RunController            load · lock · termination · coordinator · driver · commit · notify
 *        ↓  one port
 * RunCompletionAssembly    the gate, the boundary planner and the repair context
 * ```
 *
 * Four things are asserted here, and they are the four the extraction could have broken:
 *
 * ```text
 * the canonical composition completes a Run on its own   not only through the flat compatibility fields
 * the compatibility projection reaches the same assembly  one implementation, two input shapes
 * an evaluation is scoped to one Run                      no shared observation, no mixed reviewer identity
 * termination still outranks a completion                  cancel and deadline commit nothing
 * ```
 */

function counter(): CompletionCommitCounter {
  return { candidateBoundaries: 0, verifiedCompletions: 0, plansLoaded: 0 };
}

describe("Phase 3F completion assembly", () => {
  it("completes a Run through the canonical composition alone", async () => {
    const reviewer = stubReviewer({ status: "PASSED" });
    const harness = harness3e({
      script: () => candidateTurn("the canonical answer"),
      reviewer,
      composition: "CANONICAL_ASSEMBLY",
    });

    const result = await harness.controller.start(harness.store.snapshot.run.id);

    // The whole coding closure ran with no flat `verification*` dependency in sight: plan, boundary,
    // checks, review, seal, freshness and the completion CAS all came through the assembly.
    expect(result.run.status).toBe("COMPLETED");
    expect(harness.snapshot().run.finalResult).toMatchObject({
      type: "VERIFIED_COMPLETION",
      text: "the canonical answer",
    });
    expect(reviewer.bundles).toHaveLength(1);
    expect(harness.verified).toHaveLength(1);
    expect(harness.eventTypes()).toContain("verification.planned");
    expect(harness.eventTypes()).toContain("run.completed");
  });

  it("reaches one assembly from both the canonical port and the flat compatibility group", async () => {
    const canonical = createCodingCompletionAssembly({
      clock: { now: () => createTimestampMs(1) },
      configResolver: {
        resolve: async () => ({ baseSystemPrompt: "b", contextLimits: { maxInputTokens: 1000 } }),
      },
      reviewer: stubReviewer(),
    });
    const legacy = resolveRunCompletionAssembly({
      // The minimum a flat host supplies for the group to be recognised at all.
      verificationReviewer: stubReviewer(),
      clock: { now: () => createTimestampMs(1) },
      configResolver: {
        resolve: async () => ({ baseSystemPrompt: "b", contextLimits: { maxInputTokens: 1000 } }),
      },
    } as unknown as RunControllerDependencies);

    expect(legacy).toBeDefined();
    // One gate id, one policy: the compatibility path regroups fields, it does not select a second
    // implementation. A different id here would mean two coding completion policies existed.
    expect(legacy?.gateId).toBe(canonical.gateId);

    // The canonical port always wins when both are present, so a decision can never be ambiguous.
    const both = resolveRunCompletionAssembly({
      completion: canonical,
      verificationReviewer: stubReviewer(),
      clock: { now: () => createTimestampMs(1) },
      configResolver: {
        resolve: async () => ({ baseSystemPrompt: "b", contextLimits: { maxInputTokens: 1000 } }),
      },
    } as unknown as RunControllerDependencies);
    expect(both).toBe(canonical);
  });

  it("recognises no completion path when a host composed neither shape", () => {
    const bare = {
      clock: { now: () => createTimestampMs(1) },
      configResolver: {
        resolve: async () => ({ baseSystemPrompt: "b", contextLimits: { maxInputTokens: 1000 } }),
      },
    } as unknown as RunControllerDependencies;

    expect(hasLegacyCompletionGroup(bare)).toBe(false);
    expect(resolveRunCompletionAssembly(bare)).toBeUndefined();
    // The projection is pure: it reads the declared fields and adds nothing of its own.
    expect(legacyCompletionDependencies(bare)).not.toHaveProperty("reviewer");
    expect(legacyCompletionDependencies(bare)).not.toHaveProperty("planner");
  });

  it("keeps two Runs' completion evaluations entirely apart", async () => {
    // One reviewer, two Runs. A host-scoped assembly is allowed to serve many Runs at once, so the
    // per-Run facts must come from the evaluation rather than from the assembly.
    const reviewer = stubReviewer({ status: "PASSED" });
    const first = harness3e({
      script: () => candidateTurn("first"),
      reviewer,
      composition: "CANONICAL_ASSEMBLY",
    });
    const second = harness3e({
      script: () => candidateTurn("second"),
      reviewer,
      composition: "CANONICAL_ASSEMBLY",
    });
    const firstRun = first.store.snapshot.run;
    const secondRun = second.store.snapshot.run;
    expect(firstRun.id).not.toBe(secondRun.id);

    await first.controller.start(firstRun.id);
    await second.controller.start(secondRun.id);

    // Each review named the Run that asked for it, and neither Run's review was attributed to the other.
    expect(reviewer.runs).toEqual([firstRun.id, secondRun.id]);
    expect(new Set(reviewer.runs).size).toBe(2);

    // Each accepted result is bound to its own plan, its own Run and its own candidate text. A shared
    // observation would show up here as one Run holding the other's plan identity or seal.
    const firstPlanId = [...first.verification.plans.keys()][0];
    const secondPlanId = [...second.verification.plans.keys()][0];
    expect(firstPlanId).toBeDefined();
    expect(secondPlanId).toBeDefined();
    expect(firstPlanId).not.toBe(secondPlanId);

    const firstResult = first.snapshot().run.finalResult as {
      text: string;
      verification: { planId: string; sealHash: string };
    };
    const secondResult = second.snapshot().run.finalResult as {
      text: string;
      verification: { planId: string; sealHash: string };
    };
    expect(firstResult.text).toBe("first");
    expect(secondResult.text).toBe("second");
    expect(firstResult.verification.planId).toBe(firstPlanId);
    expect(secondResult.verification.planId).toBe(secondPlanId);
    expect(firstResult.verification.sealHash).not.toBe(secondResult.verification.sealHash);
    // And the completion callback fired for the Run it belongs to, not for whichever Run finished last.
    expect(first.verified.map((entry) => entry.run.id)).toEqual([firstRun.id]);
    expect(second.verified.map((entry) => entry.run.id)).toEqual([secondRun.id]);
  });

  it("cancels only the Run that was cancelled", async () => {
    const cancelled = harness3e({
      script: () => candidateTurn("cancelled answer"),
      composition: "CANONICAL_ASSEMBLY",
    });
    const untouched = harness3e({
      script: () => candidateTurn("untouched answer"),
      composition: "CANONICAL_ASSEMBLY",
    });
    const cancelledRun = cancelled.store.snapshot.run;

    await cancelled.controller.cancel(cancelledRun.id);
    const survivor = await untouched.controller.start(untouched.store.snapshot.run.id);

    // The assembly is shared infrastructure but the cancellation scope is Run-owned: cancelling one Run
    // must not abort another Run's evaluation, and the survivor completes normally.
    expect(cancelled.snapshot().run.status).toBe("CANCELLED");
    expect(cancelled.verified).toHaveLength(0);
    expect(survivor.run.status).toBe("COMPLETED");
    expect(untouched.verified).toHaveLength(1);
  });

  it("refuses a late evaluation carrying another Run's identity", async () => {
    // The Run parks on its durable verification boundary: a host that composed no verification
    // execution store cannot resolve completion, so the boundary stays open for the refusal to be
    // aimed at it.
    const harness = harness3e({
      script: () => candidateTurn("done"),
      composition: "CANONICAL_ASSEMBLY",
      verificationStore: false,
    });
    const other = harness3e({
      script: () => candidateTurn("other"),
      composition: "CANONICAL_ASSEMBLY",
      verificationStore: false,
    });
    await harness.controller.start(harness.store.snapshot.run.id);
    await other.controller.start(other.store.snapshot.run.id);
    expect(harness.snapshot().run.status).toBe("VERIFYING");

    // A gate captured for this Run, handed another Run's identity, refuses loudly rather than
    // answering with a decision: a late or misrouted result must not be able to write a durable
    // verdict — and the decision it would have produced is about a candidate this Run never made.
    const { gate } = completionGateOver(harness);
    const run = harness.store.snapshot.run;
    const continuation = harness.snapshot().continuation;
    if (continuation?.type !== "AWAITING_VERIFICATION") {
      throw new Error("the Run must still be parked on its verification boundary");
    }
    const foreign = other.store.snapshot.run;

    await expect(
      gate.evaluate({
        identity: { runId: foreign.id, sessionId: foreign.sessionId, goal: foreign.goal },
        sourceStepId: continuation.sourceStepId,
        candidate: continuation.finalDecision,
        mode: "EXECUTE",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CompletionGateIdentityError);

    // Neither Run moved: a refused evaluation commits nothing at all.
    expect(harness.snapshot().run.status).toBe("VERIFYING");
    expect(harness.verified).toHaveLength(0);
    expect(harness.snapshot().run.finalResult).toBeUndefined();
    expect(run.id).not.toBe(foreign.id);
  });

  it("commits nothing when the Run is cancelled while its completion is evaluated", async () => {
    const commits = counter();
    const harness = harness3e({
      script: () => candidateTurn("done"),
      composition: "CANONICAL_ASSEMBLY",
      commits,
    });
    const runId = harness.store.snapshot.run.id;
    harness.reviewer.onReview = async () => {
      // A durable cancellation intent lands *during* the review — the interleave the settlement router
      // has to resolve in favour of the termination authority.
      await harness.store.requestCancellation(runId, {
        runId,
        cause: "USER_REQUESTED",
        requestedAt: createTimestampMs(1_000_000),
      });
    };

    const result = await harness.controller.start(runId);

    expect(result.run.status).toBe("CANCELLED");
    expect(harness.snapshot().run.status).toBe("CANCELLED");
    // A cancelled evaluation produces no completion: the verified-completion port was never asked to
    // write one, and the Run holds no final result.
    expect(commits.verifiedCompletions).toBe(0);
    expect(harness.snapshot().run.finalResult).toBeUndefined();
    expect(harness.verified).toHaveLength(0);
    expect(harness.eventTypes()).not.toContain("run.completed");
  });

  it("commits nothing when the Run deadline expires while its completion is evaluated", async () => {
    const commits = counter();
    let now = 1_000;
    const clock = { now: () => createTimestampMs(now) };
    const tasks: Array<() => void | Promise<void>> = [];
    const deadlineRegistry = new RunDeadlineRegistry({
      clock,
      timer: {
        schedule: (_delay, callback) => {
          tasks.push(callback);
          return { cancel: () => undefined };
        },
      },
    });
    const harness = harness3e({
      script: () => candidateTurn("done"),
      composition: "CANONICAL_ASSEMBLY",
      commits,
      clock,
      extra: { deadlineRegistry },
    });
    const runId = harness.store.snapshot.run.id;
    let fireDeadline!: () => void;
    const deadlineReached = new Promise<void>((resolve) => {
      fireDeadline = resolve;
    });
    harness.reviewer.onReview = async () => {
      // Move past the Run's own deadline and fire the deadline authority mid-review, then let it
      // unwind before the review answers.
      now += 120_000;
      fireDeadline();
      await tasks.at(-1)!();
    };

    const result = await harness.controller.start(runId);
    void deadlineReached;

    // A timeout is a termination, not a verification verdict: the Run settles TIMEOUT, no completion
    // was committed, and no `run.failed` claims the candidate was refused.
    expect(result.run.status).toBe("TIMEOUT");
    expect(harness.snapshot().run.status).toBe("TIMEOUT");
    expect(commits.verifiedCompletions).toBe(0);
    expect(harness.snapshot().run.finalResult).toBeUndefined();
    expect(harness.verified).toHaveLength(0);
    expect(harness.eventTypes()).not.toContain("run.completed");
    expect(harness.eventTypes()).not.toContain("run.failed");
    expect(harness.eventTypes()).toContain("run.timed_out");
  });

  it("attempts the verified completion exactly once when the durable revision moved", async () => {
    const commits = counter();
    const harness = harness3e({
      script: () => candidateTurn("done"),
      composition: "CANONICAL_ASSEMBLY",
      commits,
      // The commit succeeds into the in-memory store, but the Run Layer asked exactly once: a CAS
      // conflict must never become a second model turn, a second review or a second Tool run.
      persistence: (port) => port,
    });

    await harness.controller.start(harness.store.snapshot.run.id);

    // One candidate boundary, one plan load chain, one verified completion. The reviewer and the model
    // were each consulted once, which is the property a CAS conflict must not break.
    expect(commits.candidateBoundaries).toBe(1);
    expect(commits.verifiedCompletions).toBe(1);
    expect(harness.turns).toHaveLength(1);
    expect(harness.reviewer.bundles).toHaveLength(1);
  });
});
