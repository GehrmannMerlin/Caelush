import { RuntimeGitError } from "../runtime-errors.js";

export function isNotGitRepository(stderr: string): boolean {
  return /not a git repository|git repository not found|parent directories.*\.git|invalid gitfile/i.test(
    stderr,
  );
}

export function gitCommandError(stderr: string): RuntimeGitError {
  return new RuntimeGitError(
    isNotGitRepository(stderr) ? "NOT_A_GIT_REPOSITORY" : "GIT_COMMAND_FAILED",
  );
}
