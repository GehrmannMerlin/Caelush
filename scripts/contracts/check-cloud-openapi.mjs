import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_CLOUD_OPENAPI_PATH = path.join(
  REPOSITORY_ROOT,
  "docs",
  "architecture",
  "desktop",
  "cloud-api-v1.openapi.json",
);

export const REQUIRED_CLOUD_OPERATIONS = Object.freeze({
  "/v1/auth/register": ["post", "registerAccount"],
  "/v1/auth/verify-email": ["post", "verifyEmailAddress"],
  "/v1/auth/resend-verification": ["post", "resendEmailVerification"],
  "/v1/auth/login": ["post", "login"],
  "/v1/auth/refresh": ["post", "refreshSession"],
  "/v1/auth/logout": ["post", "logoutSession"],
  "/v1/auth/forgot-password": ["post", "requestPasswordReset"],
  "/v1/auth/reset-password": ["post", "resetPassword"],
  "/v1/auth/change-password": ["post", "changePassword"],
  "/v1/account/me": ["get", "getCurrentAccount"],
  "/v1/account/devices": ["get", "listAccountDevices"],
  "/v1/account/devices/{deviceId}": ["delete", "revokeAccountDevice"],
  "/v1/desktop/update-policy": ["get", "getDesktopUpdatePolicy"],
});

const REQUIRED_SCHEMA_NAMES = [
  "RequestId",
  "CloudError",
  "ApiErrorResponse",
  "AccountView",
  "DeviceView",
  "AccountEntitlement",
  "AuthTokens",
  "AuthResult",
  "OfflineGrantEnvelope",
  "DesktopUpdatePolicy",
  "DesktopRelease",
  "SignedUpdatePolicyEnvelope",
];

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const HANDLED_SCHEMA_KEYWORDS = new Set([
  "type",
  "format",
  "const",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "enum",
  "required",
  "properties",
  "items",
  "oneOf",
]);

/** @param {unknown} document @returns {string[]} */
export function validateCloudOpenApi(document) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(document)) return ["OpenAPI document must be a JSON object."];
  if (document.openapi !== "3.1.0") errors.push("openapi must be 3.1.0.");
  if (!isRecord(document.info) || document.info.version !== "1.0.0") {
    errors.push("info.version must be the Cloud contract version 1.0.0.");
  }
  if (document.info?.["x-caelush-contract-status"] !== "CONTRACT_FIRST_D0-B") {
    errors.push("The contract-first D0-B status marker is required.");
  }
  if (document["x-caelush-api-base-path"] !== "/v1") {
    errors.push("x-caelush-api-base-path must be /v1.");
  }
  const paths = isRecord(document.paths) ? document.paths : {};
  for (const pathName of Object.keys(REQUIRED_CLOUD_OPERATIONS)) {
    if (!Object.hasOwn(paths, pathName)) errors.push(`Missing required endpoint ${pathName}.`);
  }
  for (const pathName of Object.keys(paths)) {
    if (!Object.hasOwn(REQUIRED_CLOUD_OPERATIONS, pathName)) {
      errors.push(
        `Unexpected endpoint ${pathName}; Cloud V1 is restricted to the frozen API list.`,
      );
      continue;
    }
    if (!isRecord(paths[pathName])) {
      errors.push(`${pathName}: path item must be an object.`);
      continue;
    }
    const expected = REQUIRED_CLOUD_OPERATIONS[pathName];
    const actualMethods = Object.keys(paths[pathName]).filter((key) => HTTP_METHODS.has(key));
    if (actualMethods.length !== 1 || actualMethods[0] !== expected[0]) {
      errors.push(`${pathName}: expected only ${expected[0].toUpperCase()} for this endpoint.`);
    }
  }

  const operationIds = new Set();
  for (const [pathName, [method, expectedOperationId]] of Object.entries(
    REQUIRED_CLOUD_OPERATIONS,
  )) {
    const pathItem = paths[pathName];
    const operation = isRecord(pathItem) ? pathItem[method] : undefined;
    if (!isRecord(operation)) {
      errors.push(`${method.toUpperCase()} ${pathName}: operation is missing.`);
      continue;
    }
    if (operation.operationId !== expectedOperationId) {
      errors.push(
        `${method.toUpperCase()} ${pathName}: operationId must be ${expectedOperationId}.`,
      );
    }
    if (typeof operation.operationId === "string") {
      if (operationIds.has(operation.operationId))
        errors.push(`Duplicate operationId ${operation.operationId}.`);
      operationIds.add(operation.operationId);
    }
    validateOperation(document, pathName, method, operation, errors);
  }

  validateComponents(document, errors);
  validateLocalReferences(document, errors);
  return [...new Set(errors)];
}

/** @param {unknown} baseline @param {unknown} candidate @returns {string[]} */
export function compareCloudOpenApiContracts(baseline, candidate) {
  if (!isRecord(baseline) || !isRecord(candidate)) {
    return ["Both OpenAPI baseline and candidate must be JSON objects."];
  }
  /** @type {string[]} */
  const errors = [];
  reportUndeterminedChanges(
    baseline,
    candidate,
    new Set(["openapi", "paths", "components", "x-caelush-api-base-path"]),
    "OpenAPI document",
    "DOCUMENT_FIELD_CHANGED",
    errors,
  );
  const baselineComponents = isRecord(baseline.components) ? baseline.components : {};
  const candidateComponents = isRecord(candidate.components) ? candidate.components : {};
  reportUndeterminedChanges(
    baselineComponents,
    candidateComponents,
    new Set(["schemas", "securitySchemes", "parameters", "headers", "responses", "requestBodies"]),
    "OpenAPI components",
    "COMPONENTS_FIELD_CHANGED",
    errors,
  );
  for (const section of [
    "securitySchemes",
    "parameters",
    "headers",
    "responses",
    "requestBodies",
  ]) {
    if (stableJson(baselineComponents[section]) !== stableJson(candidateComponents[section])) {
      errors.push(
        `UNDETERMINED COMPONENTS_FIELD_CHANGED: components.${section} changed; manual compatibility review is required.`,
      );
    }
  }
  const baselinePaths = isRecord(baseline.paths) ? baseline.paths : {};
  const candidatePaths = isRecord(candidate.paths) ? candidate.paths : {};

  for (const [pathName, baselineItem] of Object.entries(baselinePaths)) {
    if (!isRecord(baselineItem)) continue;
    const candidateItem = candidatePaths[pathName];
    if (!isRecord(candidateItem)) {
      errors.push(`BREAKING ENDPOINT_REMOVED: ${pathName} was removed.`);
      continue;
    }
    reportUndeterminedChanges(
      baselineItem,
      candidateItem,
      HTTP_METHODS,
      `${pathName} path item`,
      "PATH_ITEM_FIELD_CHANGED",
      errors,
    );
    for (const [method, baselineOperation] of Object.entries(baselineItem)) {
      if (!HTTP_METHODS.has(method) || !isRecord(baselineOperation)) continue;
      const candidateOperation = candidateItem[method];
      if (!isRecord(candidateOperation)) {
        const replacementMethods = Object.keys(candidateItem).filter((key) =>
          HTTP_METHODS.has(key),
        );
        errors.push(
          replacementMethods.length > 0
            ? `BREAKING HTTP_METHOD_CHANGED: ${pathName} ${method.toUpperCase()} changed to ${replacementMethods.join(", ").toUpperCase()}.`
            : `BREAKING ENDPOINT_REMOVED: ${pathName} ${method.toUpperCase()} was removed.`,
        );
        continue;
      }
      compareOperation(
        baseline,
        candidate,
        pathName,
        method,
        baselineOperation,
        candidateOperation,
        errors,
      );
    }
  }
  return [...new Set(errors)];
}

/** @param {string} filePath */
async function readDocument(filePath) {
  const source = await readFile(filePath, "utf8");
  return JSON.parse(source);
}

function validateOperation(document, pathName, method, operation, errors) {
  const prefix = `${method.toUpperCase()} ${pathName}`;
  const auth = operation["x-caelush-authentication"];
  if (typeof auth !== "string" || auth.length === 0) {
    errors.push(`${prefix}: x-caelush-authentication is required.`);
  } else if (auth.startsWith("BEARER_")) {
    if (
      !Array.isArray(operation.security) ||
      !operation.security.some((scheme) => isRecord(scheme) && Object.hasOwn(scheme, "AccessToken"))
    ) {
      errors.push(`${prefix}: bearer authentication must use the AccessToken security scheme.`);
    }
  } else if (Array.isArray(operation.security) && operation.security.length > 0) {
    errors.push(`${prefix}: non-bearer authentication must not inherit or add a security scheme.`);
  }
  if (typeof operation["x-caelush-idempotency"] !== "string") {
    errors.push(`${prefix}: x-caelush-idempotency is required.`);
  }
  if (
    !Array.isArray(operation["x-caelush-security"]) ||
    operation["x-caelush-security"].length === 0
  ) {
    errors.push(`${prefix}: at least one x-caelush-security rule is required.`);
  }
  if (method === "post" && pathName !== "/v1/auth/logout" && !isRecord(operation.requestBody)) {
    errors.push(`${prefix}: a JSON requestBody is required.`);
  }
  if (isRecord(operation.requestBody)) {
    const body = resolveObjectRef(document, operation.requestBody);
    const schema = body?.content?.["application/json"]?.schema;
    if (body?.required !== true || schema === undefined) {
      errors.push(`${prefix}: requestBody must be required and define application/json.`);
    }
    const resolvedSchema = resolveObjectRef(document, schema);
    if (
      isRecord(resolvedSchema) &&
      resolvedSchema.type === "object" &&
      resolvedSchema.additionalProperties !== false
    ) {
      errors.push(`${prefix}: request object schema must reject unrecognized fields.`);
    }
  }
  if (!isRecord(operation.responses)) {
    errors.push(`${prefix}: responses are required.`);
    return;
  }
  const successCodes = Object.keys(operation.responses).filter((code) => /^2\d\d$/.test(code));
  if (successCodes.length === 0) errors.push(`${prefix}: a successful HTTP response is required.`);
  for (const status of successCodes) {
    const response = resolveObjectRef(document, operation.responses[status]);
    const schema = response?.content?.["application/json"]?.schema;
    const resolvedSchema = resolveObjectRef(document, schema);
    if (
      !isRecord(resolvedSchema) ||
      !Array.isArray(resolvedSchema.required) ||
      !resolvedSchema.required.includes("requestId")
    ) {
      errors.push(`${prefix}: successful response ${status} must require requestId.`);
    }
  }
  for (const [status, responseReference] of Object.entries(operation.responses)) {
    if (!/^[45]\d\d$/.test(status) && status !== "default") continue;
    const response = resolveObjectRef(document, responseReference);
    const schema = response?.content?.["application/json"]?.schema;
    const resolvedSchema = resolveObjectRef(document, schema);
    if (
      !isRecord(resolvedSchema) ||
      !Array.isArray(resolvedSchema.required) ||
      !resolvedSchema.required.includes("error")
    ) {
      errors.push(
        `${prefix}: error response ${status} must use the stable ApiErrorResponse envelope.`,
      );
    }
  }
}

function validateComponents(document, errors) {
  const components = isRecord(document.components) ? document.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  for (const name of REQUIRED_SCHEMA_NAMES) {
    if (!isRecord(schemas[name])) errors.push(`Missing shared OpenAPI schema ${name}.`);
  }
  const accessToken = components.securitySchemes?.AccessToken;
  if (!isRecord(accessToken) || accessToken.type !== "http" || accessToken.scheme !== "bearer") {
    errors.push("AccessToken must be an HTTP Bearer security scheme.");
  }
  const cloudError = schemas.CloudError;
  if (
    !isRecord(cloudError) ||
    !Array.isArray(cloudError.required) ||
    !["code", "message", "retryable", "requestId"].every((field) =>
      cloudError.required.includes(field),
    )
  ) {
    errors.push("CloudError must require code, message, retryable, and requestId.");
  }
  const authTokens = schemas.AuthTokens;
  const authTokenProperties = isRecord(authTokens?.properties) ? authTokens.properties : {};
  const authTokenRequired = new Set(Array.isArray(authTokens?.required) ? authTokens.required : []);
  for (const field of ["accessToken", "refreshToken"]) {
    const property = authTokenProperties[field];
    if (
      !authTokenRequired.has(field) ||
      !isRecord(property) ||
      property["x-caelush-secret"] !== true ||
      property.writeOnly === true
    ) {
      errors.push(
        `AuthTokens.${field} must identify a Cloud-response secret owned by Desktop Main.`,
      );
    }
  }
  const policy = schemas.DesktopUpdatePolicy;
  const policyProperties = isRecord(policy?.properties) ? policy.properties : {};
  const policyRequired = new Set(Array.isArray(policy?.required) ? policy.required : []);
  for (const field of [
    "platform",
    "arch",
    "channel",
    "currentVersion",
    "latestVersion",
    "minimumSupportedVersion",
    "mandatory",
    "graceDeadline",
    "revision",
    "release",
    "issuedAt",
    "expiresAt",
    "keyId",
  ]) {
    if (!policyRequired.has(field) || !Object.hasOwn(policyProperties, field)) {
      errors.push(`DesktopUpdatePolicy must require ${field}.`);
    }
  }
  const release = schemas.DesktopRelease;
  const releaseProperties = isRecord(release?.properties) ? release.properties : {};
  for (const field of ["version", "artifactUrl", "artifactSize", "sha512", "releaseNotes"]) {
    if (
      !Array.isArray(release?.required) ||
      !release.required.includes(field) ||
      !Object.hasOwn(releaseProperties, field)
    ) {
      errors.push(`DesktopRelease must require ${field}.`);
    }
  }
}

function validateLocalReferences(document, errors) {
  /** @param {unknown} value @param {string} source */
  function visit(value, source) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${source}[${String(index)}]`));
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.$ref === "string") {
      if (!value.$ref.startsWith("#/"))
        errors.push(`${source}: external OpenAPI references are not allowed.`);
      else if (resolveRef(document, value.$ref) === undefined)
        errors.push(`${source}: unresolved reference ${value.$ref}.`);
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${source}.${key}`);
  }
  visit(document, "OpenAPI");
}

function compareOperation(baseline, candidate, pathName, method, before, after, errors) {
  const prefix = `${method.toUpperCase()} ${pathName}`;
  const handledFields = new Set([
    "operationId",
    "x-caelush-authentication",
    "x-caelush-idempotency",
    "x-caelush-security",
    "security",
    "requestBody",
    "responses",
  ]);
  for (const field of [
    "operationId",
    "x-caelush-authentication",
    "x-caelush-idempotency",
    "x-caelush-security",
  ]) {
    if (stableJson(before[field]) !== stableJson(after[field])) {
      errors.push(`BREAKING OPERATION_SEMANTICS_CHANGED: ${prefix} changed ${field}.`);
    }
  }
  if (stableJson(before.security ?? []) !== stableJson(after.security ?? [])) {
    errors.push(`BREAKING SECURITY_CHANGED: ${prefix} changed its authentication requirement.`);
  }
  reportUndeterminedChanges(
    before,
    after,
    handledFields,
    `${prefix} operation`,
    "OPERATION_FIELD_CHANGED",
    errors,
  );
  const beforeBody =
    before.requestBody === undefined ? undefined : resolveObjectRef(baseline, before.requestBody);
  const afterBody =
    after.requestBody === undefined ? undefined : resolveObjectRef(candidate, after.requestBody);
  if (beforeBody !== undefined && afterBody === undefined) {
    errors.push(`BREAKING REQUEST_BODY_REMOVED: ${prefix} removed its request body.`);
  } else if (beforeBody !== undefined && afterBody !== undefined) {
    if (beforeBody.required === true && afterBody.required !== true) {
      // Making a body optional is compatible; it accepts a superset of old requests.
    } else if (beforeBody.required !== true && afterBody.required === true) {
      errors.push(`BREAKING REQUEST_BODY_REQUIRED: ${prefix} now requires its request body.`);
    }
    compareSchema(
      baseline,
      candidate,
      beforeBody.content?.["application/json"]?.schema,
      afterBody.content?.["application/json"]?.schema,
      "request",
      `${prefix} requestBody`,
      errors,
      new Set(),
    );
  }

  const beforeResponses = isRecord(before.responses) ? before.responses : {};
  const afterResponses = isRecord(after.responses) ? after.responses : {};
  for (const [status, oldResponseValue] of Object.entries(beforeResponses)) {
    const newResponseValue = afterResponses[status];
    if (newResponseValue === undefined) {
      errors.push(`BREAKING RESPONSE_REMOVED: ${prefix} removed response ${status}.`);
      continue;
    }
    const oldResponse = resolveObjectRef(baseline, oldResponseValue);
    const newResponse = resolveObjectRef(candidate, newResponseValue);
    compareSchema(
      baseline,
      candidate,
      oldResponse?.content?.["application/json"]?.schema,
      newResponse?.content?.["application/json"]?.schema,
      "response",
      `${prefix} response ${status}`,
      errors,
      new Set(),
    );
  }
}

function compareSchema(baseline, candidate, oldValue, newValue, direction, location, errors, seen) {
  const oldSchema = resolveObjectRef(baseline, oldValue);
  const newSchema = resolveObjectRef(candidate, newValue);
  if (!isRecord(oldSchema) || !isRecord(newSchema)) {
    if (stableJson(oldValue) !== stableJson(newValue)) {
      errors.push(`BREAKING SCHEMA_UNRESOLVED: ${location} changed an unresolved schema.`);
    }
    return;
  }
  const key = `${stableJson(oldValue)}=>${stableJson(newValue)}:${direction}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (stableJson(oldSchema.type) !== stableJson(newSchema.type)) {
    errors.push(`BREAKING FIELD_TYPE_CHANGED: ${location} changed type.`);
  }
  reportUndeterminedChanges(
    oldSchema,
    newSchema,
    HANDLED_SCHEMA_KEYWORDS,
    location,
    "SCHEMA_KEYWORD_CHANGED",
    errors,
  );
  for (const field of [
    "format",
    "const",
    "pattern",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ]) {
    if (
      oldSchema[field] !== undefined &&
      stableJson(oldSchema[field]) !== stableJson(newSchema[field])
    ) {
      errors.push(`BREAKING FIELD_CONSTRAINT_CHANGED: ${location} changed ${field}.`);
    }
  }
  if (Array.isArray(oldSchema.enum) && Array.isArray(newSchema.enum)) {
    const oldEnums = new Set(oldSchema.enum.map(stableJson));
    const newEnums = new Set(newSchema.enum.map(stableJson));
    const removed = [...oldEnums].filter((value) => !newEnums.has(value));
    if (removed.length > 0)
      errors.push(`BREAKING ENUM_VALUE_REMOVED: ${location} removed an existing enum value.`);
  }
  const oldRequired = new Set(Array.isArray(oldSchema.required) ? oldSchema.required : []);
  const newRequired = new Set(Array.isArray(newSchema.required) ? newSchema.required : []);
  const oldProperties = isRecord(oldSchema.properties) ? oldSchema.properties : {};
  const newProperties = isRecord(newSchema.properties) ? newSchema.properties : {};
  for (const field of oldRequired) {
    if (!newRequired.has(field) && direction === "response") {
      errors.push(
        `BREAKING REQUIRED_RESPONSE_FIELD_REMOVED: ${location} no longer requires ${String(field)}.`,
      );
    }
  }
  for (const field of newRequired) {
    if (!oldRequired.has(field)) {
      errors.push(
        direction === "request"
          ? `BREAKING REQUEST_FIELD_REQUIRED: ${location} added required field ${String(field)}.`
          : `BREAKING REQUIRED_RESPONSE_FIELD_ADDED: ${location} added required field ${String(field)}.`,
      );
    }
  }
  for (const [field, oldProperty] of Object.entries(oldProperties)) {
    const newProperty = newProperties[field];
    if (newProperty === undefined) {
      errors.push(`BREAKING FIELD_REMOVED: ${location} removed field ${field}.`);
      continue;
    }
    compareSchema(
      baseline,
      candidate,
      oldProperty,
      newProperty,
      direction,
      `${location}.${field}`,
      errors,
      seen,
    );
  }
  for (const field of Object.keys(newProperties)) {
    if (Object.hasOwn(oldProperties, field) || oldRequired.has(field)) continue;
    // Optional additions are compatible only for client requests; clients must ignore new response fields.
  }
  if (Array.isArray(oldSchema.items) || isRecord(oldSchema.items)) {
    compareSchema(
      baseline,
      candidate,
      oldSchema.items,
      newSchema.items,
      direction,
      `${location} items`,
      errors,
      seen,
    );
  }
  if (Array.isArray(oldSchema.oneOf) && Array.isArray(newSchema.oneOf)) {
    if (oldSchema.oneOf.length !== newSchema.oneOf.length) {
      errors.push(`BREAKING UNION_CHANGED: ${location} changed its oneOf alternatives.`);
    } else {
      oldSchema.oneOf.forEach((schema, index) =>
        compareSchema(
          baseline,
          candidate,
          schema,
          newSchema.oneOf[index],
          direction,
          `${location} alternative ${String(index)}`,
          errors,
          seen,
        ),
      );
    }
  }
}

function reportUndeterminedChanges(before, after, handledFields, location, code, errors) {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of fields) {
    if (handledFields.has(field)) continue;
    if (stableJson(before[field]) !== stableJson(after[field])) {
      errors.push(
        `UNDETERMINED ${code}: ${location} changed ${field}; manual compatibility review is required.`,
      );
    }
  }
}

function resolveObjectRef(document, value) {
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref !== "string") return value;
  const resolved = resolveRef(document, value.$ref);
  return isRecord(resolved) ? resolved : undefined;
}

function resolveRef(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => (isRecord(current) ? current[part] : undefined), document);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArguments(argv) {
  const result = { candidate: DEFAULT_CLOUD_OPENAPI_PATH, baseline: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--candidate" || argument === "--baseline") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a path.`);
      result[argument === "--candidate" ? "candidate" : "baseline"] = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (result.baseline !== undefined && result.candidate === result.baseline) {
    throw new Error("Baseline and candidate must be distinct paths.");
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const candidate = await readDocument(options.candidate);
    const candidateErrors = validateCloudOpenApi(candidate);
    if (candidateErrors.length > 0) {
      process.stderr.write(
        `Cloud OpenAPI validation FAIL (${String(candidateErrors.length)} issue(s))\n`,
      );
      for (const error of candidateErrors) process.stderr.write(`- ${error}\n`);
      process.exitCode = 1;
    } else if (options.baseline === undefined) {
      process.stdout.write(`Cloud OpenAPI validation PASS: ${options.candidate}\n`);
    } else {
      const baseline = await readDocument(options.baseline);
      const baselineErrors = validateCloudOpenApi(baseline);
      if (baselineErrors.length > 0) {
        process.stderr.write(
          `Cloud OpenAPI baseline is invalid (${String(baselineErrors.length)} issue(s)).\n`,
        );
        for (const error of baselineErrors) process.stderr.write(`- ${error}\n`);
        process.exitCode = 1;
      } else {
        const compatibilityErrors = compareCloudOpenApiContracts(baseline, candidate);
        if (compatibilityErrors.length > 0) {
          process.stderr.write(
            `Cloud OpenAPI compatibility FAIL (${String(compatibilityErrors.length)} breaking or undetermined change(s))\n`,
          );
          for (const error of compatibilityErrors) process.stderr.write(`- ${error}\n`);
          process.exitCode = 1;
        } else {
          process.stdout.write(
            `Cloud OpenAPI compatibility PASS: ${options.baseline} -> ${options.candidate}\n`,
          );
        }
      }
    }
  } catch (error) {
    process.stderr.write(
      `Cloud OpenAPI check FAIL: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
