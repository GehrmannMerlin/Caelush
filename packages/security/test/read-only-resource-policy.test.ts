import { createRunId } from "@caelush/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("generic read-only resource authorization", () => {
  afterEach(() => vi.useRealTimers());

  it("issues a run-, bundle-, policy- and lifetime-bound typed grant", () => {
    vi.setSystemTime(NOW);

    const decision = authorizeReadOnlyResource(request(), policy());

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
    expect(verifyReadOnlyResourceGrant(decision.grant, policy())).toMatchObject({
      valid: true,
    });
  });

  it.each([
    ["wrong Run", { runId: createRunId() }],
    ["wrong content manifest", { contentManifestHash: "b".repeat(64) }],
    ["wrong bundle revision", { bundleRevision: "bundle-r2" }],
    ["arbitrary host path", { canonicalRoot: "C:/Users/test/Documents" }],
  ])("rejects %s", (_label, overrides) => {
    vi.setSystemTime(NOW);
    expect(authorizeReadOnlyResource(request(overrides), policy()).kind).toBe("DENY");
  });

  it("rejects disabled, expired and revoked policies", () => {
    vi.setSystemTime(NOW);
    expect(authorizeReadOnlyResource(request(), policy({ enabled: false })).kind).toBe("DENY");
    expect(authorizeReadOnlyResource(request(), policy({ expiresAt: NOW })).kind).toBe("DENY");

    const authorized = authorizeReadOnlyResource(request(), policy());
    if (authorized.kind !== "ALLOW") throw new Error("expected grant");
    expect(
      verifyReadOnlyResourceGrant(
        authorized.grant,
        policy({ revision: "policy-r2", resources: [] }),
      ),
    ).toMatchObject({ valid: false, reason: "POLICY_REVOKED" });
  });

  it("expires the grant at the bounded lifetime even if the policy lasts longer", () => {
    vi.setSystemTime(NOW);
    const authorized = authorizeReadOnlyResource(request(), policy({ expiresAt: NOW + 600_000 }));
    if (authorized.kind !== "ALLOW") throw new Error("expected grant");
    expect(authorized.grant.lifetime.expiresAt).toBe(NOW + 60_000);

    vi.setSystemTime(NOW + 60_000);
    expect(
      verifyReadOnlyResourceGrant(authorized.grant, policy({ expiresAt: NOW + 600_000 })),
    ).toMatchObject({ valid: false, reason: "GRANT_EXPIRED" });
  });

  it("keeps the authority fingerprint stable when an identical grant is renewed", () => {
    vi.setSystemTime(NOW);
    const first = authorizeReadOnlyResource(request(), policy({ expiresAt: NOW + 600_000 }));
    vi.setSystemTime(NOW + 1);
    const renewed = authorizeReadOnlyResource(request(), policy({ expiresAt: NOW + 600_000 }));
    if (first.kind !== "ALLOW" || renewed.kind !== "ALLOW") throw new Error("expected grants");
    expect(renewed.grant.lifetime).not.toEqual(first.grant.lifetime);
    expect(renewed.grant.authorityFingerprint).toBe(first.grant.authorityFingerprint);
  });

  it("rejects forged or modified grants at the verification boundary", () => {
    vi.setSystemTime(NOW);
    const authorized = authorizeReadOnlyResource(request(), policy());
    if (authorized.kind !== "ALLOW") throw new Error("expected grant");

    expect(
      verifyReadOnlyResourceGrant(
        { ...authorized.grant, canonicalRoot: "C:/Users/test/Documents" } as never,
        policy(),
      ),
    ).toMatchObject({ valid: false });
    expect(verifyReadOnlyResourceGrant({ ...authorized.grant } as never, policy())).toMatchObject({
      valid: false,
      reason: "UNTRUSTED_GRANT",
    });
  });

  it("keeps resource-read authorization separate from process and network capabilities", () => {
    vi.setSystemTime(NOW);
    const decision = authorizeReadOnlyResource(request(), policy());
    const encoded = JSON.stringify(decision);
    expect(encoded).not.toContain("PROCESS_START");
    expect(encoded).not.toContain("SHELL_EXEC");
    expect(encoded).not.toContain("NETWORK");
  });
});
