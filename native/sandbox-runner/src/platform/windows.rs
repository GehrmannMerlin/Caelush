use std::path::Path;

mod command_line;
mod error;
mod handle;
mod job;
mod process;
mod sid;
mod token;

pub use super::windows_mode::WindowsSandboxMode;
pub use process::RestrictedProcess;

/// VIEW_ONLY uses a Low-integrity write-restricted token and a kill-on-close Job Object.
/// WORKSPACE_WRITE remains fail-closed until its capability-SID ACL preparation is implemented;
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
