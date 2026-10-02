use super::error::SandboxError;
use super::handle::OwnedHandle;
use std::mem::{size_of, size_of_val};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER};
use windows_sys::Win32::Security::{
    CreateWellKnownSid, GetLengthSid, GetTokenInformation, IsValidSid, TokenGroups, WinLowLabelSid,
    WinWorldSid, PSID, SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES, TOKEN_GROUPS,
};

const SE_GROUP_LOGON_ID: u32 = 0xc000_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KnownSid {
    Everyone,
    LowIntegrity,
}

#[derive(Debug)]
pub struct OwnedSid {
    bytes: Vec<u8>,
}

impl OwnedSid {
    pub fn known(kind: KnownSid) -> Result<Self, SandboxError> {
        let mut bytes = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut length = bytes.len() as u32;
        let sid_type = match kind {
            KnownSid::Everyone => WinWorldSid,
            KnownSid::LowIntegrity => WinLowLabelSid,
        };
        let created = unsafe {
            CreateWellKnownSid(sid_type, null_mut(), bytes.as_mut_ptr().cast(), &mut length)
        };
        if created == 0 || length == 0 || length as usize > bytes.len() {
            return Err(SandboxError::KnownSidCreate);
        }
        bytes.truncate(length as usize);
        Ok(Self { bytes })
    }

    pub fn logon_from_token(token: &OwnedHandle) -> Result<Self, SandboxError> {
        let mut required = 0u32;
        let queried = unsafe {
            GetTokenInformation(token.as_raw(), TokenGroups, null_mut(), 0, &mut required)
        };
        if queried != 0
            || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
            || required < size_of::<TOKEN_GROUPS>() as u32
        {
            return Err(SandboxError::TokenGroupsQuery);
        }

        let words = (required as usize).div_ceil(size_of::<usize>());
        let mut storage = vec![0usize; words];
        let queried = unsafe {
            GetTokenInformation(
                token.as_raw(),
                TokenGroups,
                storage.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        };
        if queried == 0 || required as usize > size_of_val(storage.as_slice()) {
            return Err(SandboxError::TokenGroupsQuery);
        }

        let groups = storage.as_ptr().cast::<TOKEN_GROUPS>();
        let count = unsafe { (*groups).GroupCount as usize };
        let entries_offset = size_of::<TOKEN_GROUPS>() - size_of::<SID_AND_ATTRIBUTES>();
        let available_entries =
            (required as usize - entries_offset) / size_of::<SID_AND_ATTRIBUTES>();
        if count == 0 || count > available_entries {
            return Err(SandboxError::TokenGroupsQuery);
        }
        let entries = unsafe { std::slice::from_raw_parts((*groups).Groups.as_ptr(), count) };
        let attributes: Vec<u32> = entries.iter().map(|entry| entry.Attributes).collect();
        let index = find_logon_sid_index(&attributes)?;
        Self::copy_from(entries[index].Sid)
    }

    pub fn as_psid(&self) -> PSID {
        self.bytes.as_ptr().cast_mut().cast()
    }

    pub fn length(&self) -> u32 {
        self.bytes.len() as u32
    }

    fn copy_from(sid: PSID) -> Result<Self, SandboxError> {
        if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            return Err(SandboxError::LogonSidMissing);
        }
        let length = unsafe { GetLengthSid(sid) } as usize;
        if length == 0 || length > SECURITY_MAX_SID_SIZE as usize {
            return Err(SandboxError::LogonSidMissing);
        }
        let bytes = unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), length) }.to_vec();
        Ok(Self { bytes })
    }
}

pub fn find_logon_sid_index(attributes: &[u32]) -> Result<usize, SandboxError> {
    attributes
        .iter()
        .position(|attributes| attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID)
        .ok_or(SandboxError::LogonSidMissing)
}

#[cfg(test)]
mod tests {
    use super::{find_logon_sid_index, SandboxError, SE_GROUP_LOGON_ID};

    #[test]
    fn finds_the_logon_sid_without_accepting_partial_attribute_matches() {
        assert_eq!(
            find_logon_sid_index(&[0x0000_0004, SE_GROUP_LOGON_ID, 0x0000_0020]),
            Ok(1)
        );
        assert_eq!(
            find_logon_sid_index(&[0x4000_0000, 0x8000_0000]),
            Err(SandboxError::LogonSidMissing)
        );
    }
}
