use std::path::Path;
use std::process::{Child, Command};

pub fn spawn_restricted(
    provider: &str,
    workspace_root: &Path,
    cwd: &Path,
    program: &str,
    args: &[String],
) -> Result<Child, String> {
    match provider {
        "linux-bubblewrap" => {
            // The host network namespace is deliberately inherited. The policy layer governs
            // secret-taint exfiltration; this sandbox limits filesystem/process effects.
            let mut command = Command::new("bwrap");
            command
                .args(["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"])
                .args(["--bind"])
                .arg(workspace_root)
                .arg(workspace_root)
                .args(["--chdir"])
                .arg(cwd)
                .arg("--")
                .arg(program)
                .args(args);
            command.spawn().map_err(|_| "BUBBLEWRAP_UNAVAILABLE".to_string())
        }
        // Landlock requires an ABI probe and syscall setup before the child is created. The
        // dependency-free runner intentionally refuses to guess the ABI; a release build may
        // replace this branch with the audited syscall implementation without changing the
        // control protocol or falling back to ordinary spawning.
        "linux-landlock" => Err("LANDLOCK_BACKEND_UNAVAILABLE".to_string()),
        _ => Err("UNKNOWN_PROVIDER".to_string()),
    }
}
