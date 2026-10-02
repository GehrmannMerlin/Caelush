#![cfg(windows)]

mod support;

use caelush_sandbox_runner::platform::windows::{
    spawn_restricted, spawn_workspace_write_restricted, workspace_prepare, workspace_status,
    GrantChange, GrantStatus,
};
use caelush_sandbox_runner::platform::windows_mode::WindowsSandboxMode;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use support::{
    assert_matrix_is_fully_encoded, command_interpreter, control_failures, failures, observe_column,
    probe_arguments, render, write_probe_script, FixtureRoot, MatrixMode, PROVIDER, ROWS,
    WORKSPACE_WRITE_COLUMNS,
};

/// The whole `WORKSPACE_WRITE` matrix, measured on real Windows security primitives.
///
/// The documented boundary this encodes is: the Run writes its workspace and the private temp it
/// was granted, and every other path fails — including a concurrent Run's private temp, which is
/// probed while that Run is genuinely alive so the grant under test really exists.
#[test]
fn workspace_write_permission_matrix_matches_the_documented_boundary() {
    assert_matrix_is_fully_encoded();

    let mut root = FixtureRoot::new("workspace-write-matrix");
    let workspace = root.dir("workspace");
    let sibling = root.dir("sibling");
    let parent = root.path().to_path_buf();
    let private_temp = root.dir("private-temp-one");
    let second_run_temp = root.dir("private-temp-two");
    let ambient = root.external_dir("ambient-workspace-write");

    let columns: Vec<(&'static str, PathBuf)> = vec![
        ("workspace", workspace.clone()),
        ("parent", parent),
        ("sibling", sibling),
        ("private_temp", private_temp.clone()),
        ("ambient_temp", ambient),
        ("second_run_temp", second_run_temp.clone()),
    ];
    assert_eq!(
        columns
            .iter()
            .map(|(column, _)| *column)
            .collect::<Vec<_>>(),
        WORKSPACE_WRITE_COLUMNS.to_vec(),
        "the measured columns must be exactly the ones the mode has"
    );

    write_probe_script(&workspace);

    // Runs before anything is granted: a broken probe or a mis-encoded fixture path must surface
    // as a harness defect rather than as sandbox denials.
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
        "the matrix must start from an unprepared workspace"
    );
    assert_eq!(
        workspace_prepare(&workspace).expect("workspace should be prepared"),
        GrantChange::Added
    );
    assert_eq!(
        workspace_status(&workspace).expect("workspace status should be readable"),
        GrantStatus::Ready,
        "preparation must leave exactly the workspace capability ACE the Run relies on"
    );

    let program = command_interpreter();
    let mut cells = Vec::new();
    for (column, directory) in columns.iter() {
        let column = *column;
        // A concurrent Run is only useful evidence while it is alive: its temp grant is revoked
        // when the Run settles, so the holder is started immediately before the column that
        // targets it and joined immediately after.
        let holder = if column == "second_run_temp" {
            Some(
                spawn_workspace_write_restricted(
                    PROVIDER,
                    &workspace,
                    &workspace,
                    &second_run_temp,
                    "phase7-run-two",
                    &program,
                    &probe_arguments("hold", &workspace),
                )
                .expect("the concurrent Run should start and hold its private temp grant"),
            )
        } else {
            None
        };
        let spawn = |row: &'static str, target: &Path| -> i32 {
            let mut child = spawn_workspace_write_restricted(
                PROVIDER,
                &workspace,
                &workspace,
                &private_temp,
                "phase7-run-one",
                &program,
                &probe_arguments(row, target),
            )
            .expect("workspace-write probe should start");
            child.wait().expect("workspace-write probe should complete") as i32
        };
        cells.extend(observe_column(
            MatrixMode::WorkspaceWrite,
            column,
            directory,
            spawn,
        ));
        if let Some(mut holder) = holder {
            assert_eq!(
                holder.wait(),
                Ok(0),
                "the concurrent Run should hold and then settle cleanly"
            );
        }
    }

    println!("{}", render(MatrixMode::WorkspaceWrite, &cells));
    let mismatches = failures(&cells);
    assert!(
        mismatches.is_empty(),
        "workspace-write matrix does not match the documented boundary:\n{}",
        mismatches.join("\n")
    );

    assert_eq!(
        workspace_status(&workspace).expect("workspace status should be readable"),
        GrantStatus::Ready,
        "the standing capability ACE must survive the whole matrix so later Runs stay prepared"
    );
}

/// Workspace-internal paths are addressed with `%~dp0`; paths outside the workspace arrive as
/// **argv**.
///
/// This is a correctness requirement of the fixture, not a style choice. The workspace lives under
/// `%TEMP%`, whose path contains the non-ASCII user-profile directory. `cmd.exe` parses a batch file
/// in the console OEM code page while Rust writes it as UTF-8, so an absolute path embedded in the
/// script text is mis-decoded and every redirect to it fails as a non-existent path. The command
/// line, by contrast, is UTF-16 end to end, so it is unaffected.
#[test]
fn workspace_write_allows_workspace_and_own_temp_but_denies_external_targets() {
    let root = TemporaryRoot::new("workspace-write-matrix");
    let workspace = root.path.join("workspace");
    let sibling = root.path.join("sibling");
    let private_temp = root.path.join("private-temp-one");
    let other_temp = root.path.join("private-temp-two");
    fs::create_dir(&workspace).expect("workspace should be created");
    fs::create_dir(&sibling).expect("sibling should be created");
    fs::create_dir(&private_temp).expect("private temp should be created");
    fs::create_dir(&other_temp).expect("other temp should be created");
    let temp_delete_target = private_temp.join("temp-delete-target.txt");
    fs::write(&temp_delete_target, "delete-me\r\n")
        .expect("private temp delete fixture should be written");

    let delete_target = workspace.join("delete-target.txt");
    let rename_source = workspace.join("rename-source.txt");
    fs::write(&delete_target, "delete-me\r\n").expect("delete fixture should be written");
    fs::write(&rename_source, "rename-me\r\n").expect("rename fixture should be written");

    assert_eq!(
        workspace_status(&workspace).expect("workspace status should be readable"),
        GrantStatus::Missing
    );
    assert_eq!(
        workspace_prepare(&workspace).expect("workspace should be prepared"),
        GrantChange::Added
    );

    let parent_target = root.path.join("parent-denied.txt");
    let sibling_target = sibling.join("sibling-denied.txt");
    let user_temp_target = env::temp_dir().join(format!(
        "caelush-user-temp-denied-{}-{}.txt",
        std::process::id(),
        unique_suffix()
    ));
    let other_temp_target = other_temp.join("foreign-temp-denied.txt");
    let script = workspace.join("workspace-write-matrix.cmd");
    fs::write(
        &script,
        concat!(
            "@echo off\r\n",
            "rem %1 parent-denied.txt  %2 sibling-denied.txt\r\n",
            "rem %3 user-temp-denied.txt  %4 foreign-temp-denied.txt\r\n",
            "> \"%~dp0created.txt\" echo workspace-created\r\n",
            ">> \"%~dp0created.txt\" echo workspace-appended\r\n",
            "move /y \"%~dp0rename-source.txt\" \"%~dp0renamed.txt\" >nul 2>nul\r\n",
            "del /q \"%~dp0delete-target.txt\" >nul 2>nul\r\n",
            "> \"%TEMP%\\temp-created.txt\" echo temp-created\r\n",
            ">> \"%TEMP%\\temp-created.txt\" echo temp-appended\r\n",
            "move /y \"%TEMP%\\temp-created.txt\" \"%TEMP%\\temp-renamed.txt\" >nul 2>nul\r\n",
            "del /q \"%TEMP%\\temp-delete-target.txt\" >nul 2>nul\r\n",
            "type \"%TEMP%\\temp-renamed.txt\" > \"%~dp0temp-observed.txt\"\r\n",
            "> \"%~1\" echo parent-denied\r\n",
            "> \"%~2\" echo sibling-denied\r\n",
            "> \"%~3\" echo user-temp-denied\r\n",
            "> \"%~4\" echo foreign-temp-denied\r\n",
            "exit /b 0\r\n",
        ),
    )
    .expect("workspace-write script should be written");

    let program = env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut child = spawn_workspace_write_restricted(
        "windows-acl-restricted-token",
        &workspace,
        &workspace,
        &private_temp,
        "workspace-write-matrix-temp-one",
        &program,
        &[
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            script.file_name().unwrap().to_string_lossy().into_owned(),
            parent_target.to_string_lossy().into_owned(),
            sibling_target.to_string_lossy().into_owned(),
            user_temp_target.to_string_lossy().into_owned(),
            other_temp_target.to_string_lossy().into_owned(),
        ],
    )
    .expect("workspace-write child should start after preparation");
    assert_eq!(child.wait(), Ok(0), "workspace-write child should complete");

    assert_eq!(
        fs::read_to_string(workspace.join("created.txt")).expect("workspace file should exist"),
        "workspace-created\r\nworkspace-appended\r\n"
    );
    assert!(workspace.join("renamed.txt").exists());
    assert!(!rename_source.exists());
    assert!(!delete_target.exists());
    assert_eq!(
        fs::read_to_string(workspace.join("temp-observed.txt"))
            .expect("workspace should observe its own temp write"),
        "temp-created\r\ntemp-appended\r\n"
    );
    assert!(private_temp.join("temp-renamed.txt").exists());
    assert_eq!(
        fs::read_to_string(private_temp.join("temp-renamed.txt"))
            .expect("renamed private temp file should exist"),
        "temp-created\r\ntemp-appended\r\n"
    );
    assert!(!temp_delete_target.exists());
    assert!(!parent_target.exists());
    assert!(!sibling_target.exists());
    assert!(!user_temp_target.exists());
    assert!(!other_temp_target.exists());
}

/// A prepared workspace does not hand its capability SID to a read-only Run, so the standing ACE
/// stays inert.
///
/// The probe reports its own result through the exit code instead of only asserting that files are
/// absent, so a payload that could not run at all — the failure mode a mis-decoded fixture produced
/// before — can no longer satisfy the test vacuously: not reading its own fixture is exit 20, and a
/// mutation that succeeded is exit 10 or 11.
#[test]
fn prepared_workspace_grant_is_inert_for_read_only_children() {
    let root = TemporaryRoot::new("workspace-write-downgrade");
    let workspace = root.path.join("workspace");
    fs::create_dir(&workspace).expect("workspace should be created");
    fs::write(workspace.join("existing.txt"), "must-remain\r\n")
        .expect("read-only fixture should be written");
    assert_eq!(
        workspace_prepare(&workspace).expect("workspace should be prepared"),
        GrantChange::Added
    );
    let script = workspace.join("read-only-after-prepare.cmd");
    let created = workspace.join("created.txt");
    fs::write(
        &script,
        concat!(
            "@echo off\r\n",
            "type \"%~dp0existing.txt\" >nul 2>nul\r\n",
            "if errorlevel 1 exit /b 20\r\n",
            "2>nul > \"%~dp0created.txt\" echo unexpected\r\n",
            "if exist \"%~dp0created.txt\" exit /b 10\r\n",
            "2>nul >> \"%~dp0existing.txt\" echo unexpected\r\n",
            "del /q \"%~dp0existing.txt\" >nul 2>nul\r\n",
            "if not exist \"%~dp0existing.txt\" exit /b 11\r\n",
            "exit /b 0\r\n",
        ),
    )
    .expect("read-only script should be written");
    assert!(
        workspace.join("existing.txt").exists(),
        "fixture should exist before spawn"
    );

    let program = env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut child = spawn_restricted(
        "windows-acl-restricted-token",
        WindowsSandboxMode::ReadOnly,
        &workspace,
        &workspace,
        &program,
        &[
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            script.file_name().unwrap().to_string_lossy().into_owned(),
        ],
    )
    .expect("read-only child should start");
    assert_eq!(
        child.wait(),
        Ok(0),
        "the read-only child must read its fixture (20 = the payload could not read it at all) and \
         must fail every mutation (10 = create succeeded, 11 = delete succeeded)"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("existing.txt")).expect("existing file should remain"),
        "must-remain\r\n"
    );
    assert!(!created.exists());
    assert_eq!(
        workspace_status(&workspace).expect("workspace status should be readable"),
        GrantStatus::Ready,
        "the standing ACE must be untouched by the read-only Run"
    );
}

#[test]
fn prepared_workspace_preserves_ordinary_host_user_file_operations() {
    let root = TemporaryRoot::new("workspace-write-host-user");
    let workspace = root.path.join("workspace");
    fs::create_dir(&workspace).expect("workspace should be created");
    workspace_prepare(&workspace).expect("workspace should be prepared");

    let created = workspace.join("host-created.txt");
    let renamed = workspace.join("host-renamed.txt");
    fs::write(&created, "host-created\r\n").expect("host user should create files");
    fs::OpenOptions::new()
        .append(true)
        .open(&created)
        .expect("host user should open files for append")
        .write_all(b"host-appended\r\n")
        .expect("host user should append files");
    fs::rename(&created, &renamed).expect("host user should rename files");
    fs::remove_file(&renamed).expect("host user should delete files");
}

#[test]
fn concurrent_workspace_prepare_calls_are_idempotent() {
    let root = TemporaryRoot::new("workspace-write-concurrent-prepare");
    let workspace = root.path.join("workspace");
    fs::create_dir(&workspace).expect("workspace should be created");

    let outcomes = thread::scope(|scope| {
        let handles = (0..8)
            .map(|_| scope.spawn(|| workspace_prepare(&workspace)))
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("prepare thread should not panic"))
            .collect::<Vec<_>>()
    });
    assert!(outcomes.iter().all(Result::is_ok));
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Ok(GrantChange::Added)))
            .count(),
        1
    );
    assert!(outcomes
        .iter()
        .any(|result| matches!(result, Ok(GrantChange::Unchanged))));
    assert_eq!(
        workspace_status(&workspace).expect("workspace status should be readable"),
        GrantStatus::Ready
    );
}

/// Targets outside the workspace are passed as **argv** for the same reason as above: the private
/// temp paths live under the non-ASCII `%TEMP%` and must never be embedded in the script text.
#[test]
fn concurrent_runs_cannot_write_each_others_private_temp() {
    let root = TemporaryRoot::new("workspace-write-concurrent-runs");
    let workspace = root.path.join("workspace");
    let first_temp = root.path.join("private-temp-one");
    let second_temp = root.path.join("private-temp-two");
    fs::create_dir(&workspace).expect("workspace should be created");
    fs::create_dir(&first_temp).expect("first temp should be created");
    fs::create_dir(&second_temp).expect("second temp should be created");
    workspace_prepare(&workspace).expect("workspace should be prepared");

    let first_script = workspace.join("first-run.cmd");
    let second_script = workspace.join("second-run.cmd");
    let first_own = first_temp.join("own.txt");
    let first_foreign = second_temp.join("foreign.txt");
    let second_own = second_temp.join("own.txt");
    let second_foreign = first_temp.join("foreign.txt");
    fs::write(
        &first_script,
        concat!(
            "@echo off\r\n",
            "rem %1 own.txt  %2 the other Run's foreign.txt\r\n",
            "> \"%~1\" echo first\r\n",
            "> \"%~2\" echo foreign\r\n",
            "exit /b 0\r\n",
        ),
    )
    .expect("first script should be written");
    fs::write(
        &second_script,
        concat!(
            "@echo off\r\n",
            "rem %1 own.txt  %2 the other Run's foreign.txt\r\n",
            "> \"%~1\" echo second\r\n",
            "> \"%~2\" echo foreign\r\n",
            "exit /b 0\r\n",
        ),
    )
    .expect("second script should be written");

    let program = env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut first = spawn_workspace_write_restricted(
        "windows-acl-restricted-token",
        &workspace,
        &workspace,
        &first_temp,
        "concurrent-run-temp-one",
        &program,
        &[
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            first_script
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            first_own.to_string_lossy().into_owned(),
            first_foreign.to_string_lossy().into_owned(),
        ],
    )
    .expect("first workspace-write child should start");
    let mut second = spawn_workspace_write_restricted(
        "windows-acl-restricted-token",
        &workspace,
        &workspace,
        &second_temp,
        "concurrent-run-temp-two",
        &program,
        &[
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            second_script
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            second_own.to_string_lossy().into_owned(),
            second_foreign.to_string_lossy().into_owned(),
        ],
    )
    .expect("second workspace-write child should start");

    assert_eq!(first.wait(), Ok(0));
    assert_eq!(second.wait(), Ok(0));
    // Each Run's own write succeeding is the positive control that makes the foreign denial
    // meaningful: the same redirect, in the same process, works one path over.
    assert_eq!(fs::read_to_string(first_own).unwrap(), "first\r\n");
    assert_eq!(fs::read_to_string(second_own).unwrap(), "second\r\n");
    assert!(!first_foreign.exists());
    assert!(!second_foreign.exists());
}

struct TemporaryRoot {
    path: PathBuf,
}

impl TemporaryRoot {
    fn new(label: &str) -> Self {
        let path = env::temp_dir().join(format!(
            "caelush-sandbox-runner-{label}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        fs::create_dir(&path).expect("temporary root should be created");
        Self { path }
    }
}

impl Drop for TemporaryRoot {
    fn drop(&mut self) {
        if self.path.exists() {
            remove_tree(&self.path);
        }
    }
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should follow the epoch")
        .as_nanos()
}

fn remove_tree(path: &Path) {
    fs::remove_dir_all(path).expect("temporary root should be removable");
}
