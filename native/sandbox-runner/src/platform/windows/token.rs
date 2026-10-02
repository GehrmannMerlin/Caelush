use super::error::SandboxError;
use super::handle::{OwnedHandle, OwnedLocal};
use super::sid::KnownSid;
use super::sid::OwnedSid;
use std::mem::{size_of, size_of_val};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE,
};
use windows_sys::Win32::Security::Authorization::{
    SetEntriesInAclW, EXPLICIT_ACCESS_W, GRANT_ACCESS, TRUSTEE_IS_SID, TRUSTEE_IS_WELL_KNOWN_GROUP,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, GetTokenInformation, SetTokenInformation, TokenDefaultDacl,
    TokenIntegrityLevel, ACL, DISABLE_MAX_PRIVILEGE, LUA_TOKEN, NO_INHERITANCE, SID_AND_ATTRIBUTES,
    TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY, WRITE_RESTRICTED,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub trait TokenBackend {
    type Handle;
    type Sid;
    type Acl;

    fn open_current_token(&self) -> Result<Self::Handle, SandboxError>;
    fn logon_sid(&self, token: &Self::Handle) -> Result<Self::Sid, SandboxError>;
    fn known_sid(&self, kind: KnownSid) -> Result<Self::Sid, SandboxError>;
    fn create_restricted_token(
        &self,
        token: &Self::Handle,
        logon_sid: &Self::Sid,
        everyone_sid: &Self::Sid,
    ) -> Result<Self::Handle, SandboxError>;
    fn set_low_integrity(
        &self,
        token: &Self::Handle,
        low_sid: &Self::Sid,
    ) -> Result<(), SandboxError>;
    fn create_default_dacl(
        &self,
        token: &Self::Handle,
        restricting_sid: &Self::Sid,
    ) -> Result<Self::Acl, SandboxError>;
    fn set_default_dacl(&self, token: &Self::Handle, acl: &Self::Acl) -> Result<(), SandboxError>;
}

pub fn create_read_only_with<B: TokenBackend>(backend: &B) -> Result<B::Handle, SandboxError> {
    let current_token = backend.open_current_token()?;
    let logon_sid = backend.logon_sid(&current_token)?;
    let everyone_sid = backend.known_sid(KnownSid::Everyone)?;
    let low_sid = backend.known_sid(KnownSid::LowIntegrity)?;
    let restricted_token =
        backend.create_restricted_token(&current_token, &logon_sid, &everyone_sid)?;
    backend.set_low_integrity(&restricted_token, &low_sid)?;
    let default_dacl = backend.create_default_dacl(&restricted_token, &everyone_sid)?;
    backend.set_default_dacl(&restricted_token, &default_dacl)?;
    Ok(restricted_token)
}

#[derive(Debug)]
pub struct RestrictedToken(OwnedHandle);

impl RestrictedToken {
    pub fn create_read_only() -> Result<Self, SandboxError> {
        create_read_only_with(&Win32TokenBackend).map(Self)
    }

    pub fn as_raw(&self) -> HANDLE {
        self.0.as_raw()
    }
}

struct Win32TokenBackend;

const READ_ONLY_RESTRICTED_TOKEN_FLAGS: u32 = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;

impl TokenBackend for Win32TokenBackend {
    type Handle = OwnedHandle;
    type Sid = OwnedSid;
    type Acl = OwnedLocal<ACL>;

    fn open_current_token(&self) -> Result<Self::Handle, SandboxError> {
        let mut raw = null_mut();
        let opened = unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
                &mut raw,
            )
        };
        if opened == 0 {
            drop_handle_if_present(raw);
            return Err(SandboxError::CurrentTokenOpen);
        }
        unsafe { OwnedHandle::from_raw(raw, SandboxError::CurrentTokenOpen.code()) }
            .map_err(|_| SandboxError::CurrentTokenOpen)
    }

    fn logon_sid(&self, token: &Self::Handle) -> Result<Self::Sid, SandboxError> {
        OwnedSid::logon_from_token(token)
    }

    fn known_sid(&self, kind: KnownSid) -> Result<Self::Sid, SandboxError> {
        OwnedSid::known(kind)
    }

    fn create_restricted_token(
        &self,
        token: &Self::Handle,
        logon_sid: &Self::Sid,
        everyone_sid: &Self::Sid,
    ) -> Result<Self::Handle, SandboxError> {
        let restricting_sids = [
            SID_AND_ATTRIBUTES {
                Sid: logon_sid.as_psid(),
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: everyone_sid.as_psid(),
                Attributes: 0,
            },
        ];
        let mut raw = null_mut();
        let created = unsafe {
            CreateRestrictedToken(
                token.as_raw(),
                READ_ONLY_RESTRICTED_TOKEN_FLAGS,
                0,
                null(),
                0,
                null(),
                restricting_sids.len() as u32,
                restricting_sids.as_ptr(),
                &mut raw,
            )
        };
        if created == 0 {
            drop_handle_if_present(raw);
            return Err(SandboxError::RestrictedTokenCreate);
        }
        unsafe { OwnedHandle::from_raw(raw, SandboxError::RestrictedTokenNull.code()) }
            .map_err(|_| SandboxError::RestrictedTokenNull)
    }

    fn set_low_integrity(
        &self,
        token: &Self::Handle,
        low_sid: &Self::Sid,
    ) -> Result<(), SandboxError> {
        const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES {
                Sid: low_sid.as_psid(),
                Attributes: SE_GROUP_INTEGRITY,
            },
        };
        let length = size_of::<TOKEN_MANDATORY_LABEL>()
            .checked_add(low_sid.length() as usize)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(SandboxError::LowIntegritySet)?;
        let updated = unsafe {
            SetTokenInformation(
                token.as_raw(),
                TokenIntegrityLevel,
                (&label as *const TOKEN_MANDATORY_LABEL).cast(),
                length,
            )
        };
        if updated == 0 {
            return Err(SandboxError::LowIntegritySet);
        }
        Ok(())
    }

    fn create_default_dacl(
        &self,
        token: &Self::Handle,
        restricting_sid: &Self::Sid,
    ) -> Result<Self::Acl, SandboxError> {
        let existing = query_default_dacl(token)?;
        let information = existing.as_ptr().cast::<TOKEN_DEFAULT_DACL>();
        let old_acl = unsafe { (*information).DefaultDacl };
        if old_acl.is_null() {
            return Err(SandboxError::DefaultDaclCreate);
        }
        let entries = [explicit_access(restricting_sid)];
        let mut acl = null_mut();
        let status =
            unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), old_acl, &mut acl) };
        if status != ERROR_SUCCESS {
            drop_local_if_present(acl);
            return Err(SandboxError::DefaultDaclCreate);
        }
        unsafe { OwnedLocal::from_raw(acl, SandboxError::DefaultDaclCreate.code()) }
            .map_err(|_| SandboxError::DefaultDaclCreate)
    }

    fn set_default_dacl(&self, token: &Self::Handle, acl: &Self::Acl) -> Result<(), SandboxError> {
        let information = TOKEN_DEFAULT_DACL {
            DefaultDacl: acl.as_ptr(),
        };
        let updated = unsafe {
            SetTokenInformation(
                token.as_raw(),
                TokenDefaultDacl,
                (&information as *const TOKEN_DEFAULT_DACL).cast(),
                size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        };
        if updated == 0 {
            return Err(SandboxError::DefaultDaclSet);
        }
        Ok(())
    }
}

fn explicit_access(sid: &OwnedSid) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: sid.as_psid().cast(),
        },
    }
}

fn query_default_dacl(token: &OwnedHandle) -> Result<Vec<usize>, SandboxError> {
    let mut required = 0u32;
    let queried = unsafe {
        GetTokenInformation(
            token.as_raw(),
            TokenDefaultDacl,
            null_mut(),
            0,
            &mut required,
        )
    };
    if queried != 0
        || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
        || required < size_of::<TOKEN_DEFAULT_DACL>() as u32
    {
        return Err(SandboxError::DefaultDaclCreate);
    }
    let words = (required as usize).div_ceil(size_of::<usize>());
    let mut storage = vec![0usize; words];
    let queried = unsafe {
        GetTokenInformation(
            token.as_raw(),
            TokenDefaultDacl,
            storage.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if queried == 0 || required as usize > size_of_val(storage.as_slice()) {
        return Err(SandboxError::DefaultDaclCreate);
    }
    Ok(storage)
}

fn drop_handle_if_present(raw: HANDLE) {
    if let Ok(handle) = unsafe { OwnedHandle::from_raw(raw, "IGNORED") } {
        drop(handle);
    }
}

fn drop_local_if_present(raw: *mut ACL) {
    if let Ok(allocation) = unsafe { OwnedLocal::from_raw(raw, "IGNORED") } {
        drop(allocation);
    }
}

#[cfg(test)]
mod tests {
    use super::{create_read_only_with, KnownSid, RestrictedToken, SandboxError, TokenBackend};
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Failure {
        Open,
        LogonSid,
        EveryoneSid,
        LowSid,
        RestrictedToken,
        RestrictedTokenNull,
        LowIntegrity,
        DefaultDaclCreate,
        DefaultDaclSet,
    }

    struct Resource {
        name: &'static str,
        drops: Rc<RefCell<Vec<&'static str>>>,
    }

    impl Drop for Resource {
        fn drop(&mut self) {
            self.drops.borrow_mut().push(self.name);
        }
    }

    struct MockBackend {
        failure: Option<Failure>,
        calls: RefCell<Vec<&'static str>>,
        drops: Rc<RefCell<Vec<&'static str>>>,
    }

    impl MockBackend {
        fn new(failure: Option<Failure>) -> Self {
            Self {
                failure,
                calls: RefCell::new(Vec::new()),
                drops: Rc::new(RefCell::new(Vec::new())),
            }
        }

        fn resource(&self, name: &'static str) -> Resource {
            Resource {
                name,
                drops: Rc::clone(&self.drops),
            }
        }
    }

    impl TokenBackend for MockBackend {
        type Handle = Resource;
        type Sid = Resource;
        type Acl = Resource;

        fn open_current_token(&self) -> Result<Self::Handle, SandboxError> {
            self.calls.borrow_mut().push("open-current-token");
            if self.failure == Some(Failure::Open) {
                return Err(SandboxError::CurrentTokenOpen);
            }
            Ok(self.resource("current-token"))
        }

        fn logon_sid(&self, _token: &Self::Handle) -> Result<Self::Sid, SandboxError> {
            self.calls.borrow_mut().push("find-logon-sid");
            if self.failure == Some(Failure::LogonSid) {
                return Err(SandboxError::LogonSidMissing);
            }
            Ok(self.resource("logon-sid"))
        }

        fn known_sid(&self, kind: KnownSid) -> Result<Self::Sid, SandboxError> {
            match kind {
                KnownSid::Everyone => {
                    self.calls.borrow_mut().push("create-everyone-sid");
                    if self.failure == Some(Failure::EveryoneSid) {
                        return Err(SandboxError::KnownSidCreate);
                    }
                    Ok(self.resource("everyone-sid"))
                }
                KnownSid::LowIntegrity => {
                    self.calls.borrow_mut().push("create-low-sid");
                    if self.failure == Some(Failure::LowSid) {
                        return Err(SandboxError::KnownSidCreate);
                    }
                    Ok(self.resource("low-sid"))
                }
            }
        }

        fn create_restricted_token(
            &self,
            _token: &Self::Handle,
            logon_sid: &Self::Sid,
            everyone_sid: &Self::Sid,
        ) -> Result<Self::Handle, SandboxError> {
            self.calls.borrow_mut().push("create-restricted-token");
            assert_eq!(logon_sid.name, "logon-sid");
            assert_eq!(everyone_sid.name, "everyone-sid");
            match self.failure {
                Some(Failure::RestrictedToken) => Err(SandboxError::RestrictedTokenCreate),
                Some(Failure::RestrictedTokenNull) => Err(SandboxError::RestrictedTokenNull),
                _ => Ok(self.resource("restricted-token")),
            }
        }

        fn set_low_integrity(
            &self,
            _token: &Self::Handle,
            _low_sid: &Self::Sid,
        ) -> Result<(), SandboxError> {
            self.calls.borrow_mut().push("set-low-integrity");
            if self.failure == Some(Failure::LowIntegrity) {
                return Err(SandboxError::LowIntegritySet);
            }
            Ok(())
        }

        fn create_default_dacl(
            &self,
            _token: &Self::Handle,
            restricting_sid: &Self::Sid,
        ) -> Result<Self::Acl, SandboxError> {
            self.calls.borrow_mut().push("create-default-dacl");
            assert_eq!(restricting_sid.name, "everyone-sid");
            if self.failure == Some(Failure::DefaultDaclCreate) {
                return Err(SandboxError::DefaultDaclCreate);
            }
            Ok(self.resource("default-dacl"))
        }

        fn set_default_dacl(
            &self,
            _token: &Self::Handle,
            _acl: &Self::Acl,
        ) -> Result<(), SandboxError> {
            self.calls.borrow_mut().push("set-default-dacl");
            if self.failure == Some(Failure::DefaultDaclSet) {
                return Err(SandboxError::DefaultDaclSet);
            }
            Ok(())
        }
    }

    #[test]
    fn creates_the_read_only_token_in_fail_closed_order() {
        let backend = MockBackend::new(None);
        let token = create_read_only_with(&backend).expect("mock token creation should succeed");
        assert_eq!(
            backend.calls.into_inner(),
            [
                "open-current-token",
                "find-logon-sid",
                "create-everyone-sid",
                "create-low-sid",
                "create-restricted-token",
                "set-low-integrity",
                "create-default-dacl",
                "set-default-dacl",
            ]
        );
        drop(token);
    }

    #[test]
    fn uses_all_three_restricted_token_hardening_flags() {
        assert_eq!(
            super::READ_ONLY_RESTRICTED_TOKEN_FLAGS,
            windows_sys::Win32::Security::DISABLE_MAX_PRIVILEGE
                | windows_sys::Win32::Security::LUA_TOKEN
                | windows_sys::Win32::Security::WRITE_RESTRICTED
        );
    }

    #[test]
    fn creates_a_real_restricted_low_integrity_token() {
        use crate::platform::windows::sid::OwnedSid;
        use windows_sys::Win32::Security::{
            EqualSid, GetTokenInformation, IsTokenRestricted, TokenIntegrityLevel,
            TOKEN_MANDATORY_LABEL,
        };

        let token = RestrictedToken::create_read_only()
            .expect("the current Windows process should be able to derive a restricted token");
        assert_ne!(unsafe { IsTokenRestricted(token.as_raw()) }, 0);

        let mut storage = [0usize; 16];
        let mut returned = 0u32;
        let queried = unsafe {
            GetTokenInformation(
                token.as_raw(),
                TokenIntegrityLevel,
                storage.as_mut_ptr().cast(),
                std::mem::size_of_val(&storage) as u32,
                &mut returned,
            )
        };
        assert_ne!(queried, 0);
        let label = storage.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        let low_sid = OwnedSid::known(KnownSid::LowIntegrity).expect("Low SID should exist");
        assert_ne!(
            unsafe { EqualSid((*label).Label.Sid, low_sid.as_psid()) },
            0
        );
    }

    #[test]
    fn forwards_each_initialization_failure_without_continuing() {
        let cases = [
            (Failure::Open, SandboxError::CurrentTokenOpen),
            (Failure::LogonSid, SandboxError::LogonSidMissing),
            (Failure::EveryoneSid, SandboxError::KnownSidCreate),
            (Failure::LowSid, SandboxError::KnownSidCreate),
            (
                Failure::RestrictedToken,
                SandboxError::RestrictedTokenCreate,
            ),
            (
                Failure::RestrictedTokenNull,
                SandboxError::RestrictedTokenNull,
            ),
            (Failure::LowIntegrity, SandboxError::LowIntegritySet),
            (Failure::DefaultDaclCreate, SandboxError::DefaultDaclCreate),
            (Failure::DefaultDaclSet, SandboxError::DefaultDaclSet),
        ];
        for (failure, expected) in cases {
            let backend = MockBackend::new(Some(failure));
            assert_eq!(create_read_only_with(&backend).err(), Some(expected));
        }
    }

    #[test]
    fn releases_every_acquired_resource_when_the_last_step_fails() {
        let backend = MockBackend::new(Some(Failure::DefaultDaclSet));
        assert_eq!(
            create_read_only_with(&backend).err(),
            Some(SandboxError::DefaultDaclSet)
        );
        let mut drops = backend.drops.borrow().clone();
        drops.sort_unstable();
        assert_eq!(
            drops,
            [
                "current-token",
                "default-dacl",
                "everyone-sid",
                "logon-sid",
                "low-sid",
                "restricted-token",
            ]
        );
    }
}
