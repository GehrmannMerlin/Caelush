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
    UnsupportedMode,
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
            Self::UnsupportedMode => "WINDOWS_SANDBOX_MODE_UNAVAILABLE",
        }
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}
