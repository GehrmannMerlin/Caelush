import { z } from "zod";

const safePositiveInteger = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "must be a safe integer");
const safePositiveUsd = z
  .number()
  .finite()
  .positive()
  .refine(isSafePositiveMicroUsd, "must be representable as positive safe micro-USD");

export const RunLimitsSchema = z
  .object({
    maxSteps: safePositiveInteger,
    maxToolCalls: safePositiveInteger,
    timeoutMs: safePositiveInteger,
    maxTokens: safePositiveInteger.optional(),
    maxCost: safePositiveUsd.optional(),
  })
  .strict();
export type RunLimits = z.infer<typeof RunLimitsSchema>;

export const MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES = 32 * 1024;

export function isSafePositiveMicroUsd(value: number): boolean {
  try {
    const text = value.toString().toLowerCase();
    const [coefficient, exponentText] = text.split("e");
    const exponent = exponentText === undefined ? 0 : Number(exponentText);
    if (!Number.isSafeInteger(exponent)) return false;
    const [whole, fraction = ""] = coefficient!.split(".");
    const significant = BigInt(`${whole}${fraction}`);
    const decimalPlaces = fraction.length - exponent;
    const micros =
      decimalPlaces <= 6
        ? significant * 10n ** BigInt(6 - decimalPlaces)
        : significant / 10n ** BigInt(decimalPlaces - 6);
    return micros > 0n && micros <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}
