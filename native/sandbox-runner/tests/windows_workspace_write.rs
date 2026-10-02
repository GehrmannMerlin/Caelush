#![cfg(windows)]

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
        format!(
            concat!(
                "@echo off\r\n",
                "> \"{}\" echo workspace-created\r\n",
                ">> \"{}\" echo workspace-appended\r\n",
                "move /y \"{}\" \"{}\" >nul 2>nul\r\n",
                "del /q \"{}\" >nul 2>nul\r\n",
                "> \"%TEMP%\\temp-created.txt\" echo temp-created\r\n",
                ">> \"%TEMP%\\temp-created.txt\" echo temp-appended\r\n",
                "move /y \"%TEMP%\\temp-created.txt\" \"%TEMP%\\temp-renamed.txt\" >nul 2>nul\r\n",
                "del /q \"%TEMP%\\temp-delete-target.txt\" >nul 2>nul\r\n",
                "type \"%TEMP%\\temp-renamed.txt\" > \"{}\"\r\n",
                "> \"{}\" echo parent-denied\r\n",
                "> \"{}\" echo sibling-denied\r\n",
                "> \"{}\" echo user-temp-denied\r\n",
                "> \"{}\" echo foreign-temp-denied\r\n",
                "exit /b 0\r\n"
            ),
            workspace.join("created.txt").display(),
            workspace.join("created.txt").display(),
            rename_source.display(),
            workspace.join("renamed.txt").display(),
            delete_target.display(),
            workspace.join("temp-observed.txt").display(),
            parent_target.display(),
            sibling_target.display(),
            user_temp_target.display(),
            other_temp_target.display(),
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
        format!(
            concat!(
                "@echo off\r\n",
                ">> \"{}\" echo unexpected\r\n",
                "> \"{}\" echo unexpected\r\n",
                "del /q \"{}\" >nul 2>nul\r\n",
                "exit /b 0\r\n"
            ),
            workspace.join("existing.txt").display(),
            created.display(),
            workspace.join("existing.txt").display(),
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
    assert_eq!(child.wait(), Ok(0), "read-only child should complete");
    assert_eq!(
        fs::read_to_string(workspace.join("existing.txt")).expect("existing file should remain"),
        "must-remain\r\n"
    );
    assert!(!created.exists());
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
        format!(
            "@echo off\r\n> \"{}\" echo first\r\n> \"{}\" echo foreign\r\nexit /b 0\r\n",
            first_own.display(),
            first_foreign.display(),
        ),
    )
    .expect("first script should be written");
    fs::write(
        &second_script,
        format!(
            "@echo off\r\n> \"{}\" echo second\r\n> \"{}\" echo foreign\r\nexit /b 0\r\n",
            second_own.display(),
            second_foreign.display(),
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
        ],
    )
    .expect("second workspace-write child should start");

    assert_eq!(first.wait(), Ok(0));
    assert_eq!(second.wait(), Ok(0));
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
