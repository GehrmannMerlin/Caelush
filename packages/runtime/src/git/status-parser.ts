import { RuntimeGitError } from "../runtime-errors.js";
import type { GitStatusEntry, GitStatusResult } from "./contracts.js";

export function parseGitStatus(value: string, limit: number): GitStatusResult {
  const records = value.split("\0").filter((record) => record.length > 0);
  let branch: string | undefined;
  let detached = false;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];
  for (const record of records) {
    if (record.startsWith("# ")) {
      const [key, ...rest] = record.slice(2).split(" ");
      if (key === "branch.head") {
        const value = rest.join(" ");
        detached = value === "(detached)";
        if (!detached && value.length > 0) branch = value;
      } else if (key === "branch.ab") {
        if (rest.length !== 2 || !/^[-+]\d+$/.test(rest[0]!) || !/^[-+]\d+$/.test(rest[1]!))
          throw new RuntimeGitError("GIT_COMMAND_FAILED");
        ahead = Number(rest[0]!.slice(1));
        behind = Number(rest[1]!.slice(1));
      }
      continue;
    }
    const kind = record[0];
    if (kind === "?" || kind === "!") {
      const path = record.slice(2);
      if (!path) throw new RuntimeGitError("GIT_COMMAND_FAILED");
      entries.push({
        path: normalizeGitPath(path),
        indexStatus: "?",
        worktreeStatus: "?",
        kind: "UNTRACKED",
      });
      continue;
    }
    if (kind === "1") {
      const fields = record.split(" ");
      if (fields.length < 9 || !/^[. MARDCU?!]{2}$/.test(fields[1]!))
        throw new RuntimeGitError("GIT_COMMAND_FAILED");
      const path = fields.slice(8).join(" ");
      entries.push({
        path: normalizeGitPath(path),
        indexStatus: fields[1]![0]!,
        worktreeStatus: fields[1]![1]!,
        kind: "TRACKED",
      });
      continue;
    }
    if (kind === "u") {
      const fields = record.split(" ");
      if (fields.length < 11 || !/^[. MARDCU?!]{2}$/.test(fields[1]!))
        throw new RuntimeGitError("GIT_COMMAND_FAILED");
      entries.push({
        path: normalizeGitPath(fields.slice(10).join(" ")),
        indexStatus: fields[1]![0]!,
        worktreeStatus: fields[1]![1]!,
        kind: "UNMERGED",
      });
      continue;
    }
    throw new RuntimeGitError("GIT_COMMAND_FAILED");
  }
  const sorted = entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    ...(branch === undefined ? {} : { branch }),
    detached,
    ahead,
    behind,
    clean: sorted.length === 0,
    entries: sorted.slice(0, limit),
    truncated: sorted.length > limit,
  };
}

function normalizeGitPath(value: string): string {
  if (value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))
    throw new RuntimeGitError("GIT_UNSUPPORTED_PATH_ENCODING");
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.includes("..") || normalized.length === 0)
    throw new RuntimeGitError("GIT_COMMAND_FAILED");
  return normalized;
}
