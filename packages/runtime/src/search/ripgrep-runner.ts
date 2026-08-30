import { spawn } from "node:child_process";
import { PROJECT_HARD_EXCLUDED_GLOBS } from "@caelush/shared";
import {
  RuntimeInvariantError,
  RuntimeSearchError,
  RuntimeSearchUnavailableError,
} from "../runtime-errors.js";
import { parseRipgrepJson } from "./ripgrep-parser.js";
import type {
  RuntimeTextSearch,
  RuntimeTextSearchRequest,
  RuntimeTextSearchResult,
} from "./text-search.js";
import process from "node:process";
import { createStructuredHelperEnvironment } from "../exec/environment-policy.js";

export const RIPGREP_EXECUTABLE = "rg";
export const MAX_RG_STDOUT_BYTES = 1024 * 1024;
export const MAX_RG_STDERR_BYTES = 16 * 1024;

function boundedText(chunks: Buffer[], size: number): { text: string; exceeded: boolean } {
  const value = Buffer.concat(chunks);
  return { text: value.subarray(0, size).toString("utf8"), exceeded: value.byteLength > size };
}

export class LocalRipgrepRunner implements RuntimeTextSearch {
  async search(request: RuntimeTextSearchRequest): Promise<RuntimeTextSearchResult> {
    const args = ["--no-config", "--json", "--line-number", "--color=never"];
    for (const exclusion of PROJECT_HARD_EXCLUDED_GLOBS) args.push("--glob", `!${exclusion}`);
    if (request.include !== undefined) args.push("--glob", request.include);
    args.push("--", request.pattern, ".");

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(RIPGREP_EXECUTABLE, args, {
          cwd: request.cwd,
          shell: false,
          env: createStructuredHelperEnvironment(process.env, process.platform),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(new RuntimeSearchUnavailableError("ripgrep could not be started", { cause: error }));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let capped = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        stdout.push(chunk);
        if (stdoutBytes > MAX_RG_STDOUT_BYTES && !capped) {
          capped = true;
          child.kill();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= MAX_RG_STDERR_BYTES) stderr.push(chunk);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") reject(new RuntimeSearchUnavailableError());
        else reject(new RuntimeSearchError("ripgrep failed to start", { cause: error }));
      });
      child.once("close", (code: number | null) => {
        if (capped) {
          try {
            const parsed = parseRipgrepJson(boundedText(stdout, MAX_RG_STDOUT_BYTES).text);
            resolve({ matches: parsed.slice(0, request.limit), truncated: true });
          } catch (error) {
            reject(error);
          }
          return;
        }
        const output = boundedText(stdout, MAX_RG_STDOUT_BYTES);
        if (output.exceeded) {
          reject(new RuntimeInvariantError("ripgrep stdout exceeded its safety bound"));
          return;
        }
        if (code === 1) {
          resolve({ matches: [], truncated: false });
          return;
        }
        if (code !== 0) {
          reject(
            new RuntimeSearchError("ripgrep reported a search error", {
              cause: boundedText(stderr, MAX_RG_STDERR_BYTES).text,
            }),
          );
          return;
        }
        const parsed = parseRipgrepJson(output.text);
        resolve({
          matches: parsed.slice(0, request.limit),
          truncated: parsed.length > request.limit,
        });
      });
    });
  }
}
