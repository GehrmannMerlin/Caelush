use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxError {
    CurrentTokenOpen,
    TokenGroupsQuery,
    LogonSidMissing,
    KnownSidCreate,
    RestrictedTokenCreate,
    RestrictedTokenNull,
    LowIntegritySet,
    DefaultDaclCreate,
    DefaultDaclSet,
    CommandLineBuild,
    EnvironmentBuild,
    StandardHandlePrepare,
    JobCreate,
    JobConfigure,
    RestrictedProcessCreate,
    JobAssign,
    ThreadResume,
    ProcessWait,
    ExitCodeQuery,
    UnsupportedMode,
    CapabilitySidInput,
    CapabilitySidHash,
    PathBoundaryInvalid,
    PathBoundaryOverlap,
    PathBoundaryReparse,
    PathBoundaryIdentityChanged,
    PathBoundaryUnsupportedRoot,
}

impl SandboxError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::CurrentTokenOpen => "WINDOWS_CURRENT_TOKEN_OPEN_FAILED",
            Self::TokenGroupsQuery => "WINDOWS_TOKEN_GROUPS_QUERY_FAILED",
            Self::LogonSidMissing => "WINDOWS_LOGON_SID_MISSING",
            Self::KnownSidCreate => "WINDOWS_KNOWN_SID_CREATE_FAILED",
            Self::RestrictedTokenCreate => "WINDOWS_RESTRICTED_TOKEN_CREATE_FAILED",
            Self::RestrictedTokenNull => "WINDOWS_RESTRICTED_TOKEN_NULL",
            Self::LowIntegritySet => "WINDOWS_LOW_INTEGRITY_SET_FAILED",
            Self::DefaultDaclCreate => "WINDOWS_DEFAULT_DACL_CREATE_FAILED",
            Self::DefaultDaclSet => "WINDOWS_DEFAULT_DACL_SET_FAILED",
            Self::CommandLineBuild => "WINDOWS_COMMAND_LINE_BUILD_FAILED",
            Self::EnvironmentBuild => "WINDOWS_ENVIRONMENT_BUILD_FAILED",
            Self::StandardHandlePrepare => "WINDOWS_STANDARD_HANDLE_PREPARE_FAILED",
            Self::JobCreate => "WINDOWS_JOB_CREATE_FAILED",
            Self::JobConfigure => "WINDOWS_JOB_CONFIGURE_FAILED",
            Self::RestrictedProcessCreate => "WINDOWS_RESTRICTED_PROCESS_CREATE_FAILED",
            Self::JobAssign => "WINDOWS_JOB_ASSIGN_FAILED",
            Self::ThreadResume => "WINDOWS_THREAD_RESUME_FAILED",
            Self::ProcessWait => "WINDOWS_PROCESS_WAIT_FAILED",
            Self::ExitCodeQuery => "WINDOWS_EXIT_CODE_QUERY_FAILED",
            Self::UnsupportedMode => "WINDOWS_SANDBOX_MODE_UNAVAILABLE",
            Self::CapabilitySidInput => "WINDOWS_CAPABILITY_SID_INPUT_INVALID",
            Self::CapabilitySidHash => "WINDOWS_CAPABILITY_SID_HASH_FAILED",
            Self::PathBoundaryInvalid => "WINDOWS_PATH_BOUNDARY_INVALID",
            Self::PathBoundaryOverlap => "WINDOWS_PATH_BOUNDARY_OVERLAP",
            Self::PathBoundaryReparse => "WINDOWS_PATH_BOUNDARY_REPARSE_UNSUPPORTED",
            Self::PathBoundaryIdentityChanged => "WINDOWS_PATH_BOUNDARY_IDENTITY_CHANGED",
            Self::PathBoundaryUnsupportedRoot => "WINDOWS_PATH_BOUNDARY_ROOT_UNSUPPORTED",
        }
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}
