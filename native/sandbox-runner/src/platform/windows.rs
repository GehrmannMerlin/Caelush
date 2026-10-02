use std::path::Path;
use std::process::Child;

mod error;
mod handle;
mod sid;
mod token;

pub use super::windows_mode::WindowsSandboxMode;

/// Windows is intentionally fail-closed until the release build links the audited native
/// restricted-token implementation. This module is the platform seam for CreateRestrictedToken,
/// Low Integrity, capability-SID ACL preparation, and Job Object kill-on-close; it must never
/// silently call CreateProcess as an unrestricted fallback.
pub fn spawn_restricted(
    _provider: &str,
    mode: WindowsSandboxMode,
    _workspace_root: &Path,
    _cwd: &Path,
    _program: &str,
    _args: &[String],
) -> Result<Child, String> {
    match mode {
        WindowsSandboxMode::ReadOnly => {
            let _token =
                token::RestrictedToken::create_read_only().map_err(|error| error.to_string())?;
            Err("WINDOWS_RESTRICTED_PROCESS_BACKEND_UNAVAILABLE".to_string())
        }
        WindowsSandboxMode::WorkspaceWrite => Err(error::SandboxError::UnsupportedMode.to_string()),
    }
}
