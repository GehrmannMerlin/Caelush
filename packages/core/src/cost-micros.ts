const MICROS_PER_USD = 1_000_000n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type CostMicros = number & { readonly __brand: "CostMicros" };

export function usdToCostMicros(value: number): CostMicros {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("USD cost must be finite and positive.");
  }
  const text = value.toString().toLowerCase();
  const [coefficient, exponentText] = text.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent)) throw new RangeError("USD exponent is unsafe.");
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`;
  const significant = BigInt(digits);
  const decimalPlaces = fraction.length - exponent;
  const micros =
    decimalPlaces <= 6
      ? significant * 10n ** BigInt(6 - decimalPlaces)
      : significant / 10n ** BigInt(decimalPlaces - 6);
  return asSafeCostMicros(micros);
}

export function costMicrosForTokens(
  tokens: number,
  rateMicrosPerMillionTokens: number,
): CostMicros {
  assertSafeNonNegative(tokens, "token count");
  assertSafeNonNegative(rateMicrosPerMillionTokens, "pricing rate");
  const numerator = BigInt(tokens) * BigInt(rateMicrosPerMillionTokens);
  const micros = (numerator + MICROS_PER_USD - 1n) / MICROS_PER_USD;
  return asSafeCostMicros(micros, true);
}

export function addCostMicros(...values: readonly number[]): CostMicros {
  let total = 0n;
  for (const value of values) {
    assertSafeNonNegative(value, "cost");
    total += BigInt(value);
  }
  return asSafeCostMicros(total, true);
}

function asSafeCostMicros(value: bigint, allowZero = false): CostMicros {
  if ((allowZero ? value < 0n : value <= 0n) || value > MAX_SAFE_BIGINT) {
    throw new RangeError("cost is outside the non-negative safe micro-USD range.");
  }
  return Number(value) as CostMicros;
}

function assertSafeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}
