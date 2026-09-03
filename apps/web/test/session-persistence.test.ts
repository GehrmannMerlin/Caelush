import { describe, expect, it } from "vitest";
import { createSessionId } from "@caelush/protocol";
import { SessionSelectionStore } from "../src/application/session-persistence.js";

describe("SessionSelectionStore", () => {
  it("stores only a schema-valid member SessionId and drops invalid or non-member values", () => {
    const storage = new Map<string, string>();
    const store = new SessionSelectionStore(storage);
    const workspace = "D:/workspace";
    const member = createSessionId();
    store.setCandidates(workspace, [member]);

    store.write(workspace, member);
    expect(store.read(workspace)).toBe(member);
    store.write(workspace, "not-a-session-id");
    expect(store.read(workspace)).toBeUndefined();
    storage.set(`caelush:selected-session:${workspace}`, JSON.stringify(createSessionId()));
    expect(store.read(workspace)).toBeUndefined();
    expect(
      [...storage.values()].some((value) => value.includes("Timeline") || value.includes("Run")),
    ).toBe(false);
  });
});
