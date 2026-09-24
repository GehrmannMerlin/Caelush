import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 2D closure guards for AI model invocation.
 *
 * These are the machine-checked proof that the V2 AI migration is closed on the
 * invocation axis, and they are deliberately static: they read the repository rather
 * than a live runtime, so a regression fails at review time instead of in production.
 */

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** Every `.ts` file of every workspace project, split by production or test scope. */
function workspaceFiles(scope: "src" | "test"): string[] {
  const files: string[] = [];
  for (const group of ["packages", "apps"]) {
    const groupRoot = join(root, group);
    if (!existsSync(groupRoot)) continue;
    for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      files.push(...sourceFiles(join(groupRoot, entry.name, scope)));
    }
  }
  return files;
}

/** Every ES module specifier a file imports, including dynamic and re-exports. */
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

function filesMatching(files: readonly string[], predicate: (path: string) => boolean): string[] {
  return files.filter(predicate).map((path) => relative(root, path).replaceAll("\\", "/"));
}

describe("legacy model invocation is closed", () => {
  const productionFiles = workspaceFiles("src");

  it("allows no production file to import the retired LLM package", () => {
    const violations = productionFiles
      .flatMap((path) =>
        moduleSpecifiers(readFileSync(path, "utf8"))
          .filter((specifier) => specifier === "@caelush/llm" || specifier.startsWith("@caelush/llm/"))
          .map((specifier) => `${relative(root, path).replaceAll("\\", "/")} -> ${specifier}`),
      );

    expect(violations).toEqual([]);
  });

  it("fully retires the legacy package directory and manifest", () => {
    expect(existsSync(join(root, "packages", "llm"))).toBe(false);
    expect(existsSync(join(root, "packages", "llm", "package.json"))).toBe(false);
  });

  it("declares no legacy model-invocation authority anywhere in production source", () => {
    const retiredSymbols =
      /\b(?:LLMGateway|LLMProviderRegistry|createOpenAICompatibleLLMProvider|LLMProviderNotFoundError|LLMInvalidResponseError|LLMRateLimitError|LLMNetworkError|LLMTimeoutError|LLMAbortedError|LLMStreamEventSchema|LLMRequestSchema|LLMCapabilitiesSchema)\b/;

    const violations = productionFiles
      .filter((path) => !path.includes(join("packages", "llm")))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        // A mention inside a comment is documentation, not an authority. Strip block
        // and line comments before matching so the guard tracks real code.
        const withoutComments = source
          .replaceAll(/\/\*[\s\S]*?\*\//g, "")
          .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
        return retiredSymbols.test(withoutComments);
      })
      .map((path) => relative(root, path).replaceAll("\\", "/"));

    expect(violations).toEqual([]);
  });
});

describe("no Anthropic SDK dependency", () => {
  it("declares no Anthropic SDK in the AI package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", "ai", "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;

    expect(manifest.dependencies).toEqual({
      "@ai-sdk/openai-compatible": "3.0.39",
      ai: "7.0.83",
      uuid: "14.0.2",
    });
  });

  it("imports no Anthropic SDK anywhere in workspace source or tests", () => {
    const files = [...workspaceFiles("src"), ...workspaceFiles("test")];
    const violations = files.flatMap((path) =>
      moduleSpecifiers(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.startsWith("@anthropic-ai/"))
        .map((specifier) => `${relative(root, path).replaceAll("\\", "/")} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("keeps the native adapter on fetch and its own SSE parser", () => {
    const adapterFiles = sourceFiles(
      join(root, "packages", "ai", "src", "adapters", "anthropic-messages"),
    );

    expect(adapterFiles.length).toBeGreaterThan(0);
    // No SDK specifier at all, so the dialect is implemented against the transport seam.
    const sdkUsers = filesMatching(adapterFiles, (path) =>
      /["'](?:ai|@ai-sdk\/|openai|@anthropic-ai\/)/.test(
        moduleSpecifiers(readFileSync(path, "utf8")).join(","),
      ),
    );
    expect(sdkUsers).toEqual([]);
  });
});

describe("model invocation chooses the dialect by descriptor", () => {
  /**
   * The routing decision belongs to `ModelDescriptor.api` resolved through the adapter
   * registry. A dialect chosen by inspecting a provider name would be a hidden,
   * untestable second authority.
   */
  const ROUTING_ROOTS = ["packages/ai/src/gateway", "packages/agent/src", "packages/core/src"];

  const PROVIDER_NAMES = [
    "anthropic",
    "openai",
    "deepseek",
    "qwen",
    "openrouter",
    "gemini",
    "mistral",
  ] as const;

  it("contains no provider-name branch in the invocation path", () => {
    const violations: string[] = [];

    for (const relativeRoot of ROUTING_ROOTS) {
      for (const path of sourceFiles(join(root, relativeRoot))) {
        const source = readFileSync(path, "utf8")
          .replaceAll(/\/\*[\s\S]*?\*\//g, "")
          .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
        const lines = source.split("\n");
        lines.forEach((line, index) => {
          for (const name of PROVIDER_NAMES) {
            // A comparison against a provider-name string literal is the pattern this
            // guard exists to catch: `x === "anthropic"`, `x.includes("openai")`,
            // a `switch` on a provider name, or an index by provider name.
            const branches = [
              new RegExp(`[=!]==?\\s*["'\`][^"'\`]*${name}`, "i"),
              new RegExp(
                `\\.(?:includes|startsWith|endsWith|match|test)\\s*\\(\\s*["'\`][^"'\`]*${name}`,
                "i",
              ),
              new RegExp(`case\\s+["'\`][^"'\`]*${name}`, "i"),
            ];
            if (branches.some((pattern) => pattern.test(line))) {
              violations.push(`${relativeRoot} line ${String(index + 1)}: ${name}`);
            }
          }
        });
      }
    }

    expect(violations).toEqual([]);
  });

  it("resolves the adapter from the model descriptor's api id", () => {
    const resolver = readFileSync(
      join(root, "packages", "ai", "src", "gateway", "gateway-request-resolver.ts"),
      "utf8",
    );

    expect(resolver).toContain("dependencies.adapters.get(descriptor.api)");
  });

  it("registers both reserved dialects in the daemon composition", () => {
    const composition = readFileSync(
      join(root, "apps", "daemon", "src", "providers", "legacy-ai-configuration.ts"),
      "utf8",
    );

    expect(composition).toContain("createOpenAICompatibleApiAdapter()");
    expect(composition).toContain("createAnthropicMessagesApiAdapter()");
  });
});
