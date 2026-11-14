import { DaemonInfoSchema } from "../src/api/daemon-info.js";
import { ApiErrorCodeSchema } from "../src/api/common.js";
import { SessionTurnPresentationResponseV3Schema } from "../src/api/session-presentation.js";
import { describe, expect, it } from "vitest";

const protocol = (await import("../src/index.js")) as unknown as Record<string, unknown>;

interface SchemaLike {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { readonly success: boolean; readonly data?: unknown };
}

const skillId = "skill:v1:0123456789abcdef";
const artifactRef = "artifact:v1:0123456789abcdef";
const bundleRevision = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const runId = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";
const stepId = "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";

describe("Skill V1 protocol contracts", () => {
  it("round-trips bounded Skill DTOs without private source fields", () => {
    const selection = { skillId, selectionToken: "opaque-selection-token" };
    const item = {
      skillId,
      name: "translator",
      description: "Translate documents",
      selectionToken: "opaque-selection-token",
      enabled: true,
      userInvocable: true,
      modelInvocable: true,
    };
    const catalogPage = {
      schemaVersion: 1,
      catalogRevision: "catalog-v1",
      items: [item],
      complete: true,
      diagnostics: [],
    };
    const managementPage = {
      schemaVersion: 1,
      catalogRevision: "catalog-v1",
      items: [
        {
          skillId,
          name: "translator",
          description: "Translate documents",
          enabled: true,
          userInvocable: true,
          modelInvocable: true,
        },
      ],
      complete: true,
      diagnostics: [],
    };

    expect(roundTrip("SkillSelectionV1Schema", selection)).toEqual(selection);
    expect(roundTrip("SkillCatalogPageV1Schema", catalogPage)).toEqual(catalogPage);
    expect(roundTrip("SkillManagementPageV1Schema", managementPage)).toEqual(managementPage);
  });

  it("rejects private paths, Runtime objects, functions, and unknown DTO fields", () => {
    const selection = { skillId, selectionToken: "opaque-selection-token" };
    const bundle = { bundleRevision, artifactRef, manifestFingerprint: bundleRevision };
    const binding = {
      runId,
      resourceKind: "WORKFLOW_INSTRUCTION",
      resourceId: skillId,
      resourceRevision: bundleRevision,
      artifactRef,
      sourceFingerprint: bundleRevision,
      utf8Bytes: 20,
      tokenEstimate: 5,
    };
    const receipt = {
      runId,
      stepId,
      bindingId: "binding-v1",
      projectionFingerprint: bundleRevision,
      rendererVersion: "workflow-v1",
    };

    expect(
      schema("SkillSelectionV1Schema").safeParse({ ...selection, privateLocator: "C:\\secret" })
        .success,
    ).toBe(false);
    expect(
      schema("SkillBundleRefV1Schema").safeParse({ ...bundle, artifactRef: "C:\\secret\\skill" })
        .success,
    ).toBe(false);
    expect(
      schema("WorkflowResourceBindingDraftV1Schema").safeParse({
        ...binding,
        runtime: { kind: "local" },
      }).success,
    ).toBe(false);
    expect(
      schema("PreparedInputResourceReceiptV1Schema").safeParse({
        ...receipt,
        execute: () => undefined,
      }).success,
    ).toBe(false);
    expect(
      schema("SkillSelectionV1Schema").safeParse({ ...selection, unexpected: true }).success,
    ).toBe(false);
  });

  it("round-trips bundle, generic binding, profile, prepared resource, and receipt records", () => {
    const snapshot = {
      catalogRevision: "catalog-v1",
      artifactRef,
      manifestFingerprint: bundleRevision,
    };
    const bundle = {
      bundleRevision,
      artifactRef,
      manifestFingerprint: bundleRevision,
    };
    const draft = {
      runId,
      resourceKind: "WORKFLOW_INSTRUCTION",
      resourceId: skillId,
      resourceRevision: bundleRevision,
      artifactRef,
      sourceFingerprint: bundleRevision,
      utf8Bytes: 32,
      tokenEstimate: 8,
    };
    const binding = { ...draft, bindingId: "binding-v1", activationOrdinal: 0 };
    const preparedResource = {
      bindingId: "binding-v1",
      artifactRef,
      projectionFingerprint: bundleRevision,
      rendererVersion: "workflow-renderer-v1",
      utf8Bytes: 48,
      tokenEstimate: 12,
    };
    const receipt = {
      runId,
      stepId,
      bindingId: "binding-v1",
      projectionFingerprint: bundleRevision,
      rendererVersion: "workflow-renderer-v1",
    };
    const profile = {
      runId,
      profileVersion: 1,
      toolCatalogFingerprint: bundleRevision,
      workflowRendererVersion: "workflow-renderer-v1",
      catalogSnapshotRef: snapshot,
    };
    const skillBinding = {
      bindingId: "binding-v1",
      runId,
      skillId,
      name: "translator",
      bundleRevision,
      sourceFingerprint: bundleRevision,
      artifactRef,
      origin: "USER",
      createdAt: 1_700_000_000_000,
    };

    expect(roundTrip("SkillBundleRefV1Schema", bundle)).toEqual(bundle);
    expect(roundTrip("WorkflowCatalogSnapshotRefV1Schema", snapshot)).toEqual(snapshot);
    expect(roundTrip("WorkflowResourceBindingDraftV1Schema", draft)).toEqual(draft);
    expect(roundTrip("WorkflowResourceBindingV1Schema", binding)).toEqual(binding);
    expect(roundTrip("PreparedWorkflowResourceRefV1Schema", preparedResource)).toEqual(
      preparedResource,
    );
    expect(roundTrip("PreparedInputResourceReceiptV1Schema", receipt)).toEqual(receipt);
    expect(roundTrip("RunWorkflowExecutionProfileV1Schema", profile)).toEqual(profile);
    expect(roundTrip("RunSkillBindingV1Schema", skillBinding)).toEqual(skillBinding);
  });

  it("requires a non-empty selection credential and bounds catalog pagination", () => {
    expect(
      schema("SkillSelectionV1Schema").safeParse({ skillId, selectionToken: "" }).success,
    ).toBe(false);
    expect(schema("SkillCatalogQuerySchema").parse({})).toEqual({ pageSize: 20 });
    expect(schema("SkillCatalogQuerySchema").safeParse({ pageSize: 0 }).success).toBe(false);
    expect(schema("SkillCatalogQuerySchema").safeParse({ pageSize: 101 }).success).toBe(false);
    expect(schema("SkillCatalogQuerySchema").parse({ pageSize: "100" })).toMatchObject({
      pageSize: 100,
    });
  });

  it("keeps capability and V4 presentation schemas separate from strict legacy responses", () => {
    const capabilities = {
      schemaVersion: 1,
      enabled: false,
      catalog: false,
      invocation: false,
      scriptExecution: false,
      presentationVersion: null,
    };
    const info = {
      apiVersion: "v1",
      protocolVersion: 1,
      daemonVersion: "1.0.1",
      capabilities: {
        runExecution: true,
        runRecovery: true,
        cancellation: true,
        approvals: true,
        sseReplay: true,
      },
      runtimeKinds: ["local"],
      configuredProviders: [],
      defaultRunConfiguration: {
        runtime: { id: "local", kind: "local" },
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ALWAYS_ASK",
        limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 1_000 },
      },
    } as const;
    const legacyTurn = {
      runId,
      conversationTurnId: "turn_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      runStatus: "RUNNING",
      openedAt: 1_700_000_000_000,
      highWatermark: 0,
      items: [],
    };

    expect(roundTrip("SkillCapabilityResponseSchema", capabilities)).toEqual(capabilities);
    expect(DaemonInfoSchema.parse(info)).toEqual(info);
    expect(DaemonInfoSchema.safeParse({ ...info, skillsV1: capabilities }).success).toBe(false);
    expect(
      SessionTurnPresentationResponseV3Schema.parse({ capabilityVersion: 3, turns: [legacyTurn] }),
    ).toMatchObject({ capabilityVersion: 3 });
    expect(
      schema("SessionTurnPresentationResponseV4Schema").safeParse({
        capabilityVersion: 3,
        turns: [legacyTurn],
      }).success,
    ).toBe(false);
  });

  it("parses V4 selected Skills and derived Skill status without bundle data", () => {
    const base = {
      id: "presentation_1",
      runId,
      conversationTurnId: "turn_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      ordinal: 0,
      status: "COMPLETED",
      createdAt: 1_700_000_000_000,
    };
    const userItem = {
      ...base,
      kind: "USER",
      text: "Translate this document",
      selectedSkills: [{ skillId, name: "translator" }],
    };
    const skillItem = {
      ...base,
      id: "presentation_2",
      ordinal: 1,
      kind: "SKILL",
      skillId,
      name: "translator",
      skillStatus: "CONTENT_READY",
    };
    const response = {
      capabilityVersion: 4,
      turns: [
        {
          runId,
          conversationTurnId: base.conversationTurnId,
          runStatus: "RUNNING",
          openedAt: base.createdAt,
          highWatermark: 0,
          items: [userItem, skillItem],
        },
      ],
    };

    expect(roundTrip("SessionTurnPresentationResponseV4Schema", response)).toEqual(response);
    expect(
      schema("SkillPresentationItemSchema").safeParse({ ...skillItem, artifactRef }).success,
    ).toBe(false);
  });

  it("exports the bounded, translatable Skill failure vocabulary outside ApiErrorCode", () => {
    const reasons = [
      "SKILLS_UNAVAILABLE",
      "SKILL_NOT_FOUND",
      "SKILL_SELECTION_STALE",
      "SKILL_DISABLED",
      "SKILL_LOAD_FAILED",
      "SKILL_CORE_BUDGET_EXCEEDED",
      "SKILL_ARTIFACT_INVALID",
      "SKILL_RESOURCE_DENIED",
      "SKILL_SCRIPT_UNAVAILABLE",
    ];

    for (const reason of reasons)
      expect(schema("SkillFailureReasonSchema").parse(reason)).toBe(reason);
    expect(ApiErrorCodeSchema.safeParse("SKILLS_UNAVAILABLE").success).toBe(false);
  });
});

function schema(name: string): SchemaLike {
  const value = protocol[name];
  expect(value, `${name} should be exported`).toBeDefined();
  return value as SchemaLike;
}

function roundTrip(name: string, value: unknown): unknown {
  const encoded = JSON.stringify(value);
  expect(encoded).toBeTypeOf("string");
  return schema(name).parse(JSON.parse(encoded as string) as unknown);
}
