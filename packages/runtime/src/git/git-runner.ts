import { spawn } from "node:child_process";
import process from "node:process";
import { GIT_EXECUTABLE, type GitRunner, type GitRunnerResult } from "./contracts.js";
import { RuntimeGitError } from "../runtime-errors.js";
import { createStructuredHelperEnvironment } from "../exec/environment-policy.js";

const MAX_ERROR_BYTES = 16 * 1024;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export class LocalGitRunner implements GitRunner {
  async run(input: {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly maxOutputBytes?: number;
  }): Promise<GitRunnerResult> {
    const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(GIT_EXECUTABLE, [...input.args], {
          cwd: input.cwd,
          shell: false,
          env: {
            ...createStructuredHelperEnvironment(process.env, process.platform),
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
            GIT_PAGER: "cat",
            PAGER: "cat",
            NO_COLOR: "1",
            LC_ALL: "C.UTF-8",
            LANG: "C.UTF-8",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: NULL_DEVICE,
            GIT_CONFIG_SYSTEM: NULL_DEVICE,
            GIT_ATTR_NOSYSTEM: "1",
            GIT_ASKPASS: "",
            GIT_SEQUENCE_EDITOR: ":",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(new RuntimeGitError("GIT_UNAVAILABLE"));
        return;
      }

      const stdout = boundedBytes(maxOutputBytes);
      const stderr = boundedBytes(MAX_ERROR_BYTES);
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          new RuntimeGitError(error.code === "ENOENT" ? "GIT_UNAVAILABLE" : "GIT_COMMAND_FAILED"),
        );
      });
      child.once("close", (exitCode, signal) =>
        resolve({
          exitCode,
          ...(signal === null ? {} : { signal }),
          stdout: stdout.bytes(),
          stderr: stderr.bytes(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          stdoutOmittedBytes: stdout.omittedBytes,
          stderrOmittedBytes: stderr.omittedBytes,
        }),
      );
    });
  }
}

function boundedBytes(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let omittedBytes = 0;
  return {
    push(chunk: Buffer) {
      if (size >= limit) {
        truncated = true;
        omittedBytes += chunk.byteLength;
        return;
      }
      const remaining = limit - size;
      chunks.push(chunk.subarray(0, remaining));
      size += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) {
        truncated = true;
        omittedBytes += chunk.byteLength - remaining;
      }
    },
    bytes: () => Buffer.concat(chunks),
    get truncated() {
      return truncated;
    },
    get omittedBytes() {
      return omittedBytes;
    },
  };
}
