import {
  assertContextSourceResult,
  type ContextSourceCollectionResult,
  type ContextSourceCriticality,
  type ContextSourceInput,
  type ContextSourceRegistration,
  type ContextSourceRegistry,
  type ContextSourceRegistryBuilder,
} from "./context-source.js";

export class ContextSourceCollectionError extends Error {
  readonly sourceId: string;
  readonly criticality: ContextSourceCriticality;

  constructor(sourceId: string, criticality: ContextSourceCriticality) {
    super(`Context source "${sourceId}" failed (${criticality.toLowerCase()}).`);
    this.name = "ContextSourceCollectionError";
    this.sourceId = sourceId;
    this.criticality = criticality;
  }
}

export function createContextSourceRegistryBuilder(): ContextSourceRegistryBuilder {
  const registrations: ContextSourceRegistration[] = [];
  const ids = new Set<string>();
  return {
    register(registration) {
      validateRegistration(registration);
      if (ids.has(registration.id))
        throw new RangeError(`Duplicate Context source id: ${registration.id}.`);
      ids.add(registration.id);
      registrations.push(registration);
      return this;
    },
    build(): ContextSourceRegistry {
      const ordered = [...registrations].sort(
        (left, right) => left.priority - right.priority || compareSourceIds(left.id, right.id),
      );
      const frozen = Object.freeze(
        ordered.map((registration) => Object.freeze({ ...registration })),
      );
      return Object.freeze({ list: () => frozen });
    },
  };
}

function compareSourceIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function collectContextSources(
  registry: ContextSourceRegistry,
  input: ContextSourceInput,
): Promise<readonly ContextSourceCollectionResult[]> {
  const results: ContextSourceCollectionResult[] = [];
  for (const registration of registry.list()) {
    try {
      if (input.signal.aborted)
        throw input.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      const result = await registration.provider.collect(input);
      assertContextSourceResult(result, registration.id);
      results.push(
        Object.freeze({
          ...result,
          items: Object.freeze([...result.items]),
          diagnostics: Object.freeze([...result.diagnostics]),
        }),
      );
    } catch (error) {
      if (isAbort(error, input.signal)) throw error;
      if (registration.criticality === "REQUIRED")
        throw new ContextSourceCollectionError(registration.id, registration.criticality);
      results.push(
        Object.freeze({
          providerId: registration.id,
          providerVersion: "unknown",
          items: Object.freeze([]),
          diagnostics: Object.freeze([
            {
              code: "SOURCE_FAILED",
              severity: "WARNING" as const,
              message: "Optional context source failed.",
              sourceRef: registration.id,
            },
          ]),
        }),
      );
    }
  }
  return Object.freeze(results);
}

function validateRegistration(registration: ContextSourceRegistration): void {
  if (registration === null || typeof registration !== "object")
    throw new TypeError("Context source registration must be an object.");
  if (typeof registration.id !== "string" || registration.id.trim().length === 0)
    throw new TypeError("Context source id must not be empty.");
  if (!Number.isSafeInteger(registration.priority) || registration.priority < 0)
    throw new RangeError("Context source priority must be a non-negative safe integer.");
  if (registration.criticality !== "REQUIRED" && registration.criticality !== "OPTIONAL")
    throw new TypeError("Context source criticality is invalid.");
  if (
    registration.provider === null ||
    typeof registration.provider !== "object" ||
    registration.provider.id !== registration.id
  )
    throw new TypeError("Context source provider id must match its registration.");
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
