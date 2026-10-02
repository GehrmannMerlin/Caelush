import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

/**
 * Runs the real Windows permission security suites and refuses to report a pass that a suite which
 * silently measured nothing could also produce.
 *
 * The three targets below are the Windows permission surface: the `VIEW_ONLY` matrix, the
 * `WORKSPACE_WRITE` matrix, and the ACL preparation/inspection contract. `--lib` is deliberately not
 * part of this command — its single reparse-point test cannot build its precondition on this host
 * yet, and that characterization belongs to the boundary task, so including it here would report an
 * unrelated red rather than a permission result.
 */
const TARGETS = ["windows_read_only", "windows_workspace_write", "windows_workspace_acl"];

/**
 * Markers that only a genuine measurement can produce.
 *
 * Both matrix modes must print their table, and both must print the unrestricted control line. A
 * suite that quietly stopped running the matrix, or a harness whose control never executed, cannot
 * satisfy these.
 */
const REQUIRED_EVIDENCE = [
  "windows permission matrix :: mode=read-only",
  "windows permission matrix :: mode=workspace-write",
  "harness control:",
];

const SUMMARY_PATTERN = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/gm;

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runnerDirectory = join(repositoryRoot, "native", "sandbox-runner");

function write(text) {
  process.stdout.write(`${text}\n`);
}

function writeError(text) {
  process.stderr.write(`${text}\n`);
}

function main() {
  if (process.platform !== "win32") {
    throw new Error(
      "test:sandbox:windows measures real Windows security primitives and has no meaningful " +
        "non-Windows mode. Run it on the primary Windows host instead of skipping it silently.",
    );
  }
  const cargo = process.env.CAELUSH_CARGO ?? "cargo";
  const transcript = [];
  const problems = [];

  for (const target of TARGETS) {
    write(`\n=== cargo test --test ${target} ===`);
    const result = spawnSync(
      cargo,
      ["test", "--test", target, "--", "--nocapture", "--test-threads=1"],
      {
        cwd: runnerDirectory,
        // `cargo test` never reads stdin, and an inherited stdout can fail with EBUSY on Windows.
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
    if (result.error) {
      throw new Error(`Unable to run ${cargo}: ${result.error.message}`);
    }
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    transcript.push(output);
    write(output.trimEnd());

    const summaries = [...output.matchAll(SUMMARY_PATTERN)];
    if (summaries.length === 0) {
      problems.push(`${target}: produced no 'test result' summary, so nothing was measured`);
      continue;
    }
    const passed = summaries.reduce((total, summary) => total + Number(summary[1]), 0);
    const failed = summaries.reduce((total, summary) => total + Number(summary[2]), 0);
    if (passed === 0) {
      problems.push(`${target}: reported 0 passing tests`);
    }
    if (failed > 0 || result.status !== 0) {
      problems.push(`${target}: ${passed} passed, ${failed} failed, exit status ${result.status}`);
    }
    write(`--- ${target}: ${passed} passed, ${failed} failed`);
  }

  const evidence = transcript.join("\n");
  for (const marker of REQUIRED_EVIDENCE) {
    if (!evidence.includes(marker)) {
      problems.push(`the run never produced the required evidence '${marker}'`);
    }
  }

  if (problems.length > 0) {
    writeError("\nWindows permission sandbox verification FAILED:");
    for (const problem of problems) {
      writeError(`  - ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  write(
    `\nWindows permission sandbox verification passed: ${TARGETS.length} targets, ` +
      `${REQUIRED_EVIDENCE.length} evidence markers.`,
  );
}

main();
