#![cfg(windows)]
#![allow(dead_code)]

//! Shared apparatus for the Windows permission matrix.
//!
//! # The defect this shape exists to prevent
//!
//! A batch file is parsed by `cmd.exe` in the console **OEM code page**, while Rust's `fs::write`
//! encodes text as UTF-8. On a host whose `%TEMP%` sits under a non-ASCII user profile, an absolute
//! path embedded in a `.cmd` file is therefore mis-decoded, and every redirect to it fails with
//! `ERROR_PATH_NOT_FOUND` — which silently turns "the sandbox denied this write" into "the harness
//! wrote a path that does not exist". Two tests in `windows_workspace_write.rs` were failing for
//! exactly that reason, and a third test of the "this file must not exist" shape was passing
//! **vacuously** for the same reason.
//!
//! Two rules remove the problem completely:
//!
//! 1. The probe never embeds an absolute path in its text. It is invoked as `caelush-probe.cmd`
//!    relative to its own working directory (which the sandbox sets to the workspace), and it
//!    references nested invocations the same way.
//! 2. Every path it touches is received on the command line, which is UTF-16 end to end and
//!    therefore unaffected by the batch code page.
//!
//! # Why every reported cell is trustworthy
//!
//! Two independent guards run before any denial is believed:
//!
//! * The probe validates its own arguments and exits `PROBE_HARNESS_DEFECT` when either is missing,
//!   so "the payload never ran" can never be reported as "the sandbox denied the write".
//! * [`control_failures`] re-runs every row unrestricted, at every column path the matrix will use.
//!   If the probe cannot perform a row at a path when nothing restricts it, the matrix cannot
//!   attribute the sandbox's denial to the sandbox, and the harness says so instead of reporting a
//!   wall of denials.
//!
//! Every cell is additionally checked against **filesystem facts** after the command completes
//! (`verify_cell`), never against the exit code alone.
//!
//! ```text
//! 0   the operation succeeded against the target
//! 10  the operation failed against the target   -> the sandbox denied it
//! 30  the probe was not invoked correctly       -> harness defect, never a denial
//! ```

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

/// The restricted-token provider id both Windows modes are built with.
pub const PROVIDER: &str = "windows-acl-restricted-token";

/// The probe script's file name. Always invoked relative to the process working directory.
pub const PROBE_SCRIPT: &str = "caelush-probe.cmd";

const MARKER_NAME: &str = ".caelush-fixture-marker";

pub const PROBE_OK: i32 = 0;
pub const PROBE_TARGET_DENIED: i32 = 10;
pub const PROBE_HARNESS_DEFECT: i32 = 30;

/// Every matrix row, in report order.
pub const ROWS: [&str; 7] = [
    "read",
    "create",
    "append",
    "rename",
    "delete",
    "child",
    "grandchild",
];

/// The columns a `WORKSPACE_WRITE` matrix probes.
///
/// * `workspace` — the directory the Run is allowed to write.
/// * `parent` — the fixture root that contains the workspace: upward escape.
/// * `sibling` — a sibling of the workspace that was never granted.
/// * `private_temp` — this Run's private temp, granted to this Run's token.
/// * `ambient_temp` — a directory in the host temp root that no Run was ever granted.
/// * `second_run_temp` — a concurrent Run's private temp, granted only to that Run's token.
pub const WORKSPACE_WRITE_COLUMNS: [&str; 6] = [
    "workspace",
    "parent",
    "sibling",
    "private_temp",
    "ambient_temp",
    "second_run_temp",
];

/// The columns a `VIEW_ONLY` matrix probes.
///
/// The two per-Run temp columns are absent because the mode has no per-Run temp at all; see
/// [`read_only_column_exclusion`] for the recorded reason.
pub const READ_ONLY_COLUMNS: [&str; 4] = ["workspace", "parent", "sibling", "ambient_temp"];

/// The columns a `VIEW_ONLY` matrix deliberately does not probe. Never silently skipped.
pub const READ_ONLY_ABSENT_COLUMNS: [&str; 2] = ["private_temp", "second_run_temp"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatrixMode {
    ReadOnly,
    WorkspaceWrite,
}

impl MatrixMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
        }
    }

    pub fn columns(self) -> &'static [&'static str] {
        match self {
            Self::ReadOnly => &READ_ONLY_COLUMNS,
            Self::WorkspaceWrite => &WORKSPACE_WRITE_COLUMNS,
        }
    }
}

/// Why `VIEW_ONLY` has no such column. Returns `None` for a column the mode does probe.
pub fn read_only_column_exclusion(column: &str) -> Option<&'static str> {
    match column {
        "private_temp" => Some(
            "VIEW_ONLY is granted no temp capability, so no per-Run private temp exists to probe (spec §7.3).",
        ),
        "second_run_temp" => {
            Some("VIEW_ONLY has no per-Run private temp, so a concurrent Run's temp does not exist.")
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Filenames and contents the probe and the harness agree on.
// ---------------------------------------------------------------------------------------------

pub const READABLE: &str = "caelush-readable.txt";
pub const READABLE_CONTENT: &str = "caelush-readable\r\n";
pub const CREATED: &str = "caelush-created.txt";
pub const APPENDED: &str = "caelush-appended.txt";
pub const RENAME_SOURCE: &str = "caelush-rename-source.txt";
pub const RENAME_SOURCE_CONTENT: &str = "caelush-rename\r\n";
pub const RENAMED: &str = "caelush-renamed.txt";
pub const DELETE_TARGET: &str = "caelush-delete-target.txt";
pub const DELETE_TARGET_CONTENT: &str = "caelush-delete\r\n";
pub const CHILD: &str = "caelush-child.txt";
pub const GRANDCHILD: &str = "caelush-grandchild.txt";

/// What every write row leaves behind when it is permitted.
pub const PROBE_WRITE_CONTENT: &str = "caelush\r\n";

/// Files a preceding cell may have left behind; removed before every cell so each one starts clean.
pub const EFFECT_FILES: [&str; 5] = [CREATED, APPENDED, RENAMED, CHILD, GRANDCHILD];

// ---------------------------------------------------------------------------------------------
// Documented expectations.
// ---------------------------------------------------------------------------------------------

/// The documented outcome of one matrix cell.
///
/// Derived from the security specification, never from a previous run:
///
/// * §15.2 — `VIEW_ONLY` reads successfully and every test write operation fails.
/// * §15.3 — `WORKSPACE_WRITE` writes the workspace and its own private temp; every write outside
///   them fails.
/// * §4.9 — the backend constrains write *effects*; it does not claim to isolate reads, so reads
///   succeed everywhere and that is a documented partial boundary rather than a gap.
pub fn expected(mode: MatrixMode, row: &str, column: &str) -> i32 {
    assert!(ROWS.contains(&row), "unknown matrix row: {row}");
    assert!(
        mode.columns().contains(&column),
        "mode {} has no expectation for row {row} column {column}",
        mode.label()
    );
    if row == "read" {
        return PROBE_OK;
    }
    match mode {
        MatrixMode::ReadOnly => PROBE_TARGET_DENIED,
        MatrixMode::WorkspaceWrite => {
            if column == "workspace" || column == "private_temp" {
                PROBE_OK
            } else {
                PROBE_TARGET_DENIED
            }
        }
    }
}

/// Fails unless every applicable cell carries an encoded expectation.
///
/// The point is that adding a row or column without deciding its documented outcome cannot pass by
/// default: `expected` panics on an unencoded combination and this walks the whole space.
pub fn assert_matrix_is_fully_encoded() {
    for mode in [MatrixMode::ReadOnly, MatrixMode::WorkspaceWrite] {
        for row in ROWS {
            for column in mode.columns() {
                let outcome = expected(mode, row, column);
                assert!(
                    outcome == PROBE_OK || outcome == PROBE_TARGET_DENIED,
                    "cell {row}×{column} in mode {} has no encoded outcome",
                    mode.label()
                );
            }
        }
    }
    let mut omitted = READ_ONLY_ABSENT_COLUMNS;
    omitted.sort_unstable();
    let mut missing = WORKSPACE_WRITE_COLUMNS
        .iter()
        .copied()
        .filter(|column| !READ_ONLY_COLUMNS.contains(column))
        .collect::<Vec<_>>();
    missing.sort_unstable();
    assert_eq!(
        missing, omitted,
        "the columns VIEW_ONLY omits must be exactly the ones with a recorded reason"
    );
    for column in READ_ONLY_ABSENT_COLUMNS {
        assert!(
            read_only_column_exclusion(column).is_some(),
            "column {column} is omitted by VIEW_ONLY without a recorded reason"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Marker-owned fixtures.
// ---------------------------------------------------------------------------------------------

/// A marker-owned fixture root.
///
/// The root is created by this type, every path the matrix touches lives either under it or under
/// [`FixtureRoot::external_dir`], and `Drop` verifies each marker before removing the tree and then
/// asserts the removal itself — a leftover ACE that blocked deletion would fail here rather than
/// leaking silently into the next run.
pub struct FixtureRoot {
    path: PathBuf,
    marker: PathBuf,
    external: Vec<PathBuf>,
}

impl FixtureRoot {
    pub fn new(label: &str) -> Self {
        let path = env::temp_dir().join(format!(
            "caelush-phase7-{label}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        fs::create_dir_all(&path).expect("fixture root should be created");
        let marker = path.join(MARKER_NAME);
        write_marker(&marker, label);
        Self {
            path,
            marker,
            external: Vec::new(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A directory inside the fixture root.
    pub fn dir(&self, name: &str) -> PathBuf {
        let directory = self.path.join(name);
        fs::create_dir_all(&directory).expect("fixture directory should be created");
        directory
    }

    /// A directory created directly under the host temp root, outside the fixture root.
    ///
    /// This is the "ambient temp" surface: it carries whatever ACL and mandatory label the host
    /// temp root grants and nothing Caelush added. It is still marker-owned so cleanup stays
    /// asserted.
    pub fn external_dir(&mut self, name: &str) -> PathBuf {
        let directory = env::temp_dir().join(format!(
            "caelush-phase7-{name}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        fs::create_dir_all(&directory).expect("external fixture directory should be created");
        write_marker(&directory.join(MARKER_NAME), name);
        assert!(
            !directory.starts_with(&self.path),
            "an external fixture must live outside the fixture root"
        );
        self.external.push(directory.clone());
        directory
    }

    pub fn seed(&self, directory: &Path, name: &str, contents: &str) {
        fs::write(directory.join(name), contents).expect("fixture file should be written");
    }

    fn verify_marker(&self) {
        verify_marker_at(&self.marker, &self.path);
        for directory in &self.external {
            verify_marker_at(&directory.join(MARKER_NAME), directory);
        }
    }
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        self.verify_marker();
        remove_tree(&self.path);
        for directory in &self.external {
            remove_tree(directory);
        }
    }
}

fn write_marker(marker: &Path, label: &str) {
    fs::write(marker, format!("caelush-phase7:{label}\n")).expect("fixture marker should be written");
}

fn verify_marker_at(marker: &Path, directory: &Path) {
    let contents = fs::read_to_string(marker).expect("fixture marker should be readable");
    assert!(
        contents.starts_with("caelush-phase7:"),
        "fixture marker was replaced; refusing to touch {}",
        directory.display()
    );
}

// ---------------------------------------------------------------------------------------------
// The probe.
// ---------------------------------------------------------------------------------------------

/// Writes the probe into the workspace and returns its path.
///
/// The body contains no absolute path and no non-ASCII byte, so the batch code page cannot corrupt
/// it on any host. Nested invocations rely on the working directory, which every mode sets to the
/// workspace.
pub fn write_probe_script(workspace: &Path) -> PathBuf {
    let probe = workspace.join(PROBE_SCRIPT);
    fs::write(&probe, PROBE_BODY).expect("probe script should be written");
    probe
}

const PROBE_BODY: &str = concat!(
    "@echo off\r\n",
    "setlocal enableextensions\r\n",
    "set \"OP=%~1\"\r\n",
    "set \"TARGET=%~2\"\r\n",
    "if \"%OP%\"==\"\" exit /b 30\r\n",
    "if \"%TARGET%\"==\"\" exit /b 30\r\n",
    "if \"%OP%\"==\"read\" goto :op_read\r\n",
    "if \"%OP%\"==\"create\" goto :op_create\r\n",
    "if \"%OP%\"==\"append\" goto :op_append\r\n",
    "if \"%OP%\"==\"rename\" goto :op_rename\r\n",
    "if \"%OP%\"==\"delete\" goto :op_delete\r\n",
    "if \"%OP%\"==\"child\" goto :op_child\r\n",
    "if \"%OP%\"==\"grandchild\" goto :op_grandchild\r\n",
    "if \"%OP%\"==\"hold\" goto :op_hold\r\n",
    "exit /b 30\r\n",
    "\r\n",
    ":op_read\r\n",
    "type \"%TARGET%\\caelush-readable.txt\" >nul 2>nul\r\n",
    "if errorlevel 1 exit /b 10\r\n",
    "exit /b 0\r\n",
    "\r\n",
    ":op_create\r\n",
    "set \"NAME=%~3\"\r\n",
    "if \"%NAME%\"==\"\" set \"NAME=caelush-created.txt\"\r\n",
    "2>nul > \"%TARGET%\\%NAME%\" echo caelush\r\n",
    "if not exist \"%TARGET%\\%NAME%\" exit /b 10\r\n",
    "exit /b 0\r\n",
    "\r\n",
    ":op_append\r\n",
    "set \"NAME=%~3\"\r\n",
    "if \"%NAME%\"==\"\" set \"NAME=caelush-appended.txt\"\r\n",
    "2>nul >> \"%TARGET%\\%NAME%\" echo caelush\r\n",
    "if not exist \"%TARGET%\\%NAME%\" exit /b 10\r\n",
    "exit /b 0\r\n",
    "\r\n",
    ":op_rename\r\n",
    "2>nul >nul move /y \"%TARGET%\\caelush-rename-source.txt\" \"%TARGET%\\caelush-renamed.txt\"\r\n",
    "if not exist \"%TARGET%\\caelush-renamed.txt\" exit /b 10\r\n",
    "if exist \"%TARGET%\\caelush-rename-source.txt\" exit /b 10\r\n",
    "exit /b 0\r\n",
    "\r\n",
    ":op_delete\r\n",
    "2>nul >nul del /q \"%TARGET%\\caelush-delete-target.txt\"\r\n",
    "if exist \"%TARGET%\\caelush-delete-target.txt\" exit /b 10\r\n",
    "exit /b 0\r\n",
    "\r\n",
    ":op_child\r\n",
    "set \"NAME=%~3\"\r\n",
    "if \"%NAME%\"==\"\" set \"NAME=caelush-child.txt\"\r\n",
    "2>nul >nul cmd /d /s /c caelush-probe.cmd create \"%TARGET%\" \"%NAME%\"\r\n",
    "if not exist \"%TARGET%\\%NAME%\" exit /b 10\r\n",
    "exit /b 0\r\n",
    "\r\n",
    ":op_grandchild\r\n",
    "set \"NAME=%~3\"\r\n",
    "if \"%NAME%\"==\"\" set \"NAME=caelush-grandchild.txt\"\r\n",
    "2>nul >nul cmd /d /s /c caelush-probe.cmd child \"%TARGET%\" \"%NAME%\"\r\n",
    "if not exist \"%TARGET%\\%NAME%\" exit /b 10\r\n",
    "exit /b 0\r\n",
    "\r\n",
    ":op_hold\r\n",
    "2>nul >nul ping 127.0.0.1 -n 6 -w 1000\r\n",
    "exit /b 0\r\n",
);

/// The argument vector for one cell: `cmd /d /s /c caelush-probe.cmd <row> <target>`.
///
/// The target travels on the command line, so it is UTF-16 end to end and unaffected by the batch
/// code page even when it contains non-ASCII characters.
pub fn probe_arguments(row: &str, target: &Path) -> Vec<String> {
    vec![
        "/d".to_string(),
        "/s".to_string(),
        "/c".to_string(),
        PROBE_SCRIPT.to_string(),
        row.to_string(),
        target.to_string_lossy().into_owned(),
    ]
}

pub fn command_interpreter() -> String {
    env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
}

/// Runs one row's payload with no sandbox at all.
///
/// This is the harness's own validity check: it must always succeed.
pub fn run_probe_unrestricted(working_directory: &Path, row: &str, target: &Path) -> i32 {
    let status = Command::new(command_interpreter())
        .args(probe_arguments(row, target))
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("unrestricted control probe should start");
    status.code().unwrap_or(-1)
}

// ---------------------------------------------------------------------------------------------
// Seeding, measuring and checking cells.
// ---------------------------------------------------------------------------------------------

/// Makes a column directory look untouched, so every cell starts from the same state and the whole
/// matrix can be re-run without leaving residue behind.
pub fn reset_cell(directory: &Path) {
    for name in EFFECT_FILES {
        let _ = fs::remove_file(directory.join(name));
    }
    seed(directory, READABLE, READABLE_CONTENT);
    seed(directory, RENAME_SOURCE, RENAME_SOURCE_CONTENT);
    seed(directory, DELETE_TARGET, DELETE_TARGET_CONTENT);
}

fn seed(directory: &Path, name: &str, contents: &str) {
    fs::write(directory.join(name), contents).expect("cell fixture should be written");
}

/// Checks the filesystem facts a cell must have produced.
pub fn verify_cell(row: &str, directory: &Path, allowed: bool) -> Vec<String> {
    let mut problems = Vec::new();
    match row {
        // A read never mutates the target: the seeded fixture must survive either way, and the
        // probe's exit code is what reports whether the read itself was permitted.
        "read" => expect_file(directory, READABLE, Some(READABLE_CONTENT), &mut problems),
        "create" => expect_file(
            directory,
            CREATED,
            allowed.then_some(PROBE_WRITE_CONTENT),
            &mut problems,
        ),
        "append" => expect_file(
            directory,
            APPENDED,
            allowed.then_some(PROBE_WRITE_CONTENT),
            &mut problems,
        ),
        "child" => expect_file(
            directory,
            CHILD,
            allowed.then_some(PROBE_WRITE_CONTENT),
            &mut problems,
        ),
        "grandchild" => expect_file(
            directory,
            GRANDCHILD,
            allowed.then_some(PROBE_WRITE_CONTENT),
            &mut problems,
        ),
        "rename" => {
            expect_file(
                directory,
                RENAMED,
                allowed.then_some(RENAME_SOURCE_CONTENT),
                &mut problems,
            );
            expect_file(
                directory,
                RENAME_SOURCE,
                (!allowed).then_some(RENAME_SOURCE_CONTENT),
                &mut problems,
            );
        }
        "delete" => expect_file(
            directory,
            DELETE_TARGET,
            (!allowed).then_some(DELETE_TARGET_CONTENT),
            &mut problems,
        ),
        other => problems.push(format!("row {other} has no filesystem expectation")),
    }
    problems
}

fn expect_file(directory: &Path, name: &str, expected: Option<&str>, problems: &mut Vec<String>) {
    let path = directory.join(name);
    match expected {
        Some(contents) => match fs::read_to_string(&path) {
            Err(error) => problems.push(format!(
                "{} should carry the operation's effect but could not be read: {error}",
                path.display()
            )),
            Ok(actual) if actual == contents => {}
            Ok(actual) => problems.push(format!(
                "{} should contain {contents:?} but contains {actual:?}",
                path.display()
            )),
        },
        None => {
            if path.exists() {
                problems.push(format!(
                    "{} must not exist after a denied operation",
                    path.display()
                ));
            }
        }
    }
}

/// Re-runs every row with no sandbox at every column path, and reports anything that does not work.
///
/// A non-empty result means the matrix is not trustworthy: the probe or the fixture path is broken,
/// so no denial measured by this harness may be attributed to the sandbox.
pub fn control_failures(
    script_directory: &Path,
    columns: &[(&'static str, PathBuf)],
) -> Vec<String> {
    let mut problems = Vec::new();
    for (column, directory) in columns {
        for row in ROWS {
            reset_cell(directory);
            let exit_code = run_probe_unrestricted(script_directory, row, directory);
            if exit_code != PROBE_OK {
                problems.push(format!(
                    "control {row}×{column}: the unrestricted probe exited {exit_code}; the probe \
                     cannot perform this row at this path, so no denial here can be attributed to \
                     the sandbox"
                ));
            }
            for problem in verify_cell(row, directory, true) {
                problems.push(format!("control {row}×{column}: {problem}"));
            }
        }
    }
    problems
}

/// One measured matrix cell.
#[derive(Clone, Debug)]
pub struct MatrixCell {
    pub row: &'static str,
    pub column: &'static str,
    pub exit_code: i32,
    pub expected: i32,
    pub problems: Vec<String>,
}

impl MatrixCell {
    pub fn matches(&self) -> bool {
        self.exit_code == self.expected && self.problems.is_empty()
    }
}

/// Measures every row against one column, resetting the column before each cell.
///
/// `spawn` is the mode-specific seam: it launches the probe under the mode's restricted token and
/// returns the payload's exit code.
pub fn observe_column<F>(
    mode: MatrixMode,
    column: &'static str,
    directory: &Path,
    spawn: F,
) -> Vec<MatrixCell>
where
    F: Fn(&'static str, &Path) -> i32,
{
    ROWS.iter()
        .map(|row| {
            reset_cell(directory);
            let exit_code = spawn(row, directory);
            let expected = expected(mode, row, column);
            let problems = verify_cell(row, directory, expected == PROBE_OK);
            MatrixCell {
                row,
                column,
                exit_code,
                expected,
                problems,
            }
        })
        .collect()
}

/// Renders the measured matrix so a failing run prints the whole table, not just the first error.
pub fn render(mode: MatrixMode, cells: &[MatrixCell]) -> String {
    let mut output = format!("windows permission matrix :: mode={}\n", mode.label());
    output.push_str(&format!("{:<12}", "row"));
    for column in mode.columns() {
        output.push_str(&format!("{column:>17}"));
    }
    output.push('\n');
    for row in ROWS {
        output.push_str(&format!("{row:<12}"));
        for column in mode.columns() {
            let cell = cells
                .iter()
                .find(|cell| cell.row == row && cell.column == *column)
                .expect("every row and column of the mode is measured");
            let verdict = if cell.matches() { "ok" } else { "FAIL" };
            output.push_str(&format!("{:>17}", format!("{} {verdict}", cell.exit_code)));
        }
        output.push('\n');
    }
    output
}

/// Every reason a measured matrix is not the documented matrix.
pub fn failures(cells: &[MatrixCell]) -> Vec<String> {
    let mut failures = Vec::new();
    for cell in cells {
        if cell.exit_code == PROBE_HARNESS_DEFECT {
            failures.push(format!(
                "{}×{}: the probe exited {PROBE_HARNESS_DEFECT}, so it was not invoked correctly \
                 and this cell proves nothing",
                cell.row, cell.column
            ));
            continue;
        }
        if cell.exit_code != cell.expected {
            failures.push(format!(
                "{}×{}: the probe exited {} but the documented outcome is {}",
                cell.row, cell.column, cell.exit_code, cell.expected
            ));
        }
        for problem in &cell.problems {
            failures.push(format!("{}×{}: {problem}", cell.row, cell.column));
        }
    }
    failures
}

pub fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should follow the epoch")
        .as_nanos()
}

fn remove_tree(path: &Path) {
    if path.exists() {
        fs::remove_dir_all(path).expect("marker-owned fixture root should be removable");
    }
}
