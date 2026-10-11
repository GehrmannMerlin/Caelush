#[cfg(not(windows))]
use crate::protocol;
use crate::Config;
use std::io::{self, Write};

#[derive(Clone, Copy)]
enum PipeStage {
    Open,
    Write,
    Flush,
}

impl PipeStage {
    const fn label(self) -> &'static str {
        match self {
            Self::Open => "PIPE_OPEN",
            Self::Write => "PIPE_WRITE",
            Self::Flush => "PIPE_FLUSH",
        }
    }
}

fn diagnostic(stage: PipeStage, error: &io::Error) -> String {
    let raw_os_error = error
        .raw_os_error()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "none".to_string());
    format!(
        "CAELUSH_RUNNER_CONTROL stage={} kind={:?} raw_os_error={}",
        stage.label(),
        error.kind(),
        raw_os_error,
    )
}

fn report(stage: PipeStage, error: io::Error) -> io::Error {
    // This bounded, path-free diagnostic deliberately uses stderr. A failed control pipe cannot
    // be its own only source of diagnostics.
    eprintln!("{}", diagnostic(stage, &error));
    error
}

pub fn write_message(config: &Config, message: &str) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::fs::File;
        use std::os::fd::FromRawFd;

        // The parent reserves fd 3 exclusively for the control protocol. The payload inherits no
        // reference to it, and stdout/stderr are never parsed as control input.
        let control = unsafe { File::from_raw_fd(3) };
        return protocol::write_control(control, message);
    }
    #[cfg(windows)]
    {
        use std::fs::OpenOptions;

        let pipe = config.control_pipe.as_ref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "missing Windows control pipe")
        })?;
        let mut control = OpenOptions::new()
            .write(true)
            .open(pipe)
            .map_err(|error| report(PipeStage::Open, error))?;
        control
            .write_all(message.as_bytes())
            .map_err(|error| report(PipeStage::Write, error))?;
        control
            .flush()
            .map_err(|error| report(PipeStage::Flush, error))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        let _ = (config, message);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "control channel unavailable",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{diagnostic, PipeStage};
    use std::io;

    #[test]
    fn reports_bounded_pipe_stage_without_error_text_or_path() {
        let error = io::Error::new(io::ErrorKind::PermissionDenied, r"secret\pipe\name");
        let message = diagnostic(PipeStage::Open, &error);
        assert_eq!(
            message,
            "CAELUSH_RUNNER_CONTROL stage=PIPE_OPEN kind=PermissionDenied raw_os_error=none"
        );
        assert!(!message.contains("secret"));
    }

    #[test]
    fn includes_raw_os_error_for_win32_diagnostics() {
        let error = io::Error::from_raw_os_error(5);
        let message = diagnostic(PipeStage::Write, &error);
        assert!(message.contains("stage=PIPE_WRITE"));
        assert!(message.contains("raw_os_error=5"));
    }
}
