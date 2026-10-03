#![cfg(windows)]

use caelush_sandbox_runner::platform::windows::{
    spawn_workspace_write_restricted, workspace_prepare, workspace_status, GrantChange, GrantStatus,
};
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING, WRITE_OWNER,
};

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
fn workspace_prepare_uses_owner_dacl_authority_and_removes_temporary_write_owner() {
    let root = TemporaryRoot::new("prepare-write-owner");
    let workspace = root.path.join("workspace");
    fs::create_dir(&workspace).expect("workspace should be created");
    restrict_current_user_to_modify(&workspace);

    assert_eq!(
        workspace_prepare(&workspace).expect("owner should prepare an owned workspace"),
        GrantChange::Added
    );
    let status_after_prepare =
        workspace_status(&workspace).expect("prepared workspace should remain inspectable");
    assert_write_owner_is_not_retained(&workspace);
    restore_inheritance(&workspace);

    assert_eq!(
        status_after_prepare,
        GrantStatus::Ready,
        "the final capability DACL and integrity label must both be present"
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
        let test_temp = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-temp");
        fs::create_dir_all(&test_temp).expect("test temp parent should be created");
        let path = test_temp.join(format!(
            "caelush-sandbox-runner-{label}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap_or_else(|error| {
            panic!(
                "temporary root {} should be created: {error}",
                path.display()
            )
        });
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

fn restrict_current_user_to_modify(path: &Path) {
    let whoami = Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .expect("whoami should identify the current Windows principal");
    assert!(whoami.status.success(), "whoami should succeed");
    let output = String::from_utf8_lossy(&whoami.stdout);
    let sid = output
        .split(|character: char| character == '"' || character == ',' || character.is_whitespace())
        .find(|field| field.starts_with("S-1-"))
        .expect("whoami should return the current principal SID");
    let grant = format!("*{sid}:(OI)(CI)(M)");
    let status = Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(grant)
        .status()
        .expect("icacls should configure the temporary fixture");
    assert!(status.success(), "icacls should grant only Modify");
}

fn restore_inheritance(path: &Path) {
    let status = Command::new("icacls")
        .arg(path)
        .arg("/inheritance:e")
        .status()
        .expect("icacls should restore fixture inheritance");
    assert!(status.success(), "fixture inheritance should be restored");
}

fn assert_write_owner_is_not_retained(path: &Path) {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        unsafe { CloseHandle(handle) };
        panic!("temporary WRITE_OWNER access must not remain in the workspace DACL");
    }
    assert_eq!(
        unsafe { GetLastError() },
        windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED,
        "WRITE_OWNER should be denied after preparation"
    );
}
