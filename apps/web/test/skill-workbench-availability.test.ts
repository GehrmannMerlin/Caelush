import { describe, expect, it } from "vitest";
import type { SkillCapabilityResponse } from "@caelush/protocol";
import {
  canOpenSkillManager,
  claimSkillPreparationRefresh,
  canSubmitManualSkillSelections,
  isComposerDraftLoading,
  resolveSkillCapabilityReadState,
} from "../src/application/skill-workbench-availability.js";

const enabledCapabilities: SkillCapabilityResponse = {
  schemaVersion: 1,
  enabled: true,
  catalog: true,
  invocation: true,
  scriptExecution: false,
  presentationVersion: 4,
};

describe("Skill workbench availability", () => {
  it("keeps a Skill-only composer usable without optional attachment draft APIs", () => {
    expect(
      isComposerDraftLoading({
        hasOwner: true,
        attachmentDraftStoreAvailable: false,
        attachmentBindingReady: false,
        attachmentBindingLoading: false,
        skillsAvailable: true,
        skillBindingReady: true,
      }),
    ).toBe(false);
  });

  it("waits for each draft source only when that capability exists", () => {
    expect(
      isComposerDraftLoading({
        hasOwner: true,
        attachmentDraftStoreAvailable: true,
        attachmentBindingReady: false,
        attachmentBindingLoading: false,
        skillsAvailable: false,
        skillBindingReady: false,
      }),
    ).toBe(true);
    expect(
      isComposerDraftLoading({
        hasOwner: true,
        attachmentDraftStoreAvailable: false,
        attachmentBindingReady: false,
        attachmentBindingLoading: false,
        skillsAvailable: true,
        skillBindingReady: false,
      }),
    ).toBe(true);
  });

  it("does not expose management based only on methods present on an older default-off client", () => {
    expect(canOpenSkillManager(enabledCapabilities, true)).toBe(true);
    expect(canOpenSkillManager({ ...enabledCapabilities, enabled: false }, true)).toBe(false);
    expect(canOpenSkillManager({ ...enabledCapabilities, catalog: false }, true)).toBe(false);
    expect(canOpenSkillManager(enabledCapabilities, false)).toBe(false);
    expect(canOpenSkillManager(undefined, true)).toBe(false);
  });

  it("claims the initial preparation read once per accepted owner, Run, submission, and version", () => {
    const requested = new Set<string>();
    expect(
      claimSkillPreparationRefresh(requested, "session:one", "run-one", "submission-one", 3),
    ).toBe(true);
    expect(
      claimSkillPreparationRefresh(requested, "session:one", "run-one", "submission-one", 3),
    ).toBe(false);
    expect(
      claimSkillPreparationRefresh(requested, "session:one", "run-one", "submission-one", 4),
    ).toBe(true);
    expect(
      claimSkillPreparationRefresh(requested, "session:two", "run-one", "submission-one", 3),
    ).toBe(true);
  });

  it("keeps saved manual selections from falling back to a plain-text submission", () => {
    const available = resolveSkillCapabilityReadState(enabledCapabilities);
    const unsupported = resolveSkillCapabilityReadState({
      ...enabledCapabilities,
      invocation: false,
    });

    expect(canSubmitManualSkillSelections({ status: "PENDING" }, 1)).toBe(false);
    expect(canSubmitManualSkillSelections({ status: "FAILED" }, 1)).toBe(false);
    expect(canSubmitManualSkillSelections(unsupported, 1)).toBe(false);
    expect(canSubmitManualSkillSelections(available, 1)).toBe(true);
    expect(canSubmitManualSkillSelections({ status: "FAILED" }, 0)).toBe(true);
  });
});
