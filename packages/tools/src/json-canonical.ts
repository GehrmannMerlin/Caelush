import type { JsonObject, JsonValue, ToolDefinition } from "@caelush/protocol";

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (typeof value === "object" && value !== null) {
    const clone: JsonObject = Object.create(null) as JsonObject;
    for (const [key, nestedValue] of Object.entries(value)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(nestedValue),
        writable: true,
      });
    }
    return clone;
  }
  return value;
}

export function cloneToolDefinition(definition: ToolDefinition): ToolDefinition {
  const copy: ToolDefinition = {
    name: definition.name,
    description: definition.description,
    inputSchema: cloneJsonValue(definition.inputSchema) as JsonObject,
    outputSchema: cloneJsonValue(definition.outputSchema) as JsonObject,
    riskLevel: definition.riskLevel,
    requiredCapabilities: [...definition.requiredCapabilities],
    runtimeRequirements: cloneJsonValue(definition.runtimeRequirements) as JsonObject,
  };
  deepFreezeJson(copy.inputSchema);
  deepFreezeJson(copy.outputSchema);
  deepFreezeJson(copy.runtimeRequirements);
  Object.freeze(copy.requiredCapabilities);
  return Object.freeze(copy);
}

export function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else if (typeof value === "object" && value !== null) {
    for (const nestedValue of Object.values(value)) deepFreezeJson(nestedValue);
  }
  return Object.freeze(value);
}

export function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const canonical: JsonObject = {};
    for (const [key, nestedValue] of entries) {
      Object.defineProperty(canonical, key, {
        configurable: true,
        enumerable: true,
        value: canonicalizeJsonValue(nestedValue),
        writable: true,
      });
    }
    return canonical;
  }
  return value;
}

export function canonicalJsonString(value: JsonValue): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

export function jsonUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
