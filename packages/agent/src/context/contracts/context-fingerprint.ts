declare const ContextFingerprintBrand: unique symbol;

export type ContextFingerprint = string & { readonly [ContextFingerprintBrand]: true };

export function createContextFingerprint(value: string): ContextFingerprint {
  if (value.trim().length === 0) throw new TypeError("Context fingerprint must not be empty.");
  return value as ContextFingerprint;
}

export function assertContextFingerprint(value: unknown): asserts value is ContextFingerprint {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError("Context fingerprint must not be empty.");
}
