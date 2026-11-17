#![cfg(windows)]

use caelush_sandbox_runner::platform::windows::{
    spawn_workspace_write_readonly_resource, workspace_prepare,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const RESOURCE_CONTENT: &str = "FROZEN_SKILL_RESOURCE_V1\r\n";
const ADJACENT_CONTENT: &str = "ADJACENT_PRIVATE_CONTENT\r\n";

#[test]
fn restricted_child_reads_only_its_exact_skill_resource_and_keeps_workspace_write() {
    let fixture = Fixture::new();
    let workspace = fixture.path.join("workspace space 中文");
    let resource = workspace
        .join(".caelush")
        .join("skills")
        .join("Skill Bundle 中文");
    let scripts = resource.join("scripts");
    let adjacent = fixture.path.join("Adjacent User Data");
    let private_temp = fixture.path.join("private temp");
    fs::create_dir_all(&workspace).expect("workspace should be created");
    fs::create_dir_all(&scripts).expect("Skill resource should be created");
    fs::create_dir_all(&adjacent).expect("adjacent user directory should be created");
    fs::create_dir_all(&private_temp).expect("private temp should be created");
    restrict_to_current_user_and_system(&adjacent);

    let resource_file = scripts.join("version.txt");
    let adjacent_file = adjacent.join("private.txt");
    fs::write(&resource_file, RESOURCE_CONTENT).expect("resource fixture should be written");
    fs::write(&adjacent_file, ADJACENT_CONTENT).expect("adjacent fixture should be written");
    let probe = workspace.join("probe.cmd");
    fs::write(
        &probe,
        concat!(
            "@echo off\r\n",
            "type \"%~1\" > \"resource-read.txt\" 2>nul || (echo DENIED>\"resource-read-failed.txt\" & exit /b 21)\r\n",
            "type \"%~2\" > \"adjacent-read.txt\" 2>nul && (echo READABLE>\"adjacent-readable.txt\") || (echo DENIED>\"adjacent-denied.txt\")\r\n",
            "echo MUTATED>>\"%~1\" 2>nul && (echo WRITABLE>\"resource-write-ok.txt\") || (echo DENIED>\"resource-write-denied.txt\")\r\n",
            "echo workspace-write-ok>\"workspace-write.txt\"\r\n",
            "echo temp-write-ok>\"%TEMP%\\skill-temp-write.txt\"\r\n",
            "exit /b 0\r\n",
        ),
    )
    .expect("probe script should be written");
    workspace_prepare(&workspace).expect("workspace write grant should be prepared");

    let program = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let args = vec![
        "/d".to_string(),
        "/s".to_string(),
        "/c".to_string(),
        "probe.cmd".to_string(),
        resource_file.to_string_lossy().into_owned(),
        adjacent_file.to_string_lossy().into_owned(),
    ];
    let mut process = spawn_workspace_write_readonly_resource(
        "windows-acl-restricted-token",
        &workspace,
        &workspace,
        &private_temp,
        "skill-resource-test-run",
        &resource,
        &"a".repeat(64),
        &program,
        &args,
    )
    .expect("resource-scoped process should start");

    assert_eq!(process.wait(), Ok(0), "probe should complete successfully");
    assert_eq!(
        fs::read_to_string(workspace.join("resource-read.txt")).expect("resource should be read"),
        RESOURCE_CONTENT
    );
    assert!(!workspace.join("resource-read-failed.txt").exists());
    assert!(!workspace.join("adjacent-readable.txt").exists());
    assert!(workspace.join("adjacent-denied.txt").exists());
    assert!(!workspace.join("resource-write-ok.txt").exists());
    assert!(workspace.join("resource-write-denied.txt").exists());
    assert_eq!(
        fs::read_to_string(&resource_file).expect("resource should remain unchanged"),
        RESOURCE_CONTENT
    );
    assert_eq!(
        fs::read_to_string(workspace.join("workspace-write.txt"))
            .expect("workspace write should work"),
        "workspace-write-ok\r\n"
    );
    assert_eq!(
        fs::read_to_string(private_temp.join("skill-temp-write.txt"))
            .expect("private temp write should work"),
        "temp-write-ok\r\n"
    );
    assert_eq!(
        fs::read_to_string(&adjacent_file).expect("adjacent file should remain"),
        ADJACENT_CONTENT
    );
}

#[test]
fn resource_root_cannot_be_replaced_until_the_restricted_child_exits() {
    let fixture = Fixture::new();
    let workspace = fixture.path.join("workspace");
    let resource = fixture.path.join("Frozen Skill Bundle");
    let moved_resource = fixture.path.join("Frozen Skill Bundle moved");
    let private_temp = fixture.path.join("private temp");
    let hold_script = workspace.join("hold.cmd");
    let started_marker = workspace.join("resource-child-started.txt");
    fs::create_dir_all(&workspace).expect("workspace should be created");
    fs::create_dir_all(&resource).expect("resource root should be created");
    fs::create_dir_all(&private_temp).expect("private temp should be created");
    fs::write(
        &hold_script,
        "@echo off\r\necho started>resource-child-started.txt\r\nfor /l %%i in (1,1,10000000) do rem\r\nexit /b 0\r\n",
    )
    .expect("hold script should be created");
    workspace_prepare(&workspace).expect("workspace write grant should be prepared");

    let program = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let args = vec![
        "/d".to_string(),
        "/s".to_string(),
        "/c".to_string(),
        "hold.cmd".to_string(),
    ];
    let mut process = spawn_workspace_write_readonly_resource(
        "windows-acl-restricted-token",
        &workspace,
        &workspace,
        &private_temp,
        "skill-resource-pin-test-run",
        &resource,
        &"b".repeat(64),
        &program,
        &args,
    )
    .expect("resource-scoped process should start");

    for _ in 0..50 {
        if started_marker.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        started_marker.exists(),
        "the child should start its hold script before testing the path lock"
    );
    assert!(
        fs::rename(&resource, &moved_resource).is_err(),
        "the active resource root must not be renamed or replaced"
    );
    assert_eq!(
        process.wait(),
        Ok(0),
        "the restricted child should complete"
    );
    fs::rename(&resource, &moved_resource)
        .expect("the resource root should be replaceable after its grant is revoked");
}

struct Fixture {
    path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should follow the epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "caelush-sandbox-skill-resource-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap_or_else(|error| {
            panic!(
                "fixture root should be created at {}: {error}",
                path.display()
            )
        });
        Self { path }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.path.exists() {
            fs::remove_dir_all(&self.path).expect("fixture should be removable by parent");
        }
    }
}

fn restrict_to_current_user_and_system(path: &Path) {
    let output = Command::new("whoami.exe")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .expect("whoami should resolve the current Windows account");
    assert!(output.status.success(), "whoami should succeed");
    let identity = String::from_utf8(output.stdout).expect("whoami output should be UTF-8");
    let sid = identity
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '-')
        .find(|candidate| candidate.starts_with("S-1-"))
        .expect("whoami output should contain the current user SID");
    let output = Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("*{sid}:(OI)(CI)F"))
        .arg("SYSTEM:(OI)(CI)F")
        .output()
        .expect("icacls should restrict the adjacent directory DACL");
    assert!(
        output.status.success(),
        "icacls should restrict the adjacent directory: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
