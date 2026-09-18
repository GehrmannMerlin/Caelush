/**
 * The legacy JSON helper entry point.
 *
 * ```text
 * @caelush/tools  ──re-export──▶  @caelush/agent  (the canonical implementation)
 * ```
 *
 * There is no implementation here. Canonical serialization decides byte budgets, approval keys and
 * resource fingerprints, so a second copy would be a second answer to "are these the same bytes".
 */
export {
  canonicalJsonString,
  canonicalizeJsonValue,
  cloneJsonValue,
  deepFreezeJson,
  jsonUtf8ByteLength,
} from "@caelush/agent";
export { cloneToolDefinition } from "./legacy-definition.js";
