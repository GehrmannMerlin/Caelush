import { createHash } from "node:crypto";

export interface WireRequestTrace {
  readonly model: string;
  readonly roleSequence: readonly string[];
  readonly roleCounts: Readonly<Record<string, number>>;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly schemaHashes: readonly string[];
  readonly toolChoice: string | Readonly<Record<string, string>> | undefined;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

const MAX_STRING_BYTES = 256;
const MAX_TOOLS = 64;

export function normalizeWireRequest(input: unknown): WireRequestTrace {
  const body = asRecord(input, "wire request");
  const model = boundedString(body.model, "model");
  const messages = body.messages === undefined ? [] : asArray(body.messages, "messages");
  const roleSequence: string[] = [];
  const roleCounts: Record<string, number> = {};
  for (const message of messages) {
    const role = boundedString(asRecord(message, "message").role, "message role");
    roleSequence.push(role);
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
  }

  const tools = body.tools === undefined ? [] : asArray(body.tools, "tools");
  if (tools.length > MAX_TOOLS) throw new Error("wire request contains too many tools");
  const names: string[] = [];
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const functionTool = asRecord(asRecord(tool, "tool").function, "tool function");
    const name = boundedString(functionTool.name, "tool name");
    const description = boundedString(functionTool.description, "tool description");
    if (description.length === 0) throw new Error(`tool ${name} has an empty description`);
    if (seen.has(name)) throw new Error(`duplicate tool name: ${name}`);
    seen.add(name);
    const inputSchema = assertObjectSchema(functionTool.parameters, name);
    names.push(name);
    hashes.push(sha256(canonicalJson({ name, description, inputSchema })));
  }

  const toolChoice = normalizeToolChoice(body.tool_choice);
  const metadata: Record<string, string | number | boolean> = {
    messageCount: messages.length,
    hasTools: tools.length > 0,
  };
  if (typeof body.temperature === "number") metadata.temperature = body.temperature;
  if (typeof body.max_tokens === "number") metadata.maxTokens = body.max_tokens;
  return {
    model,
    roleSequence,
    roleCounts,
    toolCount: names.length,
    toolNames: names,
    schemaHashes: hashes,
    toolChoice,
    metadata,
  };
}

function assertObjectSchema(value: unknown, toolName: string): Record<string, unknown> {
  const schema = asRecord(value, `${toolName} input schema`);
  if (schema.type !== "object") throw new Error(`${toolName} schema must have object root`);
  if (schema.additionalProperties !== false) {
    throw new Error(`${toolName} schema must disable additional properties`);
  }
  const properties = asRecord(schema.properties, `${toolName} properties`);
  const required =
    schema.required === undefined ? [] : asArray(schema.required, `${toolName} required`);
  const propertyNames = new Set(Object.keys(properties));
  for (const field of required) {
    if (typeof field !== "string" || !propertyNames.has(field)) {
      throw new Error(`${toolName} required field is not a property`);
    }
  }
  for (const [field, property] of Object.entries(properties)) {
    const propertyRecord = asRecord(property, `${toolName}.${field} property`);
    if (typeof propertyRecord.type !== "string" || propertyRecord.type.length === 0) {
      throw new Error(`${toolName}.${field} property has no type`);
    }
  }
  return schema;
}

function normalizeToolChoice(
  value: unknown,
): string | Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return boundedString(value, "tool choice");
  const record = asRecord(value, "tool choice");
  const type = boundedString(record.type, "tool choice type");
  const functionRecord =
    record.function === undefined ? undefined : asRecord(record.function, "tool choice function");
  if (functionRecord === undefined) return { type };
  return { type, name: boundedString(functionRecord.name, "tool choice name") };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
