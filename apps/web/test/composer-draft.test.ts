import { describe, expect, it } from "vitest";
import { clearComposerDraftError } from "../src/application/composer-draft.js";

describe("composer draft", () => {
  it("clears an old submission error after the same draft is accepted", () => {
    const failedDraft = {
      ownerKey: "session:current",
      revision: 4,
      text: "Run the selected Skill.",
      loading: false,
      error: "The selected Skill expired.",
    };

    expect(clearComposerDraftError(failedDraft, "session:current")).toEqual({
      ownerKey: "session:current",
      revision: 4,
      text: "Run the selected Skill.",
      loading: false,
    });
  });
});
