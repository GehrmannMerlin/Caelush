import type { Capability } from "@caelush/protocol";

/**
 * What a Tool's declared metadata says it needs in order to run at all.
 *
 * ```text
 * IN_PROCESS        the Tool is inert: it reaches no filesystem, process or network boundary
 * HOST_RUNTIME      the Tool reaches the host, through capabilities the active runtime must support
 * INVALID           the declaration contradicts itself and nothing may be admitted from it
 * ```
 *
 * ## Why this is one function and not two checks
 *
 * The composition self-check and the runtime logical-sandbox admission used to each interpret
 * `requiredCapabilities` / `runtimeRequirements` for themselves. They disagreed in exactly one
 * combination — no capability and no runtime kind — which the startup check accepted as a
 * deliberately inert Tool and the runtime refused as an unsupported runtime. The result was a Tool
 * that could be registered, offered to a model and then always denied: `update_plan`, whose whole
 * job is to record a plan, could never record one.
 *
 * Two readers of one declaration must share one interpretation, so the interpretation lives here
 * and both call it. This is a *policy* function: it decides what the declaration means, and says
 * nothing about whether the current permission profile, approval policy or boundary allows the
 * Tool. That decision stays with the gate.
 *
 * ## What IN_PROCESS does not mean
 *
 * It does not mean "trusted because of its name", and it is not an OS sandbox. It means the Tool
 * declared no capability and no runtime requirement in the trusted, immutable catalog the host
 * injected, and — at admission time — that its security facts agree: no resource access and no
 * shell command. A declaration that says "inert" while projecting host effects is caught by
 * {@link declaresHostAccess}, not believed.
 */
export type ToolExecutionRequirement =
  | { readonly kind: "IN_PROCESS" }
  | { readonly kind: "HOST_RUNTIME"; readonly supportedRuntimeKinds: readonly string[] }
  | { readonly kind: "INVALID"; readonly reason: "METADATA_MISMATCH" };

/** The two declaration fields the requirement is resolved from, and nothing else. */
export interface ToolExecutionRequirementInput {
  readonly requiredCapabilities: readonly Capability[];
  /**
   * Structured runtime constraints, typed as `unknown` on purpose.
   *
   * The two packages that produce this value type their JSON object differently, and the difference is
   * nominal only — both are the same JSON. Rather than force one boundary to cast to the other's
   * spelling, this function takes the value it actually validates: an `unknown` that must carry a
   * `runtimeKinds` array of strings, checked here.
   */
  readonly runtimeRequirements: unknown;
}

/**
 * Resolve one Tool declaration into the execution shape it asks for.
 *
 * The accepted combinations are exactly the two coherent ones. A Tool that declares a capability
 * and no runtime cannot say how it reaches the host; a Tool that declares a runtime and no
 * capability is asking for host execution it never justified. Both are metadata defects, refused
 * rather than repaired: guessing which half was meant would invent an authorization.
 */
export function resolveToolExecutionRequirement(
  input: ToolExecutionRequirementInput,
): ToolExecutionRequirement {
  const capabilities = input.requiredCapabilities;
  const runtimeRequirements = input.runtimeRequirements;
  if (runtimeRequirements === null || typeof runtimeRequirements !== "object") {
    return { kind: "INVALID", reason: "METADATA_MISMATCH" };
  }
  if (!Array.isArray(capabilities)) {
    return { kind: "INVALID", reason: "METADATA_MISMATCH" };
  }
  const runtimeKinds = (runtimeRequirements as { readonly runtimeKinds?: unknown }).runtimeKinds;
  if (
    !Array.isArray(runtimeKinds) ||
    !runtimeKinds.every((value): value is string => typeof value === "string")
  ) {
    return { kind: "INVALID", reason: "METADATA_MISMATCH" };
  }
  if (capabilities.length === 0) {
    if (runtimeKinds.length > 0) return { kind: "INVALID", reason: "METADATA_MISMATCH" };
    return { kind: "IN_PROCESS" };
  }
  if (runtimeKinds.length === 0) return { kind: "INVALID", reason: "METADATA_MISMATCH" };
  return {
    kind: "HOST_RUNTIME",
    supportedRuntimeKinds: Object.freeze([...new Set(runtimeKinds)].sort()),
  };
}

/**
 * Whether a resolved security-fact bundle claims access to the host.
 *
 * It reads only the two facts that describe reaching outside the process: a resolved resource
 * access, and a shell command. Secret-scan inputs are deliberately not counted — a Tool may hold
 * text it wants scanned for secrets without thereby gaining the ability to read, write or execute
 * anything, and treating "there is text to redact" as host access would refuse the very Tools that
 * handle user input carefully.
 */
export function declaresHostAccess(facts: unknown): boolean {
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) return false;
  const record = facts as Record<string, unknown>;
  if (Array.isArray(record["resourceAccesses"]) && record["resourceAccesses"].length > 0) {
    return true;
  }
  return record["shellCommand"] !== undefined;
}
