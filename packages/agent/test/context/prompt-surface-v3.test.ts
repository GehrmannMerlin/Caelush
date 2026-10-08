import { describe, expect, it } from "vitest";

import {
  applyPromptSurfaceSectionUpdates,
  createPromptSurfaceSectionStates,
  diffPromptSurfaceSections,
  renderPromptSurfaceRecord,
} from "../../src/context/surface/prompt-surface-v3.js";
import type { ContextDocument } from "../../src/context/document/context-document.js";
import { renderRuntimeContextSnapshot } from "../../src/context/surface/prompt-surface-renderer.js";

const file = (text: string) => ({
  id: "coding.relevant-files:login.html",
  authority: "REFERENCE" as const,
  sourceRef: "coding.relevant-files@v1:file:login.html",
  cacheStability: "SEMI_STABLE" as const,
  priorityClass: "NORMAL" as const,
  freshness: "CURRENT" as const,
  sensitivity: "INTERNAL" as const,
  text,
});

function document(...sections: ReturnType<typeof file>[]): ContextDocument {
  return { sections };
}

describe("Prompt Surface V3 semantic sections", () => {
  it("does not re-emit an unchanged 10 KB file over eight steps", () => {
    const currentDocument = document(file("x".repeat(10_000)));
    const initial = createPromptSurfaceSectionStates(currentDocument);
    let previous = [];
    const emissions = [
      diffPromptSurfaceSections(previous, initial, true),
      ...Array.from({ length: 7 }, () => diffPromptSurfaceSections(initial, initial, false)),
    ];

    expect(emissions[0]?.kind).toBe("BASELINE");
    expect(emissions.slice(1).map((entry) => entry.kind)).toEqual(Array(7).fill("NOOP"));
    expect(emissions.slice(1).flatMap((entry) => entry.updates)).toEqual([]);
    expect(emissions[0]?.updates[0]?.content).toContain("x".repeat(10_000));
    expect(renderPromptSurfaceRecord("BASELINE", emissions[0]!.updates)).toContain(
      'authority="REFERENCE"',
    );
    const v2EquivalentSnapshotBytes = Buffer.byteLength(
      renderRuntimeContextSnapshot(currentDocument)!,
      "utf8",
    );
    const v2EquivalentDuplicatedBytes = v2EquivalentSnapshotBytes * 7;
    const v3NewlyAppendedBytes = Buffer.byteLength(
      renderPromptSurfaceRecord("BASELINE", emissions[0]!.updates),
      "utf8",
    );
    const v3UnchangedSectionReemissions = emissions
      .slice(1)
      .flatMap((entry) => entry.updates)
      .filter((update) => update.stateKey === initial[0]?.stateKey).length;
    expect({
      v2EquivalentDuplicatedBytes,
      v3NewlyAppendedBytes,
      v3UnchangedSectionReemissions,
    }).toEqual({
      v2EquivalentDuplicatedBytes: 71_015,
      v3NewlyAppendedBytes: 10_666,
      v3UnchangedSectionReemissions: 0,
    });
  });

  it("emits only a changed clock section and keeps an unchanged file out of its delta", () => {
    const previous = createPromptSurfaceSectionStates(
      document(file("same"), {
        ...file("T1"),
        id: "coding.temporal:current",
        sourceRef: "coding.temporal@v1:clock:injected",
        authority: "RUNTIME_FACT",
      }),
    );
    const current = createPromptSurfaceSectionStates(
      document(file("same"), {
        ...file("T2"),
        id: "coding.temporal:current",
        sourceRef: "coding.temporal@v1:clock:injected",
        authority: "RUNTIME_FACT",
      }),
    );

    const diff = diffPromptSurfaceSections(previous, current, false);
    expect(diff.kind).toBe("DELTA");
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0]?.content).toContain("T2");
    expect(diff.updates[0]?.content).not.toContain("same");
  });

  it("updates one changed file while carrying the unchanged file state forward", () => {
    const previous = createPromptSurfaceSectionStates(
      document(file("login v1"), {
        ...file("keep original"),
        id: "coding.relevant-files:help.html",
      }),
    );
    const current = createPromptSurfaceSectionStates(
      document(file("login v2"), {
        ...file("keep original"),
        id: "coding.relevant-files:help.html",
      }),
    );
    const diff = diffPromptSurfaceSections(previous, current, false);

    expect(diff.kind).toBe("DELTA");
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0]?.content).toContain("login v2");
    expect(applyPromptSurfaceSectionUpdates(previous, diff.kind, diff.updates)).toEqual(current);
  });

  it("aggregates three Section changes into one Delta record body", () => {
    const previous = createPromptSurfaceSectionStates(
      document(
        file("login v1"),
        { ...file("help v1"), id: "coding.relevant-files:help.html" },
        {
          ...file("clock v1"),
          id: "coding.temporal:current",
          sourceRef: "coding.temporal@v1:clock:injected",
          authority: "RUNTIME_FACT",
        },
      ),
    );
    const current = createPromptSurfaceSectionStates(
      document(
        file("login v2"),
        { ...file("help v2"), id: "coding.relevant-files:help.html" },
        {
          ...file("clock v2"),
          id: "coding.temporal:current",
          sourceRef: "coding.temporal@v1:clock:injected",
          authority: "RUNTIME_FACT",
        },
      ),
    );
    const diff = diffPromptSurfaceSections(previous, current, false);
    const rendered = renderPromptSurfaceRecord("DELTA", diff.updates);

    expect(diff.kind).toBe("DELTA");
    expect(diff.updates).toHaveLength(3);
    expect(rendered.match(/<set /g)).toHaveLength(3);
  });

  it("clears an item that left a complete view and sets changed items deterministically", () => {
    const previous = createPromptSurfaceSectionStates(
      document(file("old"), {
        ...file("kept"),
        id: "coding.relevant-files:keep.html",
      }),
    );
    const current = createPromptSurfaceSectionStates(
      document({
        ...file("new"),
        id: "coding.relevant-files:login.html",
      }),
    );
    const diff = diffPromptSurfaceSections(previous, current, false);

    expect(diff.updates.map((entry) => entry.op)).toEqual(["SET", "CLEAR"]);
    expect(diff.updates[0]?.content).toContain("new");
    const rendered = renderPromptSurfaceRecord("DELTA", diff.updates);
    expect(rendered).toContain('version="3"');
    expect(rendered).toContain("does not claim that an underlying file or resource was deleted");
  });

  it("rejects duplicate semantic identity with conflicting content or authority", () => {
    expect(() => createPromptSurfaceSectionStates(document(file("one"), file("two")))).toThrow(
      /identity/i,
    );
    expect(() =>
      createPromptSurfaceSectionStates(
        document(file("same"), {
          ...file("same"),
          authority: "CORE_POLICY",
        }),
      ),
    ).toThrow(/identity/i);
  });

  it("keeps equal Section ids from different Providers in distinct state scopes", () => {
    const states = createPromptSurfaceSectionStates(
      document(
        { ...file("same"), sourceRef: "provider-a@v1:source" },
        { ...file("same"), sourceRef: "provider-b@v1:source" },
      ),
    );
    expect(states).toHaveLength(2);
    expect(states[0]?.stateKey).not.toBe(states[1]?.stateKey);
  });

  it("keeps identity stable when a source reference or provider version changes", () => {
    const first = createPromptSurfaceSectionStates(
      document({ ...file("same"), sourceRef: "coding.relevant-files@v1:file:login.html" }),
    );
    const refreshed = createPromptSurfaceSectionStates(
      document({ ...file("same"), sourceRef: "coding.relevant-files@v2:file:login.html?read=2" }),
    );

    expect(refreshed[0]?.stateKey).toBe(first[0]?.stateKey);
    expect(diffPromptSurfaceSections(first, refreshed, false).kind).toBe("NOOP");
  });

  it("does not emit run or step provenance in its model-visible delta", () => {
    const states = createPromptSurfaceSectionStates(
      document({
        ...file("progress"),
        id: "daemon.work-commentary-state:run-secret:step-secret",
        sourceRef: "daemon.work-commentary-state@v1:run-secret/step:step-secret",
      }),
    );
    const delta = renderPromptSurfaceRecord(
      "BASELINE",
      diffPromptSurfaceSections([], states, true).updates,
    );
    expect(delta).not.toContain("run-secret");
    expect(delta).not.toContain("step-secret");
    expect(delta).toContain("work progress");
  });

  it("labels separate project instruction Sections with safe relative paths", () => {
    const instructions: ContextDocument = {
      sections: [
        {
          id: "coding.project-instructions:AGENTS.md",
          authority: "PROJECT_INSTRUCTION",
          sourceRef: "coding.project-instructions@v1:project/AGENTS.md",
          cacheStability: "SEMI_STABLE",
          priorityClass: "HIGH",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          text: "root guidance",
        },
        {
          id: "coding.project-instructions:packages/app/AGENTS.override.md",
          authority: "PROJECT_INSTRUCTION",
          sourceRef: "coding.project-instructions@v1:project/packages/app/AGENTS.override.md",
          cacheStability: "SEMI_STABLE",
          priorityClass: "HIGH",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          text: "nested guidance",
        },
      ],
    };
    const rendered = renderPromptSurfaceRecord(
      "BASELINE",
      diffPromptSurfaceSections([], createPromptSurfaceSectionStates(instructions), true).updates,
    );

    expect(rendered).toContain('label="project instruction AGENTS.md"');
    expect(rendered).toContain('label="project instruction packages/app/AGENTS.override.md"');
    expect(rendered).not.toContain("C:\\");
  });
});
