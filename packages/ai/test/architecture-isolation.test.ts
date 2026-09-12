import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const aiRoot = join(root, "packages/ai");
const sourceRoot = join(aiRoot, "src");
const testRoot = join(aiRoot, "test");

/** Every Caelush workspace package, by manifest name. */
const CAELUSH_SCOPE = "@caelush/";

/** Provider SDKs that must not exist in the AI core during Phase 2A. */
const FORBIDDEN_SDK_SPECIFIERS = [
  /^ai$/,
  /^@ai-sdk\//,
  /^openai$/,
  /^openai\//,
  /^@anthropic-ai\//,
  /^@google\//,
  /^@aws-sdk\//,
];

function tsFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...tsFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** Every module specifier a file imports, from `import … from "x"` and `import("x")`. */
function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+\*\s+from\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function declarations(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...declarations(path));
    else if (entry.isFile() && path.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

describe("AI package workspace independence", () => {
  it("has no source file importing any @caelush/* package", () => {
    const violations = tsFiles(sourceRoot).flatMap((path) =>
      moduleSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.startsWith(CAELUSH_SCOPE))
        .map((specifier) => `${relative(root, path)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("imports no other Caelush package from its tests either", () => {
    const violations = tsFiles(testRoot).flatMap((path) =>
      moduleSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.startsWith(CAELUSH_SCOPE))
        // The package's own public subpaths are the subject of the boundary test.
        .filter((specifier) => !specifier.startsWith("@caelush/ai"))
        .map((specifier) => `${relative(root, path)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("declares no @caelush/* dependency in any dependency field", () => {
    const manifest = JSON.parse(readFileSync(join(aiRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;

    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const declared = Object.keys((manifest[field] as Record<string, string> | undefined) ?? {});
      expect(
        declared.filter((name) => name.startsWith(CAELUSH_SCOPE)),
        field,
      ).toEqual([]);
    }
  });
});

describe("AI package SDK isolation", () => {
  it("imports no provider SDK from source or tests", () => {
    const violations = [...tsFiles(sourceRoot), ...tsFiles(testRoot)].flatMap((path) =>
      moduleSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => FORBIDDEN_SDK_SPECIFIERS.some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${relative(root, path)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("declares no provider SDK dependency", () => {
    const manifest = JSON.parse(readFileSync(join(aiRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;

    const declared = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ].flatMap((field) =>
      Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
    );

    expect(
      declared.filter((name) => FORBIDDEN_SDK_SPECIFIERS.some((pattern) => pattern.test(name))),
    ).toEqual([]);
  });

  it("ships exactly one third-party dependency: uuid", () => {
    const manifest = JSON.parse(readFileSync(join(aiRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies).toEqual({ uuid: "14.0.2" });
  });
});

describe("AI public declaration isolation", () => {
  const distRoot = join(aiRoot, "dist");

  it("has been built", () => {
    expect(existsSync(join(distRoot, "index.d.ts"))).toBe(true);
  });

  it("exposes no other Caelush package through its declarations", () => {
    const violations = declarations(distRoot).flatMap((path) =>
      moduleSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.startsWith(CAELUSH_SCOPE))
        .map((specifier) => `${relative(root, path)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("exposes no provider SDK type or module", () => {
    const violations = declarations(distRoot)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return (
          FORBIDDEN_SDK_SPECIFIERS.some((pattern) =>
            moduleSpecifiers(source).some((specifier) => pattern.test(specifier)),
          ) || /StreamTextResult|ModelMessage|ToolSet|LanguageModel|OpenAI\.Chat/.test(source)
        );
      })
      .map((path) => relative(root, path));

    expect(violations).toEqual([]);
  });

  it("declares every public subpath and nothing else", () => {
    const manifest = JSON.parse(readFileSync(join(aiRoot, "package.json"), "utf8")) as {
      exports: Record<string, { types: string; import: string }>;
    };

    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./adapters",
      "./errors",
      "./messages",
      "./models",
      "./providers",
      "./request",
      "./stream",
    ]);

    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      expect(existsSync(join(aiRoot, entry.types)), `${subpath} types`).toBe(true);
      expect(existsSync(join(aiRoot, entry.import)), `${subpath} import`).toBe(true);
    }
  });
});
