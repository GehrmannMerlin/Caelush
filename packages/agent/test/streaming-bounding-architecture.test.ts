import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const guardedFiles = [
  "packages/agent/src/events/model-stream-signal-projector.ts",
  "packages/agent/src/tools/result/result-policy.ts",
  "packages/agent/src/context/source/extension-contribution-provider.ts",
  "packages/agent/src/utils/utf8.ts",
  "packages/coding-agent/src/tools/runtime-progress-signal-projector.ts",
  "packages/coding-agent/src/tools/utf8.ts",
  "packages/runtime/src/exec/output-buffer.ts",
  "packages/runtime/src/exec/utf8.ts",
] as const;
const growingPrefixRecounts = [
  /byteLength\s*\(\s*`\$\{current\}\$\{character\}`\s*\)/u,
  /(?:Buffer\.)?byteLength\s*\(\s*(?:prefix|result|output)\s*\+\s*character/u,
  /(?:utf8)?ByteLength\s*\(\s*(?:current|prefix|result|output)\s*\+\s*(?:character|chunk)/iu,
  /new\s+TextEncoder\s*\(\s*\)\s*\.\s*encode\s*\(\s*candidate\s*\)/u,
  /(?:Buffer\.)?byteLength\s*\(\s*combined\s*\)/u,
  /(?:Buffer\.)?(?:utf8)?ByteLength\s*\(\s*this\.retained\s*\+\s*text/iu,
  /(?:Buffer\.)?byteLength\s*\(\s*this\.tailPart\s*\+\s*text/u,
  /Buffer\.byteLength\s*\(\s*this\.headPart\s*\+\s*this\.tailPart/u,
  /byteLength\s*\(\s*this\.truncated\s*\?\s*this\.headPart\s*\+\s*this\.tailPart/u,
];

describe("bounded streaming source guard", () => {
  it.each(guardedFiles)("does not recount growing UTF-8 prefixes in %s", (file) => {
    const source = readFileSync(resolve(repositoryRoot, file), "utf8");
    const violation = growingPrefixRecounts.find((pattern) => pattern.test(source));

    expect(violation, `${file} contains a growing-prefix UTF-8 recount`).toBeUndefined();
  });
});
