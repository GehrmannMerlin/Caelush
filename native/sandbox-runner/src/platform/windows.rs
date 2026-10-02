use std::ffi::OsString;
use std::fs;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

mod acl;
mod capability_sid;
mod command_line;
mod error;
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
            let token =
                token::RestrictedToken::create_read_only().map_err(|error| error.to_string())?;
            let environment = std::env::vars_os().collect::<Vec<_>>();
            RestrictedProcess::spawn(&token, program, args, cwd, &environment)
                .map_err(|error| error.to_string())
        }
        WindowsSandboxMode::WorkspaceWrite => Err(error::SandboxError::UnsupportedMode.to_string()),
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
    let cwd = validate_cwd(cwd, &boundary)?;
    let token = token::RestrictedToken::create_workspace_write(&workspace_sid, &temp_sid)
        .map_err(|error| error.to_string())?;
    let temp = &boundary.temp.as_ref().expect("validated temp").path;
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
