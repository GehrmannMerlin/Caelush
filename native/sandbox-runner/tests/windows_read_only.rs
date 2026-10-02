#![cfg(windows)]

mod support;

use caelush_sandbox_runner::platform::windows::{
    spawn_restricted, workspace_status, GrantStatus,
};
use caelush_sandbox_runner::platform::windows_mode::WindowsSandboxMode;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use support::{
    assert_matrix_is_fully_encoded, command_interpreter, control_failures, failures, observe_column,
    probe_arguments, render, write_probe_script, FixtureRoot, MatrixMode, PROVIDER,
    READ_ONLY_COLUMNS, ROWS,
};

/// The whole `VIEW_ONLY` matrix, measured on real Windows security primitives.
///
/// The documented boundary this encodes is `VIEW_ONLY` reads successfully and every test write
/// operation fails, at every path. `private_temp` and `second_run_temp` are absent because the mode
/// is granted no per-Run temp at all; `support::read_only_column_exclusion` records that reason so
/// the omission cannot silently become a skip.
#[test]
fn read_only_permission_matrix_matches_the_documented_boundary() {
    assert_matrix_is_fully_encoded();

    let mut root = FixtureRoot::new("read-only-matrix");
    let workspace = root.dir("workspace");
    let sibling = root.dir("sibling");
    let ambient = root.external_dir("ambient-read-only");
    let parent = root.path().to_path_buf();

    let columns: Vec<(&'static str, PathBuf)> = vec![
        ("workspace", workspace.clone()),
        ("parent", parent),
        ("sibling", sibling),
        ("ambient_temp", ambient),
    ];
    assert_eq!(
        columns
            .iter()
            .map(|(column, _)| *column)
            .collect::<Vec<_>>(),
        READ_ONLY_COLUMNS.to_vec(),
        "the measured columns must be exactly the ones the mode has"
    );

    write_probe_script(&workspace);

    // A matrix is worthless if the payload cannot perform its rows when nothing restricts it.
    // This runs first, so a broken probe or a mis-encoded fixture path is reported as a harness
    // defect instead of being dressed up as a wall of sandbox denials.
    let control = control_failures(&workspace, &columns);
    assert!(
        control.is_empty(),
        "harness control failed, so no denial below can be attributed to the sandbox:\n{}",
        control.join("\n")
    );
    println!(
        "harness control: {} rows x {} columns ran unrestricted and succeeded, so every denial in \
         the matrix below is attributable to the restricted token",
        ROWS.len(),
        columns.len()
    );

    assert_eq!(
        workspace_status(&workspace).expect("workspace status should be readable"),
        GrantStatus::Missing,
        "VIEW_ONLY must start from a workspace that was never prepared"
    );

    let program = command_interpreter();
    let mut cells = Vec::new();
    for (column, directory) in columns.iter() {
        let column = *column;
        let spawn = |row: &'static str, target: &Path| -> i32 {
            let mut child = spawn_restricted(
                PROVIDER,
                WindowsSandboxMode::ReadOnly,
                &workspace,
                &workspace,
                &program,
                &probe_arguments(row, target),
            )
            .expect("read-only probe should start");
            child.wait().expect("read-only probe should complete") as i32
        };
        cells.extend(observe_column(MatrixMode::ReadOnly, column, directory, spawn));
    }

    println!("{}", render(MatrixMode::ReadOnly, &cells));
    let mismatches = failures(&cells);
    assert!(
        mismatches.is_empty(),
        "read-only matrix does not match the documented boundary:\n{}",
        mismatches.join("\n")
    );

    assert_eq!(
        workspace_status(&workspace).expect("workspace status should be readable"),
        GrantStatus::Missing,
        "running the whole read-only matrix must not leave a capability ACE behind"
    );
    for (column, directory) in &columns {
        assert!(
            directory.exists(),
            "column {column} vanished during the matrix"
        );
    }
}

#[test]
fn real_read_only_child_reads_but_cannot_mutate_workspace_files() {
    let workspace = TemporaryWorkspace::new("read-only-e2e");
    let readable = workspace.path.join("readable.txt");
    let delete_target = workspace.path.join("delete-target.txt");
    let rename_source = workspace.path.join("rename-source.txt");
    let script = workspace.path.join("probe.cmd");

    fs::write(&readable, "caelush-read-only-probe\r\n").expect("read fixture should be written");
    fs::write(&delete_target, "must-remain\r\n").expect("delete fixture should be written");
    fs::write(&rename_source, "must-not-move\r\n").expect("rename fixture should be written");
    fs::write(
        &script,
        concat!(
            "@echo off\r\n",
            "type \"readable.txt\" >nul 2>nul || exit /b 20\r\n",
            "2>nul >\"created.txt\" echo unexpected\r\n",
            "2>nul >>\"readable.txt\" echo unexpected\r\n",
            "del /q \"delete-target.txt\" >nul 2>nul\r\n",
            "ren \"rename-source.txt\" \"renamed.txt\" >nul 2>nul\r\n",
            "exit /b 0\r\n",
        ),
    )
    .expect("probe script should be written");

    let program = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut child = spawn_restricted(
        "windows-acl-restricted-token",
        WindowsSandboxMode::ReadOnly,
        &workspace.path,
        &workspace.path,
        &program,
        &[
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            "probe.cmd".to_string(),
        ],
    )
    .expect("restricted read-only child should start");

    assert_eq!(child.wait(), Ok(0), "read operation should succeed");
    assert_eq!(
        fs::read_to_string(&readable).expect("read fixture should remain"),
        "caelush-read-only-probe\r\n"
    );
    assert_eq!(
        fs::read_to_string(&delete_target).expect("delete target should remain"),
        "must-remain\r\n"
    );
    assert_eq!(
        fs::read_to_string(&rename_source).expect("rename source should remain"),
        "must-not-move\r\n"
    );
    assert!(!workspace.path.join("created.txt").exists());
    assert!(!workspace.path.join("renamed.txt").exists());
}

#[test]
fn unavailable_workspace_write_mode_never_starts_the_payload() {
    let workspace = TemporaryWorkspace::new("workspace-write-sentinel");
    let sentinel = workspace.path.join("payload-started.txt");
    let program = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let command = format!("type nul > \"{}\"", sentinel.display());

    let result = spawn_restricted(
        "windows-acl-restricted-token",
        WindowsSandboxMode::WorkspaceWrite,
        &workspace.path,
        &workspace.path,
        &program,
        &[
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            command,
        ],
    );

    assert_eq!(
        result.err().as_deref(),
        Some("WINDOWS_SANDBOX_MODE_UNAVAILABLE")
    );
    assert!(
        !sentinel.exists(),
        "fail-closed mode must not start payload"
    );
}

struct TemporaryWorkspace {
    path: PathBuf,
}

impl TemporaryWorkspace {
    fn new(label: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should follow the epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "caelush-sandbox-runner-{label}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("temporary workspace should be created");
        Self { path }
    }
}

impl Drop for TemporaryWorkspace {
    fn drop(&mut self) {
        remove_tree(&self.path);
    }
}

fn remove_tree(path: &Path) {
    if path.exists() {
        fs::remove_dir_all(path).expect("temporary workspace should be removable by parent");
    }
}
