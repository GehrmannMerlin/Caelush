use std::process::{Child, Command};
use std::path::Path;

pub fn spawn_restricted(
    provider: &str,
    workspace_root: &Path,
    cwd: &Path,
    program: &str,
    args: &[String],
) -> Result<Child, String> {
    if provider != "macos-seatbelt" {
        return Err("UNKNOWN_PROVIDER".to_string());
    }
    let profile = format!(
        "(version 1)\n(deny default)\n(allow process*)\n(allow file-read*)\n(allow file-write* (subpath \"{}\"))\n(allow network*)\n",
        escape_path(workspace_root),
    );
    Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile, program])
        .args(args)
        .current_dir(cwd)
        .spawn()
        .map_err(|_| "SEATBELT_UNAVAILABLE".to_string())
}

fn escape_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}
