/**
 * Where a model descriptor came from.
 *
 * The order is the frozen resolution precedence, strongest first:
 *
 * ```text
 * CONFIGURATION
 *   ↓
 * BUILTIN
 *   ↓
 * PROVIDER_DEFAULT
 *   ↓
 * DISCOVERED
 *   ↓
 * FALLBACK
 * ```
 */
export type ModelDescriptorSource =
  "CONFIGURATION" | "BUILTIN" | "PROVIDER_DEFAULT" | "DISCOVERED" | "FALLBACK";

/** The frozen precedence list, strongest first. Index is the precedence rank. */
export const MODEL_DESCRIPTOR_SOURCES = [
  "CONFIGURATION",
  "BUILTIN",
  "PROVIDER_DEFAULT",
  "DISCOVERED",
  "FALLBACK",
] as const satisfies readonly ModelDescriptorSource[];

/** True when the value is one of the frozen descriptor sources. */
export function isModelDescriptorSource(value: unknown): value is ModelDescriptorSource {
  return (
    typeof value === "string" && (MODEL_DESCRIPTOR_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Precedence rank of a descriptor source: `CONFIGURATION` is 0, `FALLBACK` is 4.
 *
 * Lower wins. Returns `undefined` for anything that is not a frozen source.
 */
export function modelDescriptorSourceRank(value: unknown): number | undefined {
  const index = (MODEL_DESCRIPTOR_SOURCES as readonly string[]).indexOf(value as string);
  return index === -1 ? undefined : index;
}

/** True when a descriptor came from safe defaults rather than an explicit model record. */
export function isFallbackDescriptorSource(source: ModelDescriptorSource): boolean {
  return source === "FALLBACK";
}
