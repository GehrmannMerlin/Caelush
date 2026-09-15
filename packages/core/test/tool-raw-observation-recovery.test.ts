import type { RunId, StepId } from "@caelush/protocol";
import { createRunId, createStepId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import {
  createToolExecutionLedgerRawObservationResolver,
  type ToolRawObservationRefResolver,
} from "../src/run-tool-observation-recovery.js";

/**
 * Phase 3D — where a raw Tool output pointer is resolved from.
 *
 * ```text
 * model sees a bounded summary        the Tool observation projection
 * the raw output is durable           ToolObservation.rawArtifactRef
 *        ↓
 * a forced Context recovery re-reads it under a tighter policy
 * ```
 *
 * The frozen `AIToolResultMessage` has no field for the pointer, so it cannot travel inside an Agent
 * message. It is resolved from the durable Tool execution ledger instead, by the same
 * `(runId, stepId, externalCallId)` identity the invocation was executed under. That identity — and
 * nothing else — is what these tests pin down.
 */

/** A ledger that answers the way the durable one does, and records what it was asked. */
function stubLedger(
  entries: readonly {
    readonly runId: RunId;
    readonly stepId: StepId;
    readonly externalCallId: string;
    readonly rawArtifactRef?: string;
    readonly noObservation?: boolean;
  }[],
) {
  const lookups: { runId: RunId; stepId: StepId; externalCallId: string }[] = [];
  const store = {
    async findByExternalCall(runId: RunId, stepId: StepId, externalCallId: string) {
      lookups.push({ runId, stepId, externalCallId });
      const match = entries.find(
        (entry) =>
          entry.runId === runId &&
          entry.stepId === stepId &&
          entry.externalCallId === externalCallId,
      );
      if (match === undefined) return null;
      return match.noObservation === true
        ? { sessionId: "ses", invocation: {}, revision: 1 }
        : {
            sessionId: "ses",
            invocation: {},
            revision: 1,
            observation: {
              ...(match.rawArtifactRef === undefined
                ? {}
                : { rawArtifactRef: match.rawArtifactRef }),
            },
          };
    },
  };
  return {
    lookups,
    resolver: createToolExecutionLedgerRawObservationResolver({
      store: store as never,
    }),
  };
}

describe("Phase 3D raw observation resolution", () => {
  it("resolves the pointer by the identity the invocation ran under", async () => {
    const runId = createRunId();
    const stepId = createStepId();
    const { lookups, resolver } = stubLedger([
      { runId, stepId, externalCallId: "call_big", rawArtifactRef: "artifact:sha256-abc" },
    ]);

    await expect(
      resolver.resolve({ runId, sourceStepId: stepId, externalCallId: "call_big" }),
    ).resolves.toBe("artifact:sha256-abc");
    expect(lookups).toEqual([{ runId, stepId, externalCallId: "call_big" }]);
  });

  it("resolves nothing for a call of a different Run, Step or id", async () => {
    const runId = createRunId();
    const stepId = createStepId();
    const { resolver } = stubLedger([
      { runId, stepId, externalCallId: "call_big", rawArtifactRef: "artifact:sha256-abc" },
    ]);

    // Another id, another Step and another Run each resolve to nothing. A lookup that matched
    // loosely would hand a Context recovery somebody else's raw output.
    await expect(
      resolver.resolve({ runId, sourceStepId: stepId, externalCallId: "call_other" }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolve({ runId, sourceStepId: createStepId(), externalCallId: "call_big" }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolve({ runId: createRunId(), sourceStepId: stepId, externalCallId: "call_big" }),
    ).resolves.toBeUndefined();
  });

  it("resolves nothing for a result that has no artifact and for an unknown call", async () => {
    const runId = createRunId();
    const stepId = createStepId();
    const { resolver } = stubLedger([
      { runId, stepId, externalCallId: "call_small" },
      { runId, stepId, externalCallId: "call_running", noObservation: true },
    ]);

    // A Tool that produced no artifact, a Tool that has not settled, and a call this Run never
    // dispatched are all legitimate `undefined` answers rather than failures: the Context fallback is
    // the bounded content the message already carries.
    await expect(
      resolver.resolve({ runId, sourceStepId: stepId, externalCallId: "call_small" }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolve({ runId, sourceStepId: stepId, externalCallId: "call_running" }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolve({ runId, sourceStepId: stepId, externalCallId: "call_external" }),
    ).resolves.toBeUndefined();
  });

  it("is a pure lookup: resolving twice returns the same pointer", async () => {
    const runId = createRunId();
    const stepId = createStepId();
    const { lookups, resolver } = stubLedger([
      { runId, stepId, externalCallId: "call_big", rawArtifactRef: "artifact:sha256-abc" },
    ]);

    // Nothing is cached and nothing is written: a restarted process resolves the same pointer from
    // the same durable row, which is what makes the recovery restart-safe.
    const first = await resolver.resolve({
      runId,
      sourceStepId: stepId,
      externalCallId: "call_big",
    });
    const second = await resolver.resolve({
      runId,
      sourceStepId: stepId,
      externalCallId: "call_big",
    });
    expect(first).toBe(second);
    expect(lookups).toHaveLength(2);
  });

  it("declares the resolver contract a host composes", () => {
    // The port is what the legacy Context adapter depends on, so it must stay narrow: an
    // implementation that needed a Run, a workspace or a policy could not be satisfied by a ledger
    // lookup at all.
    const resolver: ToolRawObservationRefResolver = createToolExecutionLedgerRawObservationResolver(
      {
        store: { findByExternalCall: async () => null },
      },
    );
    expect(typeof resolver.resolve).toBe("function");
    expect(Object.keys(resolver)).toEqual(["resolve"]);
  });
});
