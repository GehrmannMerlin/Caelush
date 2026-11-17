import { createRunId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  authorizeReadOnlyResource,
  verifyReadOnlyResourceGrant,
  type ReadOnlyResourcePolicy,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const RUN_ID = createRunId();
const RESOURCE = {
  resourceId: "skill_frontend",
  bundleRevision: "bundle-r1",
  canonicalRoot: "C:/Users/test/.caelush/skill-bundles/frontend-r1",
  contentManifestHash: "a".repeat(64),
};

function policy(overrides: Partial<ReadOnlyResourcePolicy> = {}): ReadOnlyResourcePolicy {
  return {
    runId: RUN_ID,
    revision: "policy-r1",
    enabled: true,
    expiresAt: NOW + 60_000,
    resources: [RESOURCE],
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    ...RESOURCE,
    ...overrides,
  } as never;
}

function authorize(requestValue = request(), policyValue = policy(), now = NOW) {
  return authorizeReadOnlyResource(requestValue, policyValue, now);
}

function verify(value: unknown, policyValue = policy(), now = NOW) {
  return verifyReadOnlyResourceGrant(value, policyValue, now);
}

describe("generic read-only resource authorization", () => {
  it("issues a run-, bundle-, policy- and lifetime-bound typed grant", () => {
    const decision = authorize();

    expect(decision.kind).toBe("ALLOW");
    if (decision.kind !== "ALLOW") throw new Error("expected grant");
    expect(decision.grant).toMatchObject({
      runId: RUN_ID,
      resourceId: RESOURCE.resourceId,
      bundleRevision: RESOURCE.bundleRevision,
      canonicalRoot: RESOURCE.canonicalRoot,
      contentManifestHash: RESOURCE.contentManifestHash,
      policyRevision: "policy-r1",
      lifetime: { issuedAt: NOW, expiresAt: NOW + 60_000 },
    });
    expect(verify(decision.grant)).toMatchObject({
      valid: true,
    });
  });

  it.each([
    ["wrong Run", { runId: createRunId() }],
    ["wrong content manifest", { contentManifestHash: "b".repeat(64) }],
    ["wrong bundle revision", { bundleRevision: "bundle-r2" }],
    ["arbitrary host path", { canonicalRoot: "C:/Users/test/Documents" }],
  ])("rejects %s", (_label, overrides) => {
    expect(authorize(request(overrides), policy()).kind).toBe("DENY");
  });

  it("rejects disabled, expired and revoked policies", () => {
    expect(authorize(request(), policy({ enabled: false })).kind).toBe("DENY");
    expect(authorize(request(), policy({ expiresAt: NOW })).kind).toBe("DENY");

    const authorized = authorize();
    if (authorized.kind !== "ALLOW") throw new Error("expected grant");
    expect(
      verify(authorized.grant, policy({ revision: "policy-r2", resources: [] })),
    ).toMatchObject({ valid: false, reason: "POLICY_REVOKED" });
  });

  it("expires the grant at the bounded lifetime even if the policy lasts longer", () => {
    const authorized = authorize(request(), policy({ expiresAt: NOW + 600_000 }));
    if (authorized.kind !== "ALLOW") throw new Error("expected grant");
    expect(authorized.grant.lifetime.expiresAt).toBe(NOW + 60_000);

    expect(
      verify(authorized.grant, policy({ expiresAt: NOW + 600_000 }), NOW + 60_000),
    ).toMatchObject({ valid: false, reason: "GRANT_EXPIRED" });
  });

  it("keeps the authority fingerprint stable when an identical grant is renewed", () => {
    const longPolicy = policy({ expiresAt: NOW + 600_000 });
    const first = authorize(request(), longPolicy);
    const renewed = authorize(request(), longPolicy, NOW + 1);
    if (first.kind !== "ALLOW" || renewed.kind !== "ALLOW") throw new Error("expected grants");
    expect(renewed.grant.lifetime).not.toEqual(first.grant.lifetime);
    expect(renewed.grant.authorityFingerprint).toBe(first.grant.authorityFingerprint);
  });

  it("rejects forged or modified grants at the verification boundary", () => {
    const authorized = authorize();
    if (authorized.kind !== "ALLOW") throw new Error("expected grant");

    expect(
      verify({ ...authorized.grant, canonicalRoot: "C:/Users/test/Documents" } as never, policy()),
    ).toMatchObject({ valid: false });
    expect(verify({ ...authorized.grant } as never, policy())).toMatchObject({
      valid: false,
      reason: "UNTRUSTED_GRANT",
    });
  });

  it("keeps resource-read authorization separate from process and network capabilities", () => {
    const decision = authorize();
    const encoded = JSON.stringify(decision);
    expect(encoded).not.toContain("PROCESS_START");
    expect(encoded).not.toContain("SHELL_EXEC");
    expect(encoded).not.toContain("NETWORK");
  });
});
