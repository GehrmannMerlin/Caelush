import { StringDecoder } from "node:string_decoder";
import type { GitRunner } from "./contracts.js";
import { RuntimeGitError } from "../runtime-errors.js";
import { gitCommandError } from "./errors.js";

export async function assertGitRepository(runner: GitRunner, cwd: string): Promise<string> {
  const result = await runner.run({
    cwd,
    args: ["rev-parse", "--show-toplevel"],
    maxOutputBytes: 4096,
  });
  const stderr = decode(result.stderr);
  if (result.exitCode !== 0) throw gitCommandError(stderr);
  const root = decode(result.stdout).trim();
  if (result.stdoutTruncated || root.length === 0) {
    throw new RuntimeGitError("GIT_COMMAND_FAILED");
  }
  return root;
}

export function decode(bytes: Uint8Array): string {
  const decoder = new StringDecoder("utf8");
  return decoder.write(Buffer.from(bytes)) + decoder.end();
}
