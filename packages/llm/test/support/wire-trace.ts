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
  readonly inputSchemaHashes: readonly string[];
  readonly schemaMatrix: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchemaHash: string;
    readonly schemaHash: string;
  }[];
}

const MAX_STRING_BYTES = 256;
const MAX_MESSAGES = 128;
const MAX_TOOLS = 64;
const MAX_MAX_TOKENS = 1_000_000;

const forbiddenKeys = new Set([
  "apiKey",
  "api_key",
  "authorization",
  "headers",
  "execute",
  "outputSchema",
  "riskLevel",
  "requiredCapabilities",
  "runtimeRequirements",
  "arguments",
  "rawArguments",
  "input",
  "details",
  "output",
  "stdout",
  "stderr",
]);

const wireRequestKeys = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
  "temperature",
  "max_tokens",
]);

export function assertSafeWireRequestBody(input: unknown): void {
  const body = asRecord(input, "wire request");
  assertAllowedKeys(body, wireRequestKeys, "wire request");
  boundedString(body.model, "model");

  const messages = asArray(body.messages, "messages");
  if (messages.length > MAX_MESSAGES) throw new Error("wire request contains too many messages");
  for (const message of messages) {
    const record = asRecord(message, "message");
    assertAllowedKeys(record, new Set(["role", "content"]), "message");
    const role = boundedString(record.role, "message role");
    if (role !== "system" && role !== "user") throw new Error("unsupported wire message role");
    boundedString(record.content, "message content");
  }

  const tools = body.tools === undefined ? [] : asArray(body.tools, "tools");
  if (tools.length > MAX_TOOLS) throw new Error("wire request contains too many tools");
  const names = new Set<string>();
  for (const tool of tools) {
    const toolRecord = asRecord(tool, "tool");
    assertAllowedKeys(toolRecord, new Set(["type", "function"]), "tool");
    if (toolRecord.type !== "function") throw new Error("wire tool must be a function");
    const functionRecord = asRecord(toolRecord.function, "tool function");
    assertAllowedKeys(
      functionRecord,
      new Set(["name", "description", "parameters"]),
      "tool function",
    );
    const name = boundedString(functionRecord.name, "tool name");
    if (names.has(name)) throw new Error(`duplicate tool name: ${name}`);
    names.add(name);
    boundedString(functionRecord.description, "tool description");
    assertObjectSchema(functionRecord.parameters, name);
  }

  if (body.tool_choice !== undefined) assertToolChoiceShape(body.tool_choice);
  if (body.stream !== undefined && body.stream !== true)
    throw new Error("wire stream must be true");
  if (body.stream_options !== undefined) {
    const streamOptions = asRecord(body.stream_options, "stream options");
    assertAllowedKeys(streamOptions, new Set(["include_usage"]), "stream options");
    if (streamOptions.include_usage !== true)
      throw new Error("wire usage streaming must be enabled");
  }
  if (body.temperature !== undefined) assertTemperature(body.temperature);
  if (body.max_tokens !== undefined) assertMaxTokens(body.max_tokens);
  assertNoForbiddenKeys(body);
}

export function normalizeWireRequest(input: unknown): WireRequestTrace {
  assertSafeWireRequestBody(input);
  const body = asRecord(input, "wire request");
  const model = boundedString(body.model, "model");
  const messages = asArray(body.messages, "messages");
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
  const inputSchemaHashes: string[] = [];
  const schemaMatrix: Array<WireRequestTrace["schemaMatrix"][number]> = [];
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
    const inputSchemaHash = sha256(canonicalJson(inputSchema));
    const schemaHash = sha256(canonicalJson({ name, description, inputSchema }));
    inputSchemaHashes.push(inputSchemaHash);
    hashes.push(schemaHash);
    schemaMatrix.push({ name, description, inputSchemaHash, schemaHash });
  }

  const toolChoice = normalizeToolChoice(body.tool_choice);
  const metadata: Record<string, string | number | boolean> = {
    messageCount: messages.length,
    toolCount: tools.length,
    hasTools: tools.length > 0,
  };
  if (body.temperature !== undefined) metadata.temperature = body.temperature as number;
  if (body.max_tokens !== undefined) metadata.maxTokens = body.max_tokens as number;
  return {
    model,
    roleSequence,
    roleCounts,
    toolCount: names.length,
    toolNames: names,
    schemaHashes: hashes,
    toolChoice,
    metadata,
    inputSchemaHashes,
    schemaMatrix,
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
    if (
      typeof propertyRecord.type !== "string" ||
      !["array", "boolean", "integer", "null", "number", "object", "string"].includes(
        propertyRecord.type,
      )
    ) {
      throw new Error(`${toolName}.${field} property has no type`);
    }
  }
  return schema;
}

function normalizeToolChoice(
  value: unknown,
): string | Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value !== "auto" && value !== "none" && value !== "required") {
      throw new Error("unsupported tool choice");
    }
    return boundedString(value, "tool choice");
  }
  const record = asRecord(value, "tool choice");
  assertAllowedKeys(record, new Set(["type", "function"]), "tool choice");
  const type = boundedString(record.type, "tool choice type");
  if (type !== "function") throw new Error("unsupported tool choice type");
  const functionRecord =
    record.function === undefined ? undefined : asRecord(record.function, "tool choice function");
  if (functionRecord === undefined) return { type };
  assertAllowedKeys(functionRecord, new Set(["name"]), "tool choice function");
  return { type, name: boundedString(functionRecord.name, "tool choice name") };
}

function assertToolChoiceShape(value: unknown): void {
  if (typeof value === "string") {
    if (value !== "auto" && value !== "none" && value !== "required") {
      throw new Error("unsupported tool choice");
    }
    return;
  }
  const record = asRecord(value, "tool choice");
  assertAllowedKeys(record, new Set(["type", "function"]), "tool choice");
  if (record.type !== "function") throw new Error("unsupported tool choice type");
  const functionRecord = asRecord(record.function, "tool choice function");
  assertAllowedKeys(functionRecord, new Set(["name"]), "tool choice function");
  boundedString(functionRecord.name, "tool choice name");
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field`);
  }
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error("wire request contains a forbidden field");
    assertNoForbiddenKeys(nested);
  }
}

function assertTemperature(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error("wire temperature is outside its safe range");
  }
}

function assertMaxTokens(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MAX_TOKENS
  ) {
    throw new Error("wire max tokens is outside its safe range");
  }
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
