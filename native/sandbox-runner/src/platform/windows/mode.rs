#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowsSandboxMode {
    ReadOnly,
    WorkspaceWrite,
}

impl WindowsSandboxMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "read-only" => Ok(Self::ReadOnly),
            "workspace-write" => Ok(Self::WorkspaceWrite),
            _ => Err("UNKNOWN_MODE".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::WindowsSandboxMode;

    #[test]
    fn parses_only_the_two_declared_modes() {
        assert_eq!(
            WindowsSandboxMode::parse("read-only"),
            Ok(WindowsSandboxMode::ReadOnly)
        );
        assert_eq!(
            WindowsSandboxMode::parse("workspace-write"),
            Ok(WindowsSandboxMode::WorkspaceWrite)
        );
        assert_eq!(
            WindowsSandboxMode::parse("host-user").err().as_deref(),
            Some("UNKNOWN_MODE")
        );
    }
}
