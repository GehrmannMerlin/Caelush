/**
 * What a Tool can promise about its effect on the world **before** it runs.
 *
 * ```text
 * READ_ONLY       it observes state and changes nothing
 * CONTROL_STATE   it writes bookkeeping the host owns (a plan, a task note), not the workspace
 * MAY_MUTATE      it changes something the model can also read
 * UNKNOWN         the declaration cannot prove either way
 * ```
 *
 * ## Why the general Agent needs this at all
 *
 * A batch can contain a call that never became executable — malformed arguments, a schema
 * rejection, a real execution failure. The remaining calls were chosen by a model that believed the
 * earlier ones had run (or had not), so running a *later mutating* call could apply a plan to a
 * state nobody observed. The batch coordinator can only answer that question if a Tool declares
 * something about its own effect, and the answer has to come from the Tool's own registration
 * rather than from its name, its argument text or a natural-language guess.
 *
 * ## Why it is deliberately this narrow
 *
 * There is no resource list, no dependency edge and no "independentOf" declaration in this version.
 * A general business DAG would need a trustworthy source of edges, and inventing one from command
 * strings is exactly the guessing the design forbids. Four classes are enough to make the two
 * decisions that matter:
 *
 * ```text
 * may this call run after an earlier call in the same batch failed?     READ_ONLY / CONTROL_STATE
 * may this call be planned concurrently with its siblings?              separate declaration
 * ```
 *
 * Concurrency is *not* derived from this class: a Tool still opts into a parallel window with its
 * own `executionMode`, and an unrecognised class never widens what runs.
 */
export type ToolSchedulingClass = "READ_ONLY" | "CONTROL_STATE" | "MAY_MUTATE" | "UNKNOWN";

/** The scheduling facts a Tool declares about itself. */
export interface ToolSchedulingFacts {
  readonly class: ToolSchedulingClass;
}

/** Every class, in canonical order. */
export const TOOL_SCHEDULING_CLASSES = [
  "READ_ONLY",
  "CONTROL_STATE",
  "MAY_MUTATE",
  "UNKNOWN",
] as const satisfies readonly ToolSchedulingClass[];

/**
 * What a Tool that declares nothing is treated as.
 *
 * `UNKNOWN`, not `READ_ONLY`: the absence of a declaration is the absence of proof, and a Tool that
 * mutates without saying so must never be scheduled past an earlier failure because of a default.
 */
export const DEFAULT_TOOL_SCHEDULING_FACTS: ToolSchedulingFacts = Object.freeze({
  class: "UNKNOWN",
});

/** True when the value is one of the frozen scheduling classes. */
export function isToolSchedulingClass(value: unknown): value is ToolSchedulingClass {
  return (
    typeof value === "string" && (TOOL_SCHEDULING_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Assert one Tool's scheduling declaration.
 *
 * The field set is exact, so a host cannot smuggle raw arguments, a resource path or a model-supplied
 * "independent" claim through this contract. Whatever a Tool cannot prove it must not declare.
 */
export function assertToolSchedulingFacts(value: unknown): asserts value is ToolSchedulingFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool scheduling facts must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== 1 || !Object.hasOwn(candidate, "class")) {
    throw new TypeError("Tool scheduling facts have an unsupported field set.");
  }
  if (!isToolSchedulingClass(candidate["class"])) {
    throw new TypeError("Tool scheduling class is unsupported.");
  }
}

/**
 * Whether a call of this class may run after an earlier call in the same batch did not complete.
 *
 * Only the two classes that cannot depend on unobserved state are allowed through. `MAY_MUTATE` and
 * `UNKNOWN` are withheld with an explicit "not executed" result, and the model may re-submit them
 * once it has corrected the failure — which is the whole point: nothing is retried behind its back.
 */
export function mayRunAfterEarlierFailure(facts: ToolSchedulingFacts): boolean {
  return facts.class === "READ_ONLY" || facts.class === "CONTROL_STATE";
}
