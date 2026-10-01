mod platform;
mod protocol;

use std::env;
use std::io;
use std::path::PathBuf;
use std::process::exit;

struct Config {
    provider: String,
    nonce: String,
    boundary_fingerprint: String,
    workspace_root: PathBuf,
    cwd: PathBuf,
    program: String,
    args: Vec<String>,
}

fn main() {
    let config = match parse_args(env::args().skip(1).collect()) {
        Ok(value) => value,
        Err(code) => {
            let _ = write_error("", &code);
            exit(1);
        }
    };
    if let Err(code) = run(config) {
        let _ = write_error(&code.0, &code.1);
        exit(1);
    }
}

fn run(config: Config) -> Result<(), (String, String)> {
    let mut child = spawn_target(&config).map_err(|code| (config.nonce.clone(), code))?;
    let enforcement = if config.provider == "windows-acl-restricted-token" {
        "PARTIAL"
    } else {
        "HARD"
    };
    write_ready(&config, enforcement).map_err(|_| (config.nonce.clone(), "CONTROL_WRITE_FAILED".to_string()))?;
    let status = child.wait().map_err(|_| (config.nonce.clone(), "CHILD_WAIT_FAILED".to_string()))?;
    exit(status.code().unwrap_or(1));
}

fn spawn_target(config: &Config) -> Result<std::process::Child, String> {
    #[cfg(target_os = "linux")]
    {
        return platform::linux::spawn_restricted(
            &config.provider,
            &config.workspace_root,
            &config.cwd,
            &config.program,
            &config.args,
        );
    }
    #[cfg(target_os = "macos")]
    {
        return platform::macos::spawn_restricted(
            &config.provider,
            &config.workspace_root,
            &config.cwd,
            &config.program,
            &config.args,
        );
    }
    #[cfg(target_os = "windows")]
    {
        return platform::windows::spawn_restricted(
            &config.provider,
            &config.workspace_root,
            &config.cwd,
            &config.program,
            &config.args,
        );
    }
    #[allow(unreachable_code)]
    Err("UNSUPPORTED_PLATFORM".to_string())
}

fn parse_args(args: Vec<String>) -> Result<Config, String> {
    let mut provider = None;
    let mut nonce = None;
    let mut boundary_fingerprint = None;
    let mut workspace_root = None;
    let mut cwd = None;
    let mut program = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--provider" => provider = Some(next(&args, &mut index)?),
            "--nonce" => nonce = Some(next(&args, &mut index)?),
            "--boundary-fingerprint" => boundary_fingerprint = Some(next(&args, &mut index)?),
            "--workspace-root" => workspace_root = Some(PathBuf::from(next(&args, &mut index)?)),
            "--cwd" => cwd = Some(PathBuf::from(next(&args, &mut index)?)),
            "--program" => program = Some(next(&args, &mut index)?),
            "--" => return Ok(Config {
                provider: provider.ok_or_else(|| "MISSING_PROVIDER".to_string())?,
                nonce: nonce.ok_or_else(|| "MISSING_NONCE".to_string())?,
                boundary_fingerprint: boundary_fingerprint.ok_or_else(|| "MISSING_BOUNDARY".to_string())?,
                workspace_root: workspace_root.ok_or_else(|| "MISSING_WORKSPACE".to_string())?,
                cwd: cwd.ok_or_else(|| "MISSING_CWD".to_string())?,
                program: program.ok_or_else(|| "MISSING_PROGRAM".to_string())?,
                args: args[index + 1..].to_vec(),
            }),
            _ => return Err("INVALID_ARGUMENT".to_string()),
        }
        index += 1;
    }
    Err("MISSING_ARGUMENT_SEPARATOR".to_string())
}

fn next(args: &[String], index: &mut usize) -> Result<String, String> {
    *index += 1;
    args.get(*index).cloned().ok_or_else(|| "MISSING_ARGUMENT".to_string())
}

fn write_ready(config: &Config, enforcement: &str) -> io::Result<()> {
    let message = protocol::ready(
        &config.nonce,
        &config.provider,
        &config.boundary_fingerprint,
        enforcement,
    );
    write_control(message.as_bytes())
}

fn write_error(nonce: &str, code: &str) -> io::Result<()> {
    write_control(protocol::error(nonce, code).as_bytes())
}

fn write_control(message: &[u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::fs::File;
        use std::os::fd::FromRawFd;
        // The parent reserves fd 3 exclusively for the control protocol. User stdout/stderr are
        // never parsed as control input and cannot manufacture READY.
        let mut control = unsafe { File::from_raw_fd(3) };
        let result = std::io::Write::write_all(&mut control, message);
        let _ = std::io::Write::flush(&mut control);
        std::mem::forget(control);
        result
    }
    #[cfg(not(unix))]
    {
        let _ = message;
        Err(io::Error::new(io::ErrorKind::Unsupported, "control channel unavailable"))
    }
}
