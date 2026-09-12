import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const aiRoot = join(root, "packages/ai");
const aiSourceRoot = join(aiRoot, "src");
const aiTestRoot = join(aiRoot, "test");

/** The only directory in the repository allowed to import a provider SDK. */
const AI_ADAPTER_SDK_ROOT = join(aiSourceRoot, "adapters/openai-compatible");

const CAELUSH_SCOPE = "@caelush/";

/** Provider SDK specifiers that are confined to the adapter implementation. */
const PROVIDER_SDK_SPECIFIERS = [
  /^ai$/,
  /^@ai-sdk\//,
  /^openai$/,
  /^openai\//,
  /^@anthropic-ai\//,
  /^@google\//,
  /^@aws-sdk\//,
];

/**
 * Provider SDK type names that must never appear in a public declaration.
 *
 * A name check backs up the specifier check, because a declaration can mention an
 * SDK type through an inferred structural type without an explicit import.
 */
const PROVIDER_SDK_TYPE_NAMES =
  /StreamTextResult|LanguageModelV\d|ModelMessage|ToolSet|TextStreamPart|OpenAICompatibleProvider|SharedV4ProviderOptions/;

function tsFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...tsFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function declarationFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...declarationFiles(path));
    else if (entry.isFile() && path.endsWith(".d.ts")) files.push(path);
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

function isProviderSdk(specifier: string): boolean {
  return PROVIDER_SDK_SPECIFIERS.some((pattern) => pattern.test(specifier));
}

interface Manifest {
  readonly exports: Record<string, { types: string; import: string }>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

function readManifest(packageRoot: string): Manifest {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
}

function declaredDependencies(manifest: Manifest): string[] {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
    (field) => Object.keys((manifest[field as keyof Manifest] as Record<string, string>) ?? {}),
  );
}

/** Resolve a relative declaration specifier to the `.d.ts` file it names. */
function resolveDeclaration(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = base.endsWith(".js")
    ? [`${base.slice(0, -3)}.d.ts`]
    : [`${base}.d.ts`, join(base, "index.d.ts")];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Every declaration file reachable from the package `exports` map.
 *
 * Only this closure is public: a file under `dist/` that no export reaches is
 * internal, and the adapter implementation legitimately mentions SDK types there.
 */
function publicDeclarationClosure(packageRoot: string, manifest: Manifest): string[] {
  const visited = new Set<string>();
  const queue = Object.values(manifest.exports).map((entry) => join(packageRoot, entry.types));

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);

    for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveDeclaration(file, specifier);
      if (resolved !== undefined) queue.push(resolved);
    }
  }
  return [...visited];
}

/** Report SDK leakage across a set of declaration files. */
function sdkLeaks(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const sdkSpecifier = moduleSpecifiers(source).find(isProviderSdk);
    if (sdkSpecifier !== undefined) return [`${relative(root, path)} -> ${sdkSpecifier}`];
    if (PROVIDER_SDK_TYPE_NAMES.test(source)) return [`${relative(root, path)} -> SDK type name`];
    return [];
  });
}

describe("AI package workspace independence", () => {
  it("has no source file importing any @caelush/* package", () => {
    const violations = tsFiles(aiSourceRoot).flatMap((path) =>
      moduleSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.startsWith(CAELUSH_SCOPE))
        .map((specifier) => `${relative(root, path)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("imports no other Caelush package from its tests either", () => {
    const violations = tsFiles(aiTestRoot).flatMap((path) =>
      moduleSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.startsWith(CAELUSH_SCOPE))
        .filter((specifier) => !specifier.startsWith("@caelush/ai"))
        .map((specifier) => `${relative(root, path)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("declares no @caelush/* dependency in any dependency field", () => {
    const manifest = readManifest(aiRoot);

    expect(declaredDependencies(manifest).filter((name) => name.startsWith(CAELUSH_SCOPE))).toEqual(
      [],
    );
  });

  it("still depends on nothing but the pinned SDK and uuid", () => {
    const manifest = readManifest(aiRoot);

    expect(manifest.dependencies).toEqual({
      "@ai-sdk/openai-compatible": "3.0.39",
      ai: "7.0.83",
      uuid: "14.0.2",
    });
  });
});

describe("AI package SDK ownership", () => {
  it("allows a provider SDK import only inside the OpenAI-compatible adapter", () => {
    const violations = tsFiles(aiSourceRoot)
      .filter((path) => !path.startsWith(AI_ADAPTER_SDK_ROOT))
      .flatMap((path) =>
        moduleSpecifiers(readFileSync(path, "utf8"))
          .filter(isProviderSdk)
          .map((specifier) => `${relative(root, path)} -> ${specifier}`),
      );

    expect(violations).toEqual([]);
  });

  it("keeps every core subdirectory SDK-free", () => {
    const coreSubdirectories = [
      "gateway",
      "models",
      "providers",
      "request",
      "messages",
      "errors",
      "stream",
      "tools",
      "reasoning",
      "cache",
      "ids",
      "json",
      "internal",
    ];

    const violations = coreSubdirectories
      .flatMap((name) => tsFiles(join(aiSourceRoot, name)))
      .flatMap((path) =>
        moduleSpecifiers(readFileSync(path, "utf8"))
          .filter(isProviderSdk)
          .map((specifier) => `${relative(root, path)} -> ${specifier}`),
      );

    expect(violations).toEqual([]);
  });

  it("actually uses the SDK inside the adapter, so the rules above are meaningful", () => {
    const sdkUsers = tsFiles(AI_ADAPTER_SDK_ROOT).filter((path) =>
      moduleSpecifiers(readFileSync(path, "utf8")).some(isProviderSdk),
    );

    expect(sdkUsers.length).toBeGreaterThan(0);
  });
});

describe("AI public declaration isolation", () => {
  const distRoot = join(aiRoot, "dist");

  it("has been built", () => {
    expect(existsSync(join(distRoot, "index.d.ts"))).toBe(true);
    expect(existsSync(join(distRoot, "adapters/openai-compatible/index.d.ts"))).toBe(true);
  });

  it("exposes no other Caelush package through its declarations", () => {
    const violations = declarationFiles(distRoot).flatMap((path) =>
      moduleSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.startsWith(CAELUSH_SCOPE))
        .map((specifier) => `${relative(root, path)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("leaks no provider SDK type through the publicly reachable declarations", () => {
    const manifest = readManifest(aiRoot);
    const closure = publicDeclarationClosure(aiRoot, manifest);
    expect(closure.length).toBeGreaterThan(0);

    expect(sdkLeaks(closure)).toEqual([]);
  });

  it("confines every SDK mention in the build output to the adapter directory", () => {
    const violations = declarationFiles(distRoot)
      .filter((path) => !path.startsWith(join(distRoot, "adapters/openai-compatible")))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        const sdkSpecifier = moduleSpecifiers(source).find(isProviderSdk);
        return sdkSpecifier === undefined ? [] : [`${relative(root, path)} -> ${sdkSpecifier}`];
      });

    expect(violations).toEqual([]);
  });

  it("declares every public subpath and nothing else", () => {
    const manifest = readManifest(aiRoot);

    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./adapters",
      "./adapters/openai-compatible",
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
