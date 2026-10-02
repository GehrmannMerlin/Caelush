#![cfg(windows)]

use caelush_sandbox_runner::platform::windows::{
    spawn_workspace_write_restricted, workspace_prepare, workspace_status, GrantChange, GrantStatus,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn explicit_workspace_prepare_changes_status_without_starting_a_payload() {
    let root = TemporaryRoot::new("prepare-status");
    let workspace = root.path.join("workspace");
    fs::create_dir(&workspace).expect("workspace should be created");

    assert_eq!(
        workspace_status(&workspace).expect("workspace ACL should be inspectable"),
        GrantStatus::Missing
    );
    assert_eq!(
        workspace_prepare(&workspace).expect("workspace ACL should be prepared"),
        GrantChange::Added
    );
    assert_eq!(
        workspace_status(&workspace).expect("prepared workspace ACL should be inspectable"),
        GrantStatus::Ready
    );
    assert_eq!(
        workspace_prepare(&workspace).expect("repeated workspace prepare should succeed"),
        GrantChange::Unchanged
    );
}

#[test]
fn workspace_write_runner_rejects_an_unprepared_workspace_before_payload_start() {
    let root = TemporaryRoot::new("reject-unprepared");
    let workspace = root.path.join("workspace");
    let private_temp = root.path.join("private-temp");
    fs::create_dir(&workspace).expect("workspace should be created");
    fs::create_dir(&private_temp).expect("private temp should be created");
    let sentinel = workspace.join("payload-started.txt");
    let program = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let command = format!("type nul > \"{}\"", sentinel.display());

    let error = spawn_workspace_write_restricted(
        "windows-acl-restricted-token",
        &workspace,
        &workspace,
        &private_temp,
        "marker-unprepared",
        &program,
        &[
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            command,
        ],
    )
    .expect_err("unprepared workspace should fail closed");

    assert_eq!(error, "WINDOWS_WORKSPACE_GRANT_MISSING");
    assert!(
        !sentinel.exists(),
        "payload must not start before preparation"
    );
}

struct TemporaryRoot {
    path: PathBuf,
}

impl TemporaryRoot {
    fn new(label: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should follow the epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "caelush-sandbox-runner-{label}-{}-{suffix}",
            std::process::id()
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

fn remove_tree(path: &Path) {
    fs::remove_dir_all(path).expect("temporary root should be removable");
}
