use crate::{protocol, Config};
use std::io;

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
        let control = OpenOptions::new().write(true).open(pipe)?;
        return protocol::write_control(control, message);
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
