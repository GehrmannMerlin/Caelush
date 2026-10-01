use std::path::Path;
use std::process::Child;

/// Windows is intentionally fail-closed until the release build links the audited native
/// restricted-token implementation. This module is the platform seam for CreateRestrictedToken,
/// Low Integrity, capability-SID ACL preparation, and Job Object kill-on-close; it must never
/// silently call CreateProcess as an unrestricted fallback.
pub fn spawn_restricted(
    _provider: &str,
    _workspace_root: &Path,
    _cwd: &Path,
    _program: &str,
    _args: &[String],
) -> Result<Child, String> {
    Err("WINDOWS_RESTRICTED_TOKEN_BACKEND_UNAVAILABLE".to_string())
}
