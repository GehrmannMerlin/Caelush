use std::path::Path;
use std::process::Child;

mod handle;

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
    let _ = mode;
    Err("WINDOWS_RESTRICTED_TOKEN_BACKEND_UNAVAILABLE".to_string())
}
