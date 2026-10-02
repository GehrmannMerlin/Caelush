#![cfg(windows)]

use caelush_sandbox_runner::platform::windows::spawn_restricted;
use caelush_sandbox_runner::platform::windows_mode::WindowsSandboxMode;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
