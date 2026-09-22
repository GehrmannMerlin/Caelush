/**
 * The compile-time seam a product layer extends to add its own message kinds.
 *
 * ```text
 * empty by declaration   a host adds an arm by declaration merging
 * ```
 *
 * A coding host that needs a message the general kernel has no business knowing about
 * writes:
 *
 * ```ts
 * declare module "@caelush/agent" {
 *   interface CustomAgentMessages {
 *     COMMAND_EXECUTION: CodingCommandExecutionMessage;
 *   }
 * }
 * ```
 *
 * and `AgentMessage` gains the arm without the kernel gaining the concept. Phase 5A
 * ships the seam and nothing behind it: it implements no custom message, no coding
 * command message and no product-specific arm, because the product-layer extension proof
 * belongs to Phase 5E. What this round establishes is that the extension point *exists*,
 * is typed, and is reached through the root export rather than a deep import.
 *
 * The interface is intentionally empty rather than `Record<string, never>`: a mapped
 * index signature would let any key through without a declaration, which is the opposite
 * of a deliberate extension.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a declaration-merging seam is empty by definition
export interface CustomAgentMessages {}
