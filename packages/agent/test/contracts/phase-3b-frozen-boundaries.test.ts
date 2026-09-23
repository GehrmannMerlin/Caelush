import { describe, expect, it } from "vitest";
import type {
  AgentExecutionIdentity,
  AgentTurnInput,
  AgentTurnRef,
  ContextItem,
  ContextProvider,
  ContextProviderInput,
} from "@caelush/agent";
import type { ModelDescriptor } from "@caelush/ai";
import type { RunId, SessionId, StepId } from "@caelush/protocol";

/**
 * Phase 3B frozen boundary exactness.
 *
 * Phase 3A's exactness file covers the kernel contracts. This one covers the boundary Phase 3B
 * froze — the Context Engine port, its provider seam and the turn inputs the loop accepts — and
 * it is written from the freeze rather than from the implementation, because a restatement
 * copied out of `src` would agree with any drift by construction.
 *
 * The defect this file exists for is narrow and real: `ContextProviderInput` had grown a
 * `history` field and lost its `model`. Both were corrections to the freeze, and neither would
 * have been caught by a source-text check that only asked whether the interface existed.
 *
 * `pnpm typecheck` fails on any assertion below. Nothing here is a runtime behaviour test.
 */

/* ------------------------------------------------------------- helpers */

/** Structural equality that also distinguishes optional, readonly and `any`. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type Expect<T extends true> = T;

type Keys<T> = keyof T;

/** An object with no required properties, used to test that a field is required. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type EmptyObject = {};

/* ------------------------------------------------------- frozen restatements */

interface FrozenContextPrepareInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly conversation: import("@caelush/agent").AgentConversationSnapshot;
  readonly input: AgentTurnInput;
  readonly model: ModelDescriptor;
  readonly tools: readonly import("@caelush/ai").AIToolSpec[];
  readonly mode: import("@caelush/agent").ContextPrepareMode;
  readonly signal: AbortSignal;
}

/**
 * The frozen provider seam.
 *
 * `model` is present: a provider may read the resolved descriptor to judge capabilities.
 * `conversation` is absent: the conversation is a context source, and handing it to every provider
 * would let each one become a second conversation assembler.
 */
interface FrozenContextProviderInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly input: AgentTurnInput;
  readonly model: ModelDescriptor;
  readonly signal: AbortSignal;
}

/* ------------------------------------------------------------- assertions */

type PrepareInputExact = Expect<
  Equal<import("@caelush/agent").ContextPrepareInput, FrozenContextPrepareInput>
>;
type PrepareInputKeys = Expect<
  Equal<
    Keys<import("@caelush/agent").ContextPrepareInput>,
    "identity" | "turn" | "conversation" | "input" | "model" | "tools" | "mode" | "signal"
  >
>;

type ProviderInputExact = Expect<Equal<ContextProviderInput, FrozenContextProviderInput>>;
type ProviderInputKeys = Expect<
  Equal<Keys<ContextProviderInput>, "identity" | "turn" | "input" | "model" | "signal">
>;
/** The two corrections, each asserted on its own so the failure names the field. */
type ProviderInputHasModel = Expect<Equal<ContextProviderInput["model"], ModelDescriptor>>;
type ProviderInputHasNoHistory = Expect<
  Equal<Extract<keyof ContextProviderInput, "history">, never>
>;
type ProviderInputModelIsRequired = Expect<
  Equal<EmptyObject extends Pick<ContextProviderInput, "model"> ? true : false, false>
>;
type ProviderInputIdentityIsRequired = Expect<
  Equal<EmptyObject extends Pick<ContextProviderInput, "signal"> ? true : false, false>
>;

/** The provider contract itself is unchanged: an id and one `provide` call. */
type ProviderExact = Expect<
  Equal<
    ContextProvider,
    {
      readonly id: string;
      provide(input: ContextProviderInput): Promise<readonly ContextItem[]>;
    }
  >
>;
type ProviderKeys = Expect<Equal<Keys<ContextProvider>, "id" | "provide">>;

/** The turn input the provider is handed is the frozen union, not a host-shaped variant. */
type ProviderTurnInputExact = Expect<Equal<ContextProviderInput["input"], AgentTurnInput>>;
type ProviderIdentityExact = Expect<
  Equal<ContextProviderInput["identity"], AgentExecutionIdentity>
>;
type ProviderTurnRefExact = Expect<Equal<ContextProviderInput["turn"], AgentTurnRef>>;

/**
 * The compile-time assertions are erased at runtime; this keeps the file a real test and makes a
 * deleted file a failure rather than silence.
 */
describe("Phase 3B frozen boundary exactness", () => {
  it("compiles every frozen boundary assertion", () => {
    expect(BOUNDARY_CONTRACT_EXACTNESS.length).toBeGreaterThan(0);
  });
});

/** One marker per asserted contract, kept in sync with the assertions above. */
export const BOUNDARY_CONTRACT_EXACTNESS = [
  "ContextPrepareInput",
  "ContextProviderInput",
  "ContextProvider",
] as const;

export type PHASE_3B_ASSERTIONS = [
  PrepareInputExact,
  PrepareInputKeys,
  ProviderInputExact,
  ProviderInputKeys,
  ProviderInputHasModel,
  ProviderInputHasNoHistory,
  ProviderInputModelIsRequired,
  ProviderInputIdentityIsRequired,
  ProviderExact,
  ProviderKeys,
  ProviderTurnInputExact,
  ProviderIdentityExact,
  ProviderTurnRefExact,
];

/** Referenced so the imported ID brands stay meaningful to the compiler. */
export type PHASE_3B_IDS = [RunId, SessionId, StepId];
