mod control;
mod protocol;

use caelush_sandbox_runner::platform;
use std::env;
use std::path::PathBuf;
use std::process::exit;

#[derive(Debug, PartialEq, Eq)]
enum Operation {
    Run(RunConfig),
    TransportProbe,
}

#[derive(Debug, PartialEq, Eq)]
struct RunConfig {
    mode: platform::windows_mode::WindowsSandboxMode,
    workspace_root: PathBuf,
    cwd: PathBuf,
    program: String,
    args: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct Config {
    operation: Operation,
    provider: String,
    nonce: String,
    boundary_fingerprint: String,
    control_pipe: Option<PathBuf>,
}

fn main() {
    let config = match parse_args(env::args().skip(1).collect()) {
        Ok(value) => value,
        Err(_) => exit(1),
    };
    match execute(&config) {
        Ok(code) => exit(code),
        Err(code) => {
            let _ = write_error(&config, &code);
            exit(1);
        }
    }
}

fn execute(config: &Config) -> Result<i32, String> {
    match &config.operation {
        Operation::TransportProbe => {
            write_ready(config, "NONE").map_err(|_| "CONTROL_WRITE_FAILED".to_string())?;
            Ok(0)
        }
        Operation::Run(run) => {
            let mut child = spawn_target(config, run)?;
            let enforcement = if config.provider == "windows-acl-restricted-token" {
                "PARTIAL"
            } else {
                "HARD"
            };
            write_ready(config, enforcement).map_err(|_| "CONTROL_WRITE_FAILED".to_string())?;
            let status = wait_target(&mut child)?;
            Ok(status as i32)
        }
    }
}

#[cfg(target_os = "windows")]
type TargetProcess = platform::windows::RestrictedProcess;
#[cfg(not(target_os = "windows"))]
type TargetProcess = std::process::Child;

fn spawn_target(config: &Config, run: &RunConfig) -> Result<TargetProcess, String> {
    #[cfg(target_os = "linux")]
    {
        return platform::linux::spawn_restricted(
            &config.provider,
            &run.workspace_root,
            &run.cwd,
            &run.program,
            &run.args,
        );
    }
    #[cfg(target_os = "macos")]
    {
        return platform::macos::spawn_restricted(
            &config.provider,
            &run.workspace_root,
            &run.cwd,
            &run.program,
            &run.args,
        );
    }
    #[cfg(target_os = "windows")]
    {
        return platform::windows::spawn_restricted(
            &config.provider,
            run.mode,
            &run.workspace_root,
            &run.cwd,
            &run.program,
            &run.args,
        );
    }
    #[allow(unreachable_code)]
    Err("UNSUPPORTED_PLATFORM".to_string())
}

#[cfg(target_os = "windows")]
fn wait_target(child: &mut TargetProcess) -> Result<u32, String> {
    child.wait().map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
fn wait_target(child: &mut TargetProcess) -> Result<u32, String> {
    let status = child.wait().map_err(|_| "CHILD_WAIT_FAILED".to_string())?;
    Ok(status.code().unwrap_or(1) as u32)
}

fn parse_args(args: Vec<String>) -> Result<Config, String> {
    let mut operation = None;
    let mut control_pipe = None;
    let mut provider = None;
    let mut mode = None;
    let mut nonce = None;
    let mut boundary_fingerprint = None;
    let mut workspace_root = None;
    let mut cwd = None;
    let mut program = None;
    let mut payload_args = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--operation" => {
                if operation.is_some() {
                    return Err("DUPLICATE_OPERATION".to_string());
                }
                operation = Some(next(&args, &mut index)?);
            }
            "--control-pipe" => {
                set_once(&mut control_pipe, PathBuf::from(next(&args, &mut index)?))?
            }
            "--provider" => set_once(&mut provider, next(&args, &mut index)?)?,
            "--mode" => set_once(&mut mode, next(&args, &mut index)?)?,
            "--nonce" => set_once(&mut nonce, next(&args, &mut index)?)?,
            "--boundary-fingerprint" => {
                set_once(&mut boundary_fingerprint, next(&args, &mut index)?)?
            }
            "--workspace-root" => {
                set_once(&mut workspace_root, PathBuf::from(next(&args, &mut index)?))?
            }
            "--cwd" => set_once(&mut cwd, PathBuf::from(next(&args, &mut index)?))?,
            "--program" => set_once(&mut program, next(&args, &mut index)?)?,
            "--" => {
                payload_args = Some(args[index + 1..].to_vec());
                break;
            }
            _ => return Err("INVALID_ARGUMENT".to_string()),
        }
        index += 1;
    }

    let operation = match operation
        .ok_or_else(|| "MISSING_OPERATION".to_string())?
        .as_str()
    {
        "run" => {
            let args = payload_args.ok_or_else(|| "MISSING_ARGUMENT_SEPARATOR".to_string())?;
            Operation::Run(RunConfig {
                mode: platform::windows_mode::WindowsSandboxMode::parse(
                    &mode.ok_or_else(|| "MISSING_MODE".to_string())?,
                )?,
                workspace_root: workspace_root.ok_or_else(|| "MISSING_WORKSPACE".to_string())?,
                cwd: cwd.ok_or_else(|| "MISSING_CWD".to_string())?,
                program: program.ok_or_else(|| "MISSING_PROGRAM".to_string())?,
                args,
            })
        }
        "transport-probe" => {
            if workspace_root.is_some()
                || cwd.is_some()
                || program.is_some()
                || mode.is_some()
                || payload_args.is_some()
            {
                return Err("INVALID_PROBE_ARGUMENT".to_string());
            }
            Operation::TransportProbe
        }
        _ => return Err("UNKNOWN_OPERATION".to_string()),
    };

    #[cfg(windows)]
    if control_pipe.is_none() {
        return Err("MISSING_CONTROL_PIPE".to_string());
    }

    Ok(Config {
        operation,
        provider: provider.ok_or_else(|| "MISSING_PROVIDER".to_string())?,
        nonce: nonce.ok_or_else(|| "MISSING_NONCE".to_string())?,
        boundary_fingerprint: boundary_fingerprint.ok_or_else(|| "MISSING_BOUNDARY".to_string())?,
        control_pipe,
    })
}

fn set_once<T>(slot: &mut Option<T>, value: T) -> Result<(), String> {
    if slot.is_some() {
        return Err("DUPLICATE_ARGUMENT".to_string());
    }
    *slot = Some(value);
    Ok(())
}

fn next(args: &[String], index: &mut usize) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| "MISSING_ARGUMENT".to_string())
}

fn write_ready(config: &Config, enforcement: &str) -> std::io::Result<()> {
    control::write_message(
        config,
        &protocol::ready(
            &config.nonce,
            &config.provider,
            &config.boundary_fingerprint,
            enforcement,
        ),
    )
}

fn write_error(config: &Config, code: &str) -> std::io::Result<()> {
    control::write_message(config, &protocol::error(&config.nonce, code))
}

#[cfg(test)]
mod tests {
    use super::parse_args;

    fn run_args() -> Vec<String> {
        vec![
            "--operation",
            "run",
            "--control-pipe",
            r"\\.\pipe\caelush-sandbox-test",
            "--provider",
            "windows-acl-restricted-token",
            "--mode",
            "read-only",
            "--nonce",
            "runner-test-nonce",
            "--boundary-fingerprint",
            "runner-test-boundary",
            "--workspace-root",
            r"C:\workspace",
            "--cwd",
            r"C:\workspace",
            "--program",
            "payload.exe",
            "--",
            "--operation",
            "payload-value",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    }

    #[test]
    fn rejects_missing_operation() {
        let mut args = run_args();
        args.drain(0..2);
        assert_eq!(parse_args(args).err().as_deref(), Some("MISSING_OPERATION"));
    }

    #[test]
    fn rejects_duplicate_operation() {
        let mut args = run_args();
        args.splice(2..2, ["--operation".to_string(), "run".to_string()]);
        assert_eq!(
            parse_args(args).err().as_deref(),
            Some("DUPLICATE_OPERATION")
        );
    }

    #[test]
    fn rejects_unknown_operation() {
        let mut args = run_args();
        args[1] = "escape".to_string();
        assert_eq!(parse_args(args).err().as_deref(), Some("UNKNOWN_OPERATION"));
    }

    #[test]
    fn rejects_missing_run_mode() {
        let mut args = run_args();
        args.drain(6..8);
        assert_eq!(parse_args(args).err().as_deref(), Some("MISSING_MODE"));
    }

    #[test]
    fn rejects_unknown_run_mode() {
        let mut args = run_args();
        args[7] = "host-user".to_string();
        assert_eq!(parse_args(args).err().as_deref(), Some("UNKNOWN_MODE"));
    }

    #[test]
    fn accepts_workspace_write_as_a_known_but_separate_mode() {
        let mut args = run_args();
        args[7] = "workspace-write".to_string();
        assert!(parse_args(args).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_missing_windows_control_pipe() {
        let mut args = run_args();
        args.drain(2..4);
        assert_eq!(
            parse_args(args).err().as_deref(),
            Some("MISSING_CONTROL_PIPE")
        );
    }

    #[test]
    fn transport_probe_does_not_require_payload_arguments() {
        let args = vec![
            "--operation",
            "transport-probe",
            "--control-pipe",
            r"\\.\pipe\caelush-sandbox-test",
            "--provider",
            "windows-acl-restricted-token",
            "--nonce",
            "runner-test-nonce",
            "--boundary-fingerprint",
            "runner-test-boundary",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert!(parse_args(args).is_ok());
    }

    #[test]
    fn preserves_every_payload_argument_after_the_separator() {
        let config = parse_args(run_args()).expect("run arguments should parse");
        let super::Operation::Run(run) = config.operation else {
            panic!("expected run operation");
        };
        assert_eq!(run.args, ["--operation", "payload-value"]);
    }
}
