use std::ffi::OsString;
use std::fs;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

mod acl;
mod capability_sid;
mod command_line;
mod error;
#[cfg(feature = "test-fault-injection")]
mod faults;
mod handle;
mod job;
mod path_boundary;
mod path_lock;
mod process;
mod sid;
mod token;

pub use super::windows_mode::WindowsSandboxMode;
pub use acl::{GrantChange, GrantStatus};
pub use process::RestrictedProcess;

/// Arms the test-only fault stage named by the environment. Compiled only into a
/// `test-fault-injection` build; see the `faults` module for why this is a build-time gate rather
/// than a switch.
#[cfg(feature = "test-fault-injection")]
pub fn arm_fault_from_environment() -> Result<(), String> {
    faults::arm_from_environment()
}

/// Fails if the armed test-only fault stage is reached here. Compiled only into a
/// `test-fault-injection` build.
#[cfg(feature = "test-fault-injection")]
pub fn fault_check_ready() -> Result<(), String> {
    faults::check(faults::FaultStage::Ready).map_err(|error| error.to_string())
}

/// Fails if the armed test-only fault stage is reached here. Compiled only into a
/// `test-fault-injection` build.
#[cfg(feature = "test-fault-injection")]
pub fn fault_check_child_start() -> Result<(), String> {
    faults::check(faults::FaultStage::ChildStart).map_err(|error| error.to_string())
}

/// VIEW_ONLY uses a Low-integrity write-restricted token and a kill-on-close Job Object.
/// WORKSPACE_WRITE uses capability-SID ACL preparation and a per-Run private-temp grant;
/// neither mode may silently call CreateProcess as an unrestricted fallback.
pub fn spawn_restricted(
    _provider: &str,
    mode: WindowsSandboxMode,
    _workspace_root: &Path,
    cwd: &Path,
    program: &str,
    args: &[String],
) -> Result<RestrictedProcess, String> {
    match mode {
        WindowsSandboxMode::ReadOnly => {
            #[cfg(feature = "test-fault-injection")]
            faults::check(faults::FaultStage::BeforeTokenCreate)
                .map_err(|error| error.to_string())?;
            let token =
                token::RestrictedToken::create_read_only().map_err(|error| error.to_string())?;
            #[cfg(feature = "test-fault-injection")]
            faults::check(faults::FaultStage::AfterTokenCreate)
                .map_err(|error| error.to_string())?;
            let environment = std::env::vars_os().collect::<Vec<_>>();
            RestrictedProcess::spawn(&token, program, args, cwd, &environment)
                .map_err(|error| error.to_string())
        }
        WindowsSandboxMode::WorkspaceWrite | WindowsSandboxMode::WorkspaceWriteReadonlyResource => {
            Err(error::SandboxError::UnsupportedMode.to_string())
        }
    }
}

pub fn workspace_status(workspace_root: &Path) -> Result<GrantStatus, String> {
    let boundary = path_boundary::validate_workspace_and_temp(workspace_root, None)
        .map_err(|error| error.to_string())?;
    let sid = capability_sid::workspace_capability_sid(&boundary.workspace.path.to_string_lossy())
        .map_err(|error| error.to_string())?;
    acl::inspect_write_grant(&boundary.workspace.path, &sid).map_err(|error| error.to_string())
}

pub fn workspace_prepare(workspace_root: &Path) -> Result<GrantChange, String> {
    let boundary = path_boundary::validate_workspace_and_temp(workspace_root, None)
        .map_err(|error| error.to_string())?;
    let sid = capability_sid::workspace_capability_sid(&boundary.workspace.path.to_string_lossy())
        .map_err(|error| error.to_string())?;
    acl::ensure_write_grant(&boundary.workspace.path, &sid).map_err(|error| error.to_string())
}

pub fn spawn_workspace_write_restricted(
    _provider: &str,
    workspace_root: &Path,
    cwd: &Path,
    private_temp: &Path,
    temp_marker_id: &str,
    program: &str,
    args: &[String],
) -> Result<RestrictedProcess, String> {
    let boundary = path_boundary::validate_workspace_and_temp(workspace_root, Some(private_temp))
        .map_err(|error| error.to_string())?;
    let workspace_sid =
        capability_sid::workspace_capability_sid(&boundary.workspace.path.to_string_lossy())
            .map_err(|error| error.to_string())?;
    let temp_sid =
        capability_sid::temp_capability_sid(temp_marker_id).map_err(|error| error.to_string())?;
    if acl::inspect_write_grant(&boundary.workspace.path, &workspace_sid)
        .map_err(|error| error.to_string())?
        != GrantStatus::Ready
    {
        return Err(error::SandboxError::WorkspaceGrantMissing.to_string());
    }
    // Injected after the workspace grant is confirmed, so a fault here leaves the standing
    // workspace ACE exactly as preparation made it.
    #[cfg(feature = "test-fault-injection")]
    faults::check(faults::FaultStage::WorkspaceGrant).map_err(|error| error.to_string())?;
    let cwd = validate_cwd(cwd, &boundary)?;
    #[cfg(feature = "test-fault-injection")]
    faults::check(faults::FaultStage::BeforeTokenCreate).map_err(|error| error.to_string())?;
    let token = token::RestrictedToken::create_workspace_write(&workspace_sid, &temp_sid)
        .map_err(|error| error.to_string())?;
    #[cfg(feature = "test-fault-injection")]
    faults::check(faults::FaultStage::AfterTokenCreate).map_err(|error| error.to_string())?;
    let temp = &boundary.temp.as_ref().expect("validated temp").path;
    // Injected before the temp ACE exists, so "the temp grant step failed" cannot leave a grant
    // behind. Failures *after* the ACE exists are covered by the process-side stages, which run
    // through the revoke path below.
    #[cfg(feature = "test-fault-injection")]
    faults::check(faults::FaultStage::TempGrant).map_err(|error| error.to_string())?;
    acl::ensure_write_grant(temp, &temp_sid).map_err(|error| error.to_string())?;
    let environment = workspace_environment(temp);
    match RestrictedProcess::spawn_with_temp_grant(
        &token,
        program,
        args,
        &cwd,
        &environment,
        temp.clone(),
        temp_sid.clone(),
    ) {
        Ok(process) => Ok(process),
        Err(error) => {
            let _ = acl::revoke_write_grant(temp, &temp_sid);
            Err(error.to_string())
        }
    }
}

pub fn spawn_workspace_write_readonly_resource(
    _provider: &str,
    workspace_root: &Path,
    cwd: &Path,
    private_temp: &Path,
    temp_marker_id: &str,
    resource_root: &Path,
    resource_grant_fingerprint: &str,
    program: &str,
    args: &[String],
) -> Result<RestrictedProcess, String> {
    if resource_grant_fingerprint.len() != 64
        || !resource_grant_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(error::SandboxError::ResourceGrantInvalid.to_string());
    }
    let boundary = path_boundary::validate_workspace_and_temp(workspace_root, Some(private_temp))
        .map_err(|error| error.to_string())?;
    let resource_pin = path_boundary::validate_and_pin_directory(resource_root)
        .map_err(|error| error.to_string())?;
    let resource = &resource_pin.validated.path;
    if normalize_windows_path(&resource.to_string_lossy())
        != normalize_windows_path(&resource_root.to_string_lossy())
        || path_overlaps(
            resource,
            &boundary.temp.as_ref().expect("validated temp").path,
        )
        || resource_is_workspace_or_ancestor(resource, &boundary.workspace.path)
    {
        return Err(error::SandboxError::ResourceRootBoundary.to_string());
    }

    let workspace_sid =
        capability_sid::workspace_capability_sid(&boundary.workspace.path.to_string_lossy())
            .map_err(|error| error.to_string())?;
    let temp_sid =
        capability_sid::temp_capability_sid(temp_marker_id).map_err(|error| error.to_string())?;
    let resource_sid = capability_sid::resource_capability_sid(
        &resource.to_string_lossy(),
        resource_grant_fingerprint,
    )
    .map_err(|error| error.to_string())?;

    if acl::inspect_write_grant(&boundary.workspace.path, &workspace_sid)
        .map_err(|error| error.to_string())?
        != GrantStatus::Ready
    {
        return Err(error::SandboxError::WorkspaceGrantMissing.to_string());
    }
    #[cfg(feature = "test-fault-injection")]
    faults::check(faults::FaultStage::WorkspaceGrant).map_err(|error| error.to_string())?;

    let cwd = validate_cwd(cwd, &boundary)?;
    #[cfg(feature = "test-fault-injection")]
    faults::check(faults::FaultStage::BeforeTokenCreate).map_err(|error| error.to_string())?;
    let resource_grant = acl::ReadOnlyResourceGrantLease::ensure(resource, &resource_sid)
        .map_err(|error| error.to_string())?;
    let token = token::RestrictedToken::create_workspace_write_readonly_resource(
        &workspace_sid,
        &temp_sid,
        &resource_sid,
    )
    .map_err(|error| error.to_string())?;
    #[cfg(feature = "test-fault-injection")]
    faults::check(faults::FaultStage::AfterTokenCreate).map_err(|error| error.to_string())?;

    let temp = &boundary.temp.as_ref().expect("validated temp").path;
    #[cfg(feature = "test-fault-injection")]
    faults::check(faults::FaultStage::TempGrant).map_err(|error| error.to_string())?;
    acl::ensure_write_grant(temp, &temp_sid).map_err(|error| error.to_string())?;
    let environment = workspace_environment(temp);
    match RestrictedProcess::spawn_with_temp_grant_and_resource_pin(
        &token,
        program,
        args,
        &cwd,
        &environment,
        temp.clone(),
        temp_sid.clone(),
        resource_pin,
        resource_grant,
    ) {
        Ok(process) => Ok(process),
        Err(error) => {
            let _ = acl::revoke_write_grant(temp, &temp_sid);
            Err(error.to_string())
        }
    }
}

fn normalize_windows_path(value: &str) -> String {
    let mut normalized = value.replace('/', "\\");
    let lowercase = normalized.to_lowercase();
    if lowercase.starts_with("\\\\?\\unc\\") {
        normalized = format!("\\\\{}", &normalized[8..]);
    } else if normalized.starts_with("\\\\?\\") {
        normalized = normalized[4..].to_string();
    }
    normalized.trim_end_matches('\\').to_lowercase()
}

fn path_overlaps(left: &Path, right: &Path) -> bool {
    let left = normalize_windows_path(&left.to_string_lossy());
    let right = normalize_windows_path(&right.to_string_lossy());
    left == right || left.starts_with(&(right.clone() + "\\")) || right.starts_with(&(left + "\\"))
}

fn resource_is_workspace_or_ancestor(resource: &Path, workspace: &Path) -> bool {
    let resource = normalize_windows_path(&resource.to_string_lossy());
    let workspace = normalize_windows_path(&workspace.to_string_lossy());
    resource == workspace || workspace.starts_with(&(resource + "\\"))
}

fn validate_cwd(
    cwd: &Path,
    boundary: &path_boundary::ValidatedWorkspaceBoundary,
) -> Result<std::path::PathBuf, String> {
    let canonical =
        fs::canonicalize(cwd).map_err(|_| error::SandboxError::WorkspaceCwdBoundary.to_string())?;
    let workspace = &boundary.workspace.path;
    let temp = &boundary.temp.as_ref().expect("workspace-write temp").path;
    if !canonical.starts_with(workspace) && !canonical.starts_with(temp) {
        return Err(error::SandboxError::WorkspaceCwdBoundary.to_string());
    }
    Ok(process_current_directory(&canonical))
}

fn process_current_directory(path: &Path) -> std::path::PathBuf {
    let wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    let extended_prefix = ['\\' as u16, '\\' as u16, '?' as u16, '\\' as u16];
    if !wide.starts_with(&extended_prefix) {
        return path.to_path_buf();
    }

    let unc_prefix = ['U' as u16, 'N' as u16, 'C' as u16, '\\' as u16];
    let normal = if wide[4..].starts_with(&unc_prefix) {
        let mut normal = vec!['\\' as u16, '\\' as u16];
        normal.extend_from_slice(&wide[8..]);
        normal
    } else {
        wide[4..].to_vec()
    };
    std::path::PathBuf::from(OsString::from_wide(&normal))
}

fn workspace_environment(temp: &Path) -> Vec<(OsString, OsString)> {
    let mut environment = std::env::vars_os()
        .filter(|(name, _)| {
            let name = name.to_string_lossy();
            !name.eq_ignore_ascii_case("TMP") && !name.eq_ignore_ascii_case("TEMP")
        })
        .collect::<Vec<_>>();
    let temp = process_current_directory(temp).as_os_str().to_os_string();
    environment.push((OsString::from("TMP"), temp.clone()));
    environment.push((OsString::from("TEMP"), temp));
    environment
}
