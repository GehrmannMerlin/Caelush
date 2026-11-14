import { describe, expect, it } from "vitest";
import type { SkillManifest, SkillScopeRank } from "../src/index.js";

const domain = (await import("../src/index.js")) as unknown as Record<string, unknown>;

interface SkillIdentityInput {
  readonly scopeRank: SkillScopeRank;
  readonly providerId: string;
  readonly privateLocator: string;
}

describe("Skill identity and manifest fingerprint", () => {
  it("keeps identity stable across body edits while bundle revision changes", () => {
    const address: SkillIdentityInput = {
      scopeRank: 0,
      providerId: "project-skills",
      privateLocator: ".agents/skills/translate/SKILL.md",
    };
    const original = manifest("translate", "Translate documents", "Use a glossary.");
    const edited = manifest("translate", "Translate documents", "Use an updated glossary.");

    const originalId = call<SkillIdentityInput & { readonly manifest: SkillManifest }, string>(
      "createSkillIdentity",
      { ...address, manifest: original },
    );
    const editedId = call<SkillIdentityInput & { readonly manifest: SkillManifest }, string>(
      "createSkillIdentity",
      { ...address, manifest: edited },
    );
    const originalRevision = call<SkillManifest, string>("createSkillBundleRevision", original);
    const editedRevision = call<SkillManifest, string>("createSkillBundleRevision", edited);

    expect(editedId).toBe(originalId);
    expect(editedRevision).not.toBe(originalRevision);
  });

  it("keeps same-name identities distinct across project, user, and built-in scopes", () => {
    const sharedResource = "skills/translator/SKILL.md";
    const identities = [
      { scopeRank: 0, providerId: "filesystem", privateLocator: sharedResource },
      { scopeRank: 1, providerId: "filesystem", privateLocator: sharedResource },
      { scopeRank: 2, providerId: "builtin", privateLocator: sharedResource },
    ] satisfies readonly SkillIdentityInput[];

    const ids = identities.map((identity) =>
      call<SkillIdentityInput, string>("createSkillIdentity", identity),
    );

    expect(new Set(ids).size).toBe(3);
  });
});

function manifest(name: string, description: string, body: string): SkillManifest {
  return { name, description, body, userInvocable: true, modelInvocable: true };
}

function call<TInput, TResult>(name: string, input: TInput): TResult {
  const candidate = domain[name];
  expect(candidate, `${name} should be exported`).toBeTypeOf("function");
  return (candidate as (value: TInput) => TResult)(input);
}
