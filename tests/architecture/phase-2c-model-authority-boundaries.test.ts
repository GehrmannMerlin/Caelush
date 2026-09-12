import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture V2 Phase 2C model authority guards.
 *
 * Phase 2C converges model invocation onto one authority chain:
 *
 * ```text
 * ModelCatalog → ModelDescriptor → Context / AIGateway → ModelTurnExecutor → AgentLoop
 * ```
 *
 * These guards are deliberately *structural*: they read production source and fail when a
 * legacy authority identifier, a forbidden package edge, or a second routing input
 * reappears. They are additive to `scripts/architecture/v2-rules.mjs` and never replace
 * the boundary checker.
 */

const REPO_ROOT = process.cwd();

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const absolute = path.resolve(REPO_ROOT, directory);
  const out: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(relative)));
    else if (entry.name.endsWith(".ts")) out.push(relative.replaceAll("\\", "/"));
  }
  return out;
}

async function read(file: string): Promise<string> {
  return (await readFile(path.resolve(REPO_ROOT, file), "utf8")).replace(/\r\n/g, "\n");
}

/** `"a"` and `'a'` are the same specifier. */
function caelushSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/from\s+["'](@caelush\/[^"']+)["']/g)].map((match) => match[1] ?? "");
}

async function scan(
  directory: string,
): Promise<readonly { readonly file: string; readonly source: string }[]> {
  const files = await sourceFiles(directory);
  return Promise.all(files.map(async (file) => ({ file, source: await read(file) })));
}

describe("Phase 2C daemon model authority", () => {
  it("composes the AI subsystem and never a legacy gateway or provider registry", async () => {
    const files = await scan("apps/daemon/src");
    const offenders: string[] = [];

    for (const { file, source } of files) {
      if (/\b(?:LLMGateway|LLMProviderRegistry|createOpenAICompatibleLLMProvider)\b/.test(source)) {
        offenders.push(`${file}: legacy model authority identifier`);
      }
      if (caelushSpecifiers(source).includes("@caelush/llm")) {
        offenders.push(`${file}: imports the legacy LLM package root`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("builds the AgentLoop from the catalog and the model turn executor", async () => {
    const composition = await read("apps/daemon/src/daemon-composition.ts");
    expect(composition).toContain("createAISubsystem(");
    expect(composition).toContain("createModelTurnExecutor(");
    // The loop resolves model metadata through the same catalog generation the gateway
    // uses, so there is exactly one descriptor authority.
    expect(composition).toMatch(/models:\s*ai\.models/);
    expect(composition).toMatch(/modelTurns[,:]/);
    // Verification reviews through the same executor, not through a second generation.
    expect(composition).toMatch(/verificationModelTurns:\s*modelTurns/);
  });
});

describe("Phase 2C Core model authority", () => {
  it("never reaches a model through the legacy LLM abstraction", async () => {
    const files = await scan("packages/core/src");
    const offenders: string[] = [];

    for (const { file, source } of files) {
      if (/\b(?:LLMGateway|LLMProviderRegistry|LLMProvider|LLMStreamEvent)\b/.test(source)) {
        offenders.push(`${file}: legacy model authority identifier`);
      }
      if (caelushSpecifiers(source).includes("@caelush/llm")) {
        offenders.push(`${file}: imports the legacy LLM package root`);
      }
      if (/from\s+["']@caelush\/llm\/(?:errors|request|providers)["']/.test(source)) {
        offenders.push(`${file}: imports a legacy model-invocation subpath`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("imports the legacy message contract from an explicit per-file allowlist only", async () => {
    // Message System V2 is out of scope for Phase 2C, so `@caelush/llm/messages` stays
    // legal for the frozen message schemas — but only in the files that actually own
    // history, continuations or conversations. A new file must be a deliberate decision.
    const allowlist = [
      "packages/core/src/agent-continuation-schema.ts",
      "packages/core/src/agent-continuation.ts",
      "packages/core/src/agent-decision.ts",
      "packages/core/src/agent-loop-history.ts",
      "packages/core/src/agent-loop-input.ts",
      "packages/core/src/agent-loop.ts",
      "packages/core/src/agent-tool-batch.ts",
      "packages/core/src/agent-tool-results.ts",
      "packages/core/src/ai-invocation-projection.ts",
      "packages/core/src/run-controller-history.ts",
      "packages/core/src/run-controller-input.ts",
      "packages/core/src/run-controller-ports.ts",
      "packages/core/src/run-controller.ts",
      "packages/core/src/run-execution-store.ts",
    ];

    const files = await scan("packages/core/src");
    const actual = files
      .filter(({ source }) => source.includes('"@caelush/llm/messages"'))
      .map(({ file }) => file)
      .sort();

    expect(actual).toEqual([...allowlist].sort());
  });

  it("names the model execution seam through the AI contract and the agent port", async () => {
    const ports = await read("packages/core/src/agent-loop-ports.ts");
    expect(ports).toContain('from "@caelush/ai"');
    expect(ports).toContain('from "@caelush/agent"');
    expect(ports).toMatch(/readonly modelTurns:\s*ModelTurnExecutor/);
    expect(ports).toMatch(/readonly models:\s*ModelCatalog/);
    expect(ports).not.toMatch(/\bllmClient\b/);
  });
});

describe("Phase 2C Context model metadata authority", () => {
  it("projects intrinsic limits from a descriptor instead of resolving a second profile", async () => {
    const coordinator = await read("packages/context/src/context-runtime-coordinator.ts");

    // The descriptor path is the authority...
    expect(coordinator).toContain("projectModelContextProfile");
    // ...and the legacacy resolver is reachable only when the caller supplied no
    // descriptor, which is the one compatibility case Phase 2C keeps.
    const resolveCalls = coordinator.match(/resolveModelContextProfile\(/g) ?? [];
    expect(resolveCalls).toHaveLength(1);
    expect(coordinator).toMatch(
      /input\.model === undefined \? undefined : this\.#compatibilityProfile\(input\)/,
    );
  });

  it("keeps the policy fields out of the descriptor projection", async () => {
    const profile = await read("packages/context/src/model-context-profile.ts");
    const projection = profile.slice(profile.indexOf("export function projectModelContextProfile"));

    // The intrinsic fields come from the descriptor...
    expect(projection).toContain("descriptor.limits.contextWindowTokens");
    expect(projection).toContain("descriptor.limits.maxOutputTokens");
    // ...and the policy fields come from the caller, never from the descriptor.
    expect(projection).toContain("input.recommendedOutputReserveTokens");
    expect(projection).not.toContain("descriptor.recommendedOutputReserveTokens");
    expect(projection).not.toContain("descriptor.toolOutputSoftLimitTokens");
  });
});

describe("Phase 2C endpoint authority", () => {
  it("never reattaches a stored baseUrl to a model selection", async () => {
    const files = await scan("apps/daemon/src");
    const offenders: string[] = [];

    for (const { file, source } of files) {
      // A spread that puts `baseUrl` back onto a selection would restore a second
      // routing input next to the provider binding.
      if (/\{\s*\.\.\.\s*[A-Za-z_$][\w$]*\s*,\s*baseUrl\s*:/.test(source)) {
        offenders.push(`${file}: reintroduces baseUrl into a model selection`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the daemon model canonicalizer free of endpoint data in its output", async () => {
    const canonicalizer = await read("apps/daemon/src/providers/model-canonicalizer.ts");
    // Comments explain the removed behaviour; only executable code is guarded.
    const code = canonicalizer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // The legacy configuration DTO is the only thing that may name an endpoint: it is
    // the operator's input, not a model identity.
    expect(code).toMatch(/readonly baseUrl: string;/);
    // No result object may carry one back out.
    expect(code).not.toMatch(/baseUrl\s*[,}]/);
    expect(code).not.toMatch(/\.\.\.[^;]*baseUrl/);
  });
});

describe("Phase 2C package edges", () => {
  it("keeps Storage free of the AI core", async () => {
    const files = await scan("packages/storage/src");
    const offenders = files
      .filter(({ source }) => caelushSpecifiers(source).includes("@caelush/ai"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps the Agent port package free of every legacy package", async () => {
    const files = await scan("packages/agent/src");
    const offenders: string[] = [];
    for (const { file, source } of files) {
      for (const specifier of caelushSpecifiers(source)) {
        if (specifier !== "@caelush/ai") offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the Agent port surface root-only and tiny", async () => {
    const entry = await read("packages/agent/src/index.ts");
    // No cross-package re-export and no wildcard: the public surface is exactly the
    // factory plus the four contracts that describe it.
    expect(caelushSpecifiers(entry)).toEqual([]);
    expect(entry).not.toMatch(/export \* from/);
    const exported = [...entry.matchAll(/export \{([^}]*)\}/g)].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    );
    expect(exported).toEqual(["createModelTurnExecutor"]);
  });
});
