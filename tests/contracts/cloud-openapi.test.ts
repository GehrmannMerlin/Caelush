import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  compareCloudOpenApiContracts,
  DEFAULT_CLOUD_OPENAPI_PATH,
  REQUIRED_CLOUD_OPERATIONS,
  validateCloudOpenApi,
} from "../../scripts/contracts/check-cloud-openapi.mjs";

const fixtureRoot = new URL("./fixtures/", import.meta.url);

async function readJson(url: URL) {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}

describe("Cloud OpenAPI v1 contract guard", () => {
  it("validates the contract-first API and all thirteen required operations", async () => {
    const document = JSON.parse(await readFile(DEFAULT_CLOUD_OPENAPI_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    expect(validateCloudOpenApi(document)).toEqual([]);
    expect(Object.keys(REQUIRED_CLOUD_OPERATIONS)).toHaveLength(13);
  });

  it("marks Cloud tokens for trusted Main custody without misusing writeOnly", async () => {
    const document = JSON.parse(await readFile(DEFAULT_CLOUD_OPENAPI_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    expect(validateCloudOpenApi(document)).toEqual([]);
    const components = document.components as {
      schemas: { AuthTokens: { properties: Record<string, Record<string, unknown>> } };
    };
    for (const field of ["accessToken", "refreshToken"]) {
      expect(components.schemas.AuthTokens.properties[field]["x-caelush-secret"]).toBe(true);
      expect(components.schemas.AuthTokens.properties[field].writeOnly).toBeUndefined();
    }
  });

  it("rejects unapproved Agent-data synchronization endpoints", async () => {
    const document = JSON.parse(await readFile(DEFAULT_CLOUD_OPENAPI_PATH, "utf8")) as {
      paths: Record<string, unknown>;
    };
    const candidate = structuredClone(document);
    candidate.paths["/v1/agent/runs"] = { post: { operationId: "syncAgentRuns" } };
    expect(validateCloudOpenApi(candidate)).toContain(
      "Unexpected endpoint /v1/agent/runs; Cloud V1 is restricted to the frozen API list.",
    );
  });

  it("detects a real fixture that removes a required response field", async () => {
    const baseline = await readJson(new URL("cloud-openapi-baseline.json", fixtureRoot));
    const candidate = await readJson(new URL("cloud-openapi-breaking-candidate.json", fixtureRoot));
    expect(validateCloudOpenApi(baseline)).toEqual([]);
    expect(validateCloudOpenApi(candidate)).toEqual([]);
    expect(compareCloudOpenApiContracts(baseline, candidate)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("BREAKING REQUIRED_RESPONSE_FIELD_REMOVED"),
        expect.stringContaining("BREAKING FIELD_REMOVED"),
      ]),
    );
  });

  it("rejects a newly required request field and an authentication change", async () => {
    const document = JSON.parse(await readFile(DEFAULT_CLOUD_OPENAPI_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    const baseline = structuredClone(document);
    const candidate = structuredClone(document);
    const components = candidate.components as {
      schemas: Record<string, { required: string[]; properties: Record<string, unknown> }>;
    };
    components.schemas.RegisterRequest.required.push("clientNonce");
    components.schemas.RegisterRequest.properties.clientNonce = { type: "string" };
    const candidatePaths = candidate.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    candidatePaths["/v1/auth/login"].post["x-caelush-authentication"] = "NONE";

    const errors = compareCloudOpenApiContracts(baseline, candidate);
    expect(errors).toContain(
      "BREAKING OPERATION_SEMANTICS_CHANGED: POST /v1/auth/login changed x-caelush-authentication.",
    );
    expect(errors).toContain(
      "BREAKING REQUEST_FIELD_REQUIRED: POST /v1/auth/register requestBody added required field clientNonce.",
    );
  });

  it("reports schema changes outside its analyzed subset for manual review", async () => {
    const document = JSON.parse(await readFile(DEFAULT_CLOUD_OPENAPI_PATH, "utf8")) as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const baseline = structuredClone(document);
    const candidate = structuredClone(document);
    candidate.components.schemas.RegisterRequest.minProperties = 1;

    expect(compareCloudOpenApiContracts(baseline, candidate)).toContain(
      "UNDETERMINED SCHEMA_KEYWORD_CHANGED: POST /v1/auth/register requestBody changed minProperties; manual compatibility review is required.",
    );
  });
});
