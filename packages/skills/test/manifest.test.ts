import { describe, expect, it } from "vitest";
import { parseSkillManifest } from "../src/index.js";

describe("parseSkillManifest", () => {
  it("D01 parses a standard manifest without loading executable code", () => {
    const result = parseSkillManifest(
      "---\nname: pdf\ndescription: Read PDF documents\n---\nRead references only when needed.",
    );

    expect(result).toEqual({
      ok: true,
      manifest: {
        name: "pdf",
        description: "Read PDF documents",
        body: "Read references only when needed.",
        userInvocable: true,
        modelInvocable: true,
      },
    });
  });

  it("returns one safe diagnostic when description is missing", () => {
    const result = parseSkillManifest("---\nname: pdf\n---\nBody");

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "DESCRIPTION_REQUIRED",
          severity: "ERROR",
          safeMessage: expect.any(String),
        },
      ],
    });
    if (!result.ok) expect(result.diagnostics).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/C:\\|Error:|YAMLException/);
  });

  it("rejects duplicate YAML keys with a deterministic safe diagnostic", () => {
    const result = parseSkillManifest(
      "---\nname: first\nname: second\ndescription: Safe text\n---\nBody",
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "YAML_DUPLICATE_KEY",
          severity: "ERROR",
          safeMessage: expect.any(String),
        },
      ],
    });
    if (!result.ok) expect(result.diagnostics).toHaveLength(1);
  });

  it("limits YAML alias expansion and does not expose parser exceptions", () => {
    const aliases = Array.from({ length: 120 }, () => "*shared").join(", ");
    const source = [
      "---",
      "name: safe",
      "description: Safe text",
      "metadata: &shared { note: value }",
      `extension: [${aliases}]`,
      "---",
      "Body",
    ].join("\n");
    const result = parseSkillManifest(source);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "YAML_ALIAS_LIMIT_EXCEEDED",
          severity: "ERROR",
          safeMessage: expect.any(String),
        },
      ],
    });
    if (!result.ok) expect(result.diagnostics).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/ReferenceError|Excessive alias|shared/);
  });

  it("rejects a manifest larger than 256 KiB before parsing it", () => {
    const source = `---\nname: safe\ndescription: Safe text\n---\n${"x".repeat(256 * 1024)}`;
    const result = parseSkillManifest(source);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "MANIFEST_TOO_LARGE",
          severity: "ERROR",
          safeMessage: expect.any(String),
        },
      ],
    });
    if (!result.ok) expect(result.diagnostics).toHaveLength(1);
  });

  it("strips a leading BOM and normalizes CRLF in manifest and body", () => {
    const result = parseSkillManifest(
      "\uFEFF---\r\nname: pdf\r\ndescription: Read PDFs\r\n---\r\nFirst line\r\nSecond line\r\n",
    );

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        name: "pdf",
        description: "Read PDFs",
        body: "First line\nSecond line\n",
      },
    });
  });

  it("enforces standard names and description character and byte limits", () => {
    const acceptedName = parseSkillManifest(manifest("a".repeat(64), "Length boundary"));
    expect(acceptedName.ok).toBe(true);

    const longName = parseSkillManifest(manifest("a".repeat(65), "Length boundary"));
    expectDiagnosticCode(longName, "NAME_TOO_LONG");

    const invalidName = parseSkillManifest(manifest("Upper_Case", "Invalid name"));
    expectDiagnosticCode(invalidName, "NAME_INVALID");

    const acceptedDescription = parseSkillManifest(
      manifest("description-boundary", "d".repeat(1024)),
    );
    expect(acceptedDescription.ok).toBe(true);

    const longDescription = parseSkillManifest(manifest("description-boundary", "d".repeat(1025)));
    expectDiagnosticCode(longDescription, "DESCRIPTION_TOO_LONG");

    const maxByteDescription = "😀".repeat(1024);
    expect(new TextEncoder().encode(maxByteDescription).byteLength).toBe(4096);
    const maxByteResult = parseSkillManifest(manifest("utf8-boundary", maxByteDescription));
    expect(maxByteResult.ok).toBe(true);
  });

  it("uses invocation policy defaults and honors the two booleans independently", () => {
    const defaults = parseSkillManifest(manifest("default-policy", "Default policy"));
    expectManifestPolicy(defaults, { userInvocable: true, modelInvocable: true });

    const modelDisabled = parseSkillManifest(
      manifest("model-disabled", "Manual only", "disable-model-invocation: true"),
    );
    expectManifestPolicy(modelDisabled, { userInvocable: true, modelInvocable: false });

    const userDisabled = parseSkillManifest(
      manifest("user-disabled", "Automatic only", "user-invocable: false"),
    );
    expectManifestPolicy(userDisabled, { userInvocable: false, modelInvocable: true });

    const bothDisabled = parseSkillManifest(
      manifest(
        "both-disabled",
        "Unavailable by either strategy",
        "disable-model-invocation: true\nuser-invocable: false",
      ),
    );
    expectManifestPolicy(bothDisabled, { userInvocable: false, modelInvocable: false });
  });

  it("ignores unknown fields without turning them into authorization", () => {
    const result = parseSkillManifest(
      manifest(
        "unknown-fields",
        "Unknown values are not permissions",
        "permissions: [run_command]\nallow-all: true",
      ),
    );

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.manifest).not.toHaveProperty("permissions");
      expect(result.manifest).not.toHaveProperty("allow-all");
      expect(result.manifest.userInvocable).toBe(true);
      expect(result.manifest.modelInvocable).toBe(true);
    }
  });

  it("rejects non-boolean invocation policy values rather than coercing them", () => {
    const result = parseSkillManifest(
      manifest("invalid-policy", "Policies are typed", 'user-invocable: "false"'),
    );

    expectDiagnosticCode(result, "INVOCATION_POLICY_INVALID");
  });
});

function manifest(name: string, description: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}${extra.length === 0 ? "" : `\n${extra}`}\n---\nBody`;
}

function expectDiagnosticCode(result: ReturnType<typeof parseSkillManifest>, code: string): void {
  expect(result).toMatchObject({ ok: false, diagnostics: [{ code, severity: "ERROR" }] });
}

function expectManifestPolicy(
  result: ReturnType<typeof parseSkillManifest>,
  expected: { readonly userInvocable: boolean; readonly modelInvocable: boolean },
): void {
  expect(result).toMatchObject({ ok: true, manifest: expected });
}
