#[cfg(test)]
mod tests {
    use super::{merge_exact_grant, AccessGrantEntry, GrantChange, WRITE_GRANT_INHERITANCE};

    const CAPABILITY_SID: &str = "S-1-4-101-202-303-404";
    const CUSTOM_SID: &str = "S-1-5-21-100-200-300-400";

    fn capability_entry() -> AccessGrantEntry {
        AccessGrantEntry {
            sid: CAPABILITY_SID.to_string(),
            mask: super::WORKSPACE_WRITE_MASK,
            inheritance: WRITE_GRANT_INHERITANCE,
        }
    }

    #[test]
    fn exact_grant_is_added_without_replacing_user_entries() {
        let custom = AccessGrantEntry {
            sid: CUSTOM_SID.to_string(),
            mask: 0x0000_0001,
            inheritance: 0,
        };

        let (merged, change) = merge_exact_grant(std::slice::from_ref(&custom), capability_entry());

        assert_eq!(change, GrantChange::Added);
        assert_eq!(merged.len(), 2);
        assert!(merged.contains(&custom));
        assert!(merged.iter().any(|entry| entry.sid == CAPABILITY_SID));
    }

    #[test]
    fn repeated_prepare_is_idempotent() {
        let desired = capability_entry();
        let (once, first_change) = merge_exact_grant(&[], desired.clone());
        let (twice, second_change) = merge_exact_grant(&once, desired);

        assert_eq!(first_change, GrantChange::Added);
        assert_eq!(second_change, GrantChange::Unchanged);
        assert_eq!(once, twice);
    }

    #[test]
    fn revoke_removes_only_the_exact_product_grant() {
        let desired = capability_entry();
        let custom_same_sid = AccessGrantEntry {
            sid: CAPABILITY_SID.to_string(),
            mask: 0x0000_0001,
            inheritance: 0,
        };
        let entries = vec![desired.clone(), custom_same_sid.clone()];

        let (remaining, change) = super::revoke_exact_grant(&entries, &desired);

        assert_eq!(change, GrantChange::Removed);
        assert_eq!(remaining, vec![custom_same_sid]);
    }
}
use super::error::SandboxError;
use super::handle::OwnedLocal;
use super::path_lock::PathLockRegistry;
use super::sid::{KnownSid, OwnedSid};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_PRIVILEGE_NOT_HELD,
    ERROR_SUCCESS, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AddAce, EqualSid, GetAce, GetAclInformation, InitializeAcl, ACCESS_ALLOWED_ACE,
    ACCESS_DENIED_ACE, ACE_HEADER, ACL, ACL_REVISION_DS, ACL_SIZE_INFORMATION,
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, LABEL_SECURITY_INFORMATION,
    OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, SYSTEM_MANDATORY_LABEL_ACE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ALL_ACCESS, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING, WRITE_OWNER,
};
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, SYSTEM_MANDATORY_LABEL_ACE_TYPE,
    SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
};

pub const WORKSPACE_WRITE_MASK: u32 = FILE_ALL_ACCESS;
pub const WRITE_GRANT_INHERITANCE: u32 = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
const FILE_DELETE_CHILD_MASK: u32 = 0x0000_0040;
const AMBIENT_DELETE_DENY_INHERITANCE: u32 = CONTAINER_INHERIT_ACE;
const LOW_LABEL_INHERITANCE: u32 = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessGrantEntry {
    pub sid: String,
    pub mask: u32,
    pub inheritance: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AccessDenyEntry {
    mask: u32,
    inheritance: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantChange {
    Added,
    Unchanged,
    Removed,
    NotFound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantStatus {
    Ready,
    Missing,
}

#[cfg(test)]
pub fn merge_exact_grant(
    entries: &[AccessGrantEntry],
    desired: AccessGrantEntry,
) -> (Vec<AccessGrantEntry>, GrantChange) {
    if entries.iter().any(|entry| entry == &desired) {
        return (entries.to_vec(), GrantChange::Unchanged);
    }
    let mut merged = entries.to_vec();
    merged.push(desired);
    (merged, GrantChange::Added)
}

#[cfg(test)]
pub fn revoke_exact_grant(
    entries: &[AccessGrantEntry],
    desired: &AccessGrantEntry,
) -> (Vec<AccessGrantEntry>, GrantChange) {
    let mut removed = false;
    let remaining = entries
        .iter()
        .filter(|entry| {
            if *entry == desired {
                removed = true;
                false
            } else {
                true
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    (
        remaining,
        if removed {
            GrantChange::Removed
        } else {
            GrantChange::NotFound
        },
    )
}

pub fn inspect_write_grant(path: &Path, capability_sid: &str) -> Result<GrantStatus, SandboxError> {
    let target = OwnedSid::from_string(capability_sid)?;
    let security = read_security(path)?;
    let desired = desired_grant(capability_sid);
    let everyone_sid = OwnedSid::known(KnownSid::Everyone)?;
    let desired_deny = desired_ambient_delete_deny();
    let low_sid = low_integrity_sid()?;
    let ready = acl_has_exact_grant(security.dacl, target.as_psid(), &desired)?
        && acl_has_exact_deny(security.dacl, everyone_sid.as_psid(), &desired_deny)?
        && sacl_has_low_write_barrier(security.sacl, low_sid.as_psid())?;
    Ok(if ready {
        GrantStatus::Ready
    } else {
        GrantStatus::Missing
    })
}

pub fn ensure_write_grant(path: &Path, capability_sid: &str) -> Result<GrantChange, SandboxError> {
    let registry = acl_path_locks();
    registry.with_lock(path, || ensure_write_grant_locked(path, capability_sid))
}

pub fn revoke_write_grant(path: &Path, capability_sid: &str) -> Result<GrantChange, SandboxError> {
    let registry = acl_path_locks();
    registry.with_lock(path, || revoke_write_grant_locked(path, capability_sid))
}

fn ensure_write_grant_locked(
    path: &Path,
    capability_sid: &str,
) -> Result<GrantChange, SandboxError> {
    let target = OwnedSid::from_string(capability_sid)?;
    let everyone_sid = OwnedSid::known(KnownSid::Everyone)?;
    let low_sid = low_integrity_sid()?;
    let security = read_security(path)?;
    let desired = desired_grant(capability_sid);
    let desired_deny = desired_ambient_delete_deny();
    let grant_ready = acl_has_exact_grant(security.dacl, target.as_psid(), &desired)?;
    let deny_ready = acl_has_exact_deny(security.dacl, everyone_sid.as_psid(), &desired_deny)?;
    let label_ready = sacl_has_low_write_barrier(security.sacl, low_sid.as_psid())?;
    if grant_ready && deny_ready && label_ready {
        return Ok(GrantChange::Unchanged);
    }

    // Always build the final DACL when anything is missing. If the integrity label needs repair,
    // this also gives us the original product DACL to restore after the temporary owner grant.
    let dacl = build_dacl(
        security.dacl,
        (!grant_ready).then_some((target.as_psid(), &desired)),
        (!deny_ready).then_some((everyone_sid.as_psid(), &desired_deny)),
        None,
        None,
    )?;
    let sacl = if label_ready {
        None
    } else {
        Some(build_low_integrity_sacl(security.sacl, low_sid.as_psid())?)
    };

    // The directory owner has implicit WRITE_DAC, but Windows requires WRITE_OWNER when setting
    // LABEL_SECURITY_INFORMATION. Give only the descriptor owner a non-inheriting WRITE_OWNER
    // ACE for this directory while applying the SACL, then replace it with `dacl` below.
    let temporary_owner_dacl = if sacl.is_some() {
        match require_write_owner(path) {
            Ok(()) => None,
            Err(SandboxError::WorkspaceWriteOwnerRequired) => {
                if security.owner.is_null() {
                    return Err(SandboxError::AclRead);
                }
                let owner = AccessGrantEntry {
                    sid: sid_to_string(security.owner)?,
                    mask: WRITE_OWNER,
                    inheritance: 0,
                };
                let temporary = build_dacl(
                    security.dacl,
                    Some((security.owner, &owner)),
                    None,
                    None,
                    None,
                )?;
                if let Err(error) = apply_dacl(path, &temporary) {
                    return rollback_dacl(path, &security, error);
                }
                if let Err(error) = require_write_owner(path) {
                    return rollback_dacl(path, &security, error);
                }
                Some(temporary)
            }
            Err(error) => return Err(error),
        }
    } else {
        None
    };

    // Install the integrity barrier before exposing a newly added capability grant.
    if let Some(sacl) = sacl.as_ref() {
        if let Err(error) = apply_label(path, sacl) {
            return rollback_security(path, &security, error);
        }
    }
    if let Err(error) = apply_dacl(path, &dacl) {
        return if temporary_owner_dacl.is_some() || sacl.is_some() {
            rollback_security(path, &security, error)
        } else {
            Err(error)
        };
    }
    match inspect_write_grant(path, capability_sid) {
        Ok(GrantStatus::Ready) => {}
        Ok(GrantStatus::Missing) => {
            return rollback_security(
                path,
                &security,
                SandboxError::WorkspaceSecurityPostcondition,
            )
        }
        Err(error) => return rollback_security(path, &security, error),
    }
    Ok(GrantChange::Added)
}

fn revoke_write_grant_locked(
    path: &Path,
    capability_sid: &str,
) -> Result<GrantChange, SandboxError> {
    let target = OwnedSid::from_string(capability_sid)?;
    let everyone_sid = OwnedSid::known(KnownSid::Everyone)?;
    let low_sid = low_integrity_sid()?;
    let security = read_security(path)?;
    let desired = desired_grant(capability_sid);
    let desired_deny = desired_ambient_delete_deny();
    if !acl_has_exact_grant(security.dacl, target.as_psid(), &desired)? {
        return Ok(GrantChange::NotFound);
    }

    let grant_removed_dacl = build_dacl(
        security.dacl,
        None,
        None,
        Some((target.as_psid(), &desired)),
        None,
    )?;
    let product_grant_remains = dacl_has_product_grant(grant_removed_dacl.as_ptr())?;
    let deny_present = acl_has_exact_deny(security.dacl, everyone_sid.as_psid(), &desired_deny)?;
    let remove_shared_deny = !product_grant_remains && deny_present;
    let dacl = if remove_shared_deny {
        build_dacl(
            security.dacl,
            None,
            None,
            Some((target.as_psid(), &desired)),
            Some((everyone_sid.as_psid(), &desired_deny)),
        )?
    } else {
        grant_removed_dacl
    };
    let sacl = if product_grant_remains {
        None
    } else if sacl_has_low_write_barrier(security.sacl, low_sid.as_psid())? {
        Some(remove_low_integrity_sacl(security.sacl)?)
    } else {
        None
    };
    if sacl.is_some() {
        require_write_owner(path)?;
    }
    apply_dacl(path, &dacl)?;
    if let Some(sacl) = sacl.as_ref() {
        apply_label(path, sacl)?;
    }
    Ok(GrantChange::Removed)
}

fn desired_grant(sid: &str) -> AccessGrantEntry {
    AccessGrantEntry {
        sid: sid.to_string(),
        mask: WORKSPACE_WRITE_MASK,
        inheritance: WRITE_GRANT_INHERITANCE,
    }
}

fn desired_ambient_delete_deny() -> AccessDenyEntry {
    AccessDenyEntry {
        mask: FILE_DELETE_CHILD_MASK,
        inheritance: AMBIENT_DELETE_DENY_INHERITANCE,
    }
}

fn acl_path_locks() -> &'static PathLockRegistry {
    static REGISTRY: OnceLock<PathLockRegistry> = OnceLock::new();
    REGISTRY.get_or_init(PathLockRegistry::default)
}

struct SecuritySnapshot {
    _descriptor: OwnedLocal<u8>,
    owner: windows_sys::Win32::Security::PSID,
    dacl: *mut ACL,
    sacl: *mut ACL,
}

fn read_security(path: &Path) -> Result<SecuritySnapshot, SandboxError> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut sacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            &mut sacl,
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS || descriptor.is_null() {
        drop_local_security_descriptor(descriptor);
        return Err(SandboxError::AclRead);
    }
    let descriptor =
        unsafe { OwnedLocal::<u8>::from_raw(descriptor.cast(), SandboxError::AclRead.code()) }
            .map_err(|_| SandboxError::AclRead)?;
    Ok(SecuritySnapshot {
        _descriptor: descriptor,
        owner,
        dacl,
        sacl,
    })
}

fn apply_dacl(path: &Path, dacl: &AclBuffer) -> Result<(), SandboxError> {
    apply_dacl_ptr(path, dacl.as_ptr())
}

fn apply_dacl_ptr(path: &Path, dacl: *const ACL) -> Result<(), SandboxError> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(SandboxError::AclDaclApply);
    }
    Ok(())
}

fn apply_label(path: &Path, sacl: &AclBuffer) -> Result<(), SandboxError> {
    apply_label_ptr(path, sacl.as_ptr())
}

fn apply_label_ptr(path: &Path, sacl: *const ACL) -> Result<(), SandboxError> {
    let wide = wide_path(path);
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            LABEL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null(),
            sacl,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(
            if status == ERROR_ACCESS_DENIED || status == ERROR_PRIVILEGE_NOT_HELD {
                SandboxError::WorkspaceWriteOwnerRequired
            } else {
                SandboxError::AclLabelApply
            },
        );
    }
    Ok(())
}

fn rollback_dacl(
    path: &Path,
    security: &SecuritySnapshot,
    original_error: SandboxError,
) -> Result<GrantChange, SandboxError> {
    if apply_dacl_ptr(path, security.dacl).is_err() {
        return Err(SandboxError::WorkspaceSecurityPostcondition);
    }
    Err(original_error)
}

fn rollback_security(
    path: &Path,
    security: &SecuritySnapshot,
    original_error: SandboxError,
) -> Result<GrantChange, SandboxError> {
    match require_write_owner(path) {
        Ok(()) => {}
        Err(SandboxError::WorkspaceWriteOwnerRequired) if !security.owner.is_null() => {
            let current = match read_security(path) {
                Ok(current) => current,
                Err(_) => return Err(SandboxError::WorkspaceSecurityPostcondition),
            };
            let owner_grant = match sid_to_string(security.owner) {
                Ok(sid) => AccessGrantEntry {
                    sid,
                    mask: WRITE_OWNER,
                    inheritance: 0,
                },
                Err(_) => return Err(SandboxError::WorkspaceSecurityPostcondition),
            };
            let temporary = match build_dacl(
                current.dacl,
                Some((security.owner, &owner_grant)),
                None,
                None,
                None,
            ) {
                Ok(temporary) => temporary,
                Err(_) => return Err(SandboxError::WorkspaceSecurityPostcondition),
            };
            if apply_dacl(path, &temporary).is_err() || require_write_owner(path).is_err() {
                let _ = apply_dacl_ptr(path, security.dacl);
                return Err(SandboxError::WorkspaceSecurityPostcondition);
            }
        }
        Err(_) => return Err(SandboxError::WorkspaceSecurityPostcondition),
    }

    let label_restored = apply_label_ptr(path, security.sacl).is_ok();
    let dacl_restored = apply_dacl_ptr(path, security.dacl).is_ok();
    if label_restored && dacl_restored {
        Err(original_error)
    } else {
        Err(SandboxError::WorkspaceSecurityPostcondition)
    }
}

fn require_write_owner(path: &Path) -> Result<(), SandboxError> {
    let wide = wide_path(path);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        let error = unsafe { GetLastError() };
        return Err(
            if error == ERROR_ACCESS_DENIED || error == ERROR_PRIVILEGE_NOT_HELD {
                SandboxError::WorkspaceWriteOwnerRequired
            } else {
                SandboxError::AclLabelApply
            },
        );
    }
    unsafe {
        CloseHandle(handle);
    }
    Ok(())
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn sid_to_string(sid: windows_sys::Win32::Security::PSID) -> Result<String, SandboxError> {
    let mut string_sid = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut string_sid) } == 0 || string_sid.is_null() {
        drop_local_string_sid(string_sid);
        return Err(SandboxError::AclSid);
    }
    let owned = unsafe { OwnedLocal::<u16>::from_raw(string_sid, SandboxError::AclSid.code()) }
        .map_err(|_| SandboxError::AclSid)?;
    let mut length = 0usize;
    unsafe {
        while *owned.as_ptr().add(length) != 0 {
            length += 1;
        }
        Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
            owned.as_ptr(),
            length,
        )))
    }
}

fn low_integrity_sid() -> Result<OwnedSid, SandboxError> {
    OwnedSid::known(KnownSid::LowIntegrity)
}

fn acl_has_exact_grant(
    acl: *const ACL,
    target_sid: windows_sys::Win32::Security::PSID,
    desired: &AccessGrantEntry,
) -> Result<bool, SandboxError> {
    for_each_ace(acl, |header, raw| {
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 {
            return Ok(false);
        }
        let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
        let sid = std::ptr::addr_of!(ace.SidStart)
            .cast::<u8>()
            .cast_mut()
            .cast();
        Ok(ace.Mask == desired.mask
            && header.AceFlags as u32 == desired.inheritance
            && unsafe { EqualSid(sid, target_sid) != 0 })
    })
}

fn acl_has_exact_deny(
    acl: *const ACL,
    target_sid: windows_sys::Win32::Security::PSID,
    desired: &AccessDenyEntry,
) -> Result<bool, SandboxError> {
    for_each_ace(acl, |header, raw| {
        if header.AceType != ACCESS_DENIED_ACE_TYPE as u8 {
            return Ok(false);
        }
        let ace = unsafe { &*raw.cast::<ACCESS_DENIED_ACE>() };
        let sid = std::ptr::addr_of!(ace.SidStart)
            .cast::<u8>()
            .cast_mut()
            .cast();
        Ok(ace.Mask == desired.mask
            && header.AceFlags as u32 == desired.inheritance
            && unsafe { EqualSid(sid, target_sid) != 0 })
    })
}

fn dacl_has_product_grant(acl: *const ACL) -> Result<bool, SandboxError> {
    for_each_ace(acl, |header, raw| {
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 {
            return Ok(false);
        }
        let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Mask != WORKSPACE_WRITE_MASK || header.AceFlags as u32 != WRITE_GRANT_INHERITANCE {
            return Ok(false);
        }
        let sid = std::ptr::addr_of!(ace.SidStart)
            .cast::<u8>()
            .cast_mut()
            .cast();
        Ok(sid_is_product_capability(sid))
    })
}

fn sid_is_product_capability(sid: windows_sys::Win32::Security::PSID) -> bool {
    let mut string_sid = null_mut();
    let converted = unsafe { ConvertSidToStringSidW(sid, &mut string_sid) };
    if converted == 0 || string_sid.is_null() {
        drop_local_string_sid(string_sid);
        return false;
    }
    let value = unsafe {
        let mut length = 0usize;
        while *string_sid.add(length) != 0 {
            length += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(string_sid, length))
    };
    drop_local_string_sid(string_sid);
    value.starts_with("S-1-4-") || value.starts_with("S-1-15-3-")
}

fn sacl_has_low_write_barrier(
    acl: *const ACL,
    low_sid: windows_sys::Win32::Security::PSID,
) -> Result<bool, SandboxError> {
    for_each_ace(acl, |header, raw| {
        if header.AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE as u8 {
            return Ok(false);
        }
        let ace = unsafe { &*raw.cast::<SYSTEM_MANDATORY_LABEL_ACE>() };
        let sid = std::ptr::addr_of!(ace.SidStart)
            .cast::<u8>()
            .cast_mut()
            .cast();
        Ok(ace.Mask == SYSTEM_MANDATORY_LABEL_NO_WRITE_UP
            && header.AceFlags as u32 == LOW_LABEL_INHERITANCE
            && unsafe { EqualSid(sid, low_sid) != 0 })
    })
}

fn for_each_ace(
    acl: *const ACL,
    mut callback: impl FnMut(&ACE_HEADER, *mut core::ffi::c_void) -> Result<bool, SandboxError>,
) -> Result<bool, SandboxError> {
    if acl.is_null() {
        return Ok(false);
    }
    let information = acl_information(acl)?;
    for index in 0..information.AceCount {
        let mut raw = null_mut();
        if unsafe { GetAce(acl, index, &mut raw) } == 0 || raw.is_null() {
            return Err(SandboxError::AclRead);
        }
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        if callback(header, raw)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn acl_information(acl: *const ACL) -> Result<ACL_SIZE_INFORMATION, SandboxError> {
    let mut information = ACL_SIZE_INFORMATION::default();
    let queried = unsafe {
        GetAclInformation(
            acl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            windows_sys::Win32::Security::AclSizeInformation,
        )
    };
    if queried == 0 {
        return Err(SandboxError::AclRead);
    }
    Ok(information)
}

struct AclBuffer {
    data: Vec<u8>,
}

impl AclBuffer {
    fn new(size: usize) -> Result<Self, SandboxError> {
        let size = size.max(size_of::<ACL>() + 8);
        if size > u16::MAX as usize {
            return Err(SandboxError::AclBuild);
        }
        let mut data = vec![0u8; size];
        if unsafe { InitializeAcl(data.as_mut_ptr().cast(), size as u32, ACL_REVISION_DS) } == 0 {
            return Err(SandboxError::AclBuild);
        }
        Ok(Self { data })
    }

    fn as_ptr(&self) -> *const ACL {
        self.data.as_ptr().cast()
    }

    fn as_mut_ptr(&mut self) -> *mut ACL {
        self.data.as_mut_ptr().cast()
    }
}

fn build_dacl(
    old: *const ACL,
    add_grant: Option<(windows_sys::Win32::Security::PSID, &AccessGrantEntry)>,
    add_deny: Option<(windows_sys::Win32::Security::PSID, &AccessDenyEntry)>,
    remove_grant: Option<(windows_sys::Win32::Security::PSID, &AccessGrantEntry)>,
    remove_deny: Option<(windows_sys::Win32::Security::PSID, &AccessDenyEntry)>,
) -> Result<AclBuffer, SandboxError> {
    let old_size = if old.is_null() {
        size_of::<ACL>()
    } else {
        let size = unsafe { (*old).AclSize } as usize;
        if size < size_of::<ACL>() {
            return Err(SandboxError::AclRead);
        }
        size
    };
    let additional = add_grant
        .map(|(sid, _)| sid_length(sid).map(|length| aligned_ace_size(8 + length)))
        .transpose()?
        .unwrap_or(0)
        + add_deny
            .map(|(sid, _)| sid_length(sid).map(|length| aligned_ace_size(8 + length)))
            .transpose()?
            .unwrap_or(0);
    let mut buffer = AclBuffer::new(old_size + additional + 8)?;
    append_filtered_aces(&mut buffer, old, remove_grant, remove_deny)?;
    if let Some((sid, desired)) = add_deny {
        let ace = access_denied_ace(sid, desired)?;
        append_ace(&mut buffer, ace.as_ptr().cast(), ace.len())?;
    }
    if let Some((sid, desired)) = add_grant {
        let ace = access_allowed_ace(sid, desired)?;
        append_ace(&mut buffer, ace.as_ptr().cast(), ace.len())?;
    }
    Ok(buffer)
}

fn build_low_integrity_sacl(
    old: *const ACL,
    low_sid: windows_sys::Win32::Security::PSID,
) -> Result<AclBuffer, SandboxError> {
    let old_size = acl_size_or_header(old)?;
    let additional = aligned_ace_size(8 + sid_length(low_sid)?);
    let mut buffer = AclBuffer::new(old_size + additional + 8)?;
    append_non_label_aces(&mut buffer, old)?;
    let ace = mandatory_label_ace(low_sid)?;
    append_ace(&mut buffer, ace.as_ptr().cast(), ace.len())?;
    Ok(buffer)
}

fn remove_low_integrity_sacl(old: *const ACL) -> Result<AclBuffer, SandboxError> {
    let mut buffer = AclBuffer::new(acl_size_or_header(old)? + 8)?;
    append_non_label_aces(&mut buffer, old)?;
    Ok(buffer)
}

fn append_filtered_aces(
    destination: &mut AclBuffer,
    old: *const ACL,
    remove_grant: Option<(windows_sys::Win32::Security::PSID, &AccessGrantEntry)>,
    remove_deny: Option<(windows_sys::Win32::Security::PSID, &AccessDenyEntry)>,
) -> Result<(), SandboxError> {
    append_aces(destination, old, |header, raw| {
        if let Some((sid, desired)) = remove_grant {
            if header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8 {
                let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
                let entry_sid = std::ptr::addr_of!(ace.SidStart)
                    .cast::<u8>()
                    .cast_mut()
                    .cast();
                if ace.Mask == desired.mask
                    && header.AceFlags as u32 == desired.inheritance
                    && unsafe { EqualSid(entry_sid, sid) != 0 }
                {
                    return Ok(false);
                }
            }
        }
        if let Some((sid, desired)) = remove_deny {
            if header.AceType == ACCESS_DENIED_ACE_TYPE as u8 {
                let ace = unsafe { &*raw.cast::<ACCESS_DENIED_ACE>() };
                let entry_sid = std::ptr::addr_of!(ace.SidStart)
                    .cast::<u8>()
                    .cast_mut()
                    .cast();
                if ace.Mask == desired.mask
                    && header.AceFlags as u32 == desired.inheritance
                    && unsafe { EqualSid(entry_sid, sid) != 0 }
                {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    })
}

fn append_non_label_aces(destination: &mut AclBuffer, old: *const ACL) -> Result<(), SandboxError> {
    append_aces(destination, old, |header, _| {
        Ok(header.AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE as u8)
    })
}

fn append_aces(
    destination: &mut AclBuffer,
    old: *const ACL,
    keep: impl Fn(&ACE_HEADER, *mut core::ffi::c_void) -> Result<bool, SandboxError>,
) -> Result<(), SandboxError> {
    if old.is_null() {
        return Ok(());
    }
    let information = acl_information(old)?;
    for index in 0..information.AceCount {
        let mut raw = null_mut();
        if unsafe { GetAce(old, index, &mut raw) } == 0 || raw.is_null() {
            return Err(SandboxError::AclRead);
        }
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        if keep(header, raw)? {
            append_ace(destination, raw, header.AceSize as usize)?;
        }
    }
    Ok(())
}

fn append_ace(
    destination: &mut AclBuffer,
    ace: *const core::ffi::c_void,
    length: usize,
) -> Result<(), SandboxError> {
    if unsafe {
        AddAce(
            destination.as_mut_ptr(),
            ACL_REVISION_DS,
            u32::MAX,
            ace,
            length as u32,
        )
    } == 0
    {
        return Err(SandboxError::AclBuild);
    }
    Ok(())
}

fn access_allowed_ace(
    sid: windows_sys::Win32::Security::PSID,
    desired: &AccessGrantEntry,
) -> Result<Vec<u8>, SandboxError> {
    let length = aligned_ace_size(8 + sid_length(sid)?);
    let mut bytes = vec![0u8; length];
    let ace = bytes.as_mut_ptr().cast::<ACCESS_ALLOWED_ACE>();
    unsafe {
        (*ace).Header = ACE_HEADER {
            AceType: ACCESS_ALLOWED_ACE_TYPE as u8,
            AceFlags: desired.inheritance as u8,
            AceSize: length as u16,
        };
        (*ace).Mask = desired.mask;
        std::ptr::copy_nonoverlapping(
            sid.cast::<u8>(),
            std::ptr::addr_of_mut!((*ace).SidStart).cast::<u8>(),
            sid_length(sid)?,
        );
    }
    Ok(bytes)
}

fn access_denied_ace(
    sid: windows_sys::Win32::Security::PSID,
    desired: &AccessDenyEntry,
) -> Result<Vec<u8>, SandboxError> {
    let length = aligned_ace_size(8 + sid_length(sid)?);
    let mut bytes = vec![0u8; length];
    let ace = bytes.as_mut_ptr().cast::<ACCESS_DENIED_ACE>();
    unsafe {
        (*ace).Header = ACE_HEADER {
            AceType: ACCESS_DENIED_ACE_TYPE as u8,
            AceFlags: desired.inheritance as u8,
            AceSize: length as u16,
        };
        (*ace).Mask = desired.mask;
        std::ptr::copy_nonoverlapping(
            sid.cast::<u8>(),
            std::ptr::addr_of_mut!((*ace).SidStart).cast::<u8>(),
            sid_length(sid)?,
        );
    }
    Ok(bytes)
}

fn mandatory_label_ace(
    low_sid: windows_sys::Win32::Security::PSID,
) -> Result<Vec<u8>, SandboxError> {
    let length = aligned_ace_size(8 + sid_length(low_sid)?);
    let mut bytes = vec![0u8; length];
    let ace = bytes.as_mut_ptr().cast::<SYSTEM_MANDATORY_LABEL_ACE>();
    unsafe {
        (*ace).Header = ACE_HEADER {
            AceType: SYSTEM_MANDATORY_LABEL_ACE_TYPE as u8,
            AceFlags: LOW_LABEL_INHERITANCE as u8,
            AceSize: length as u16,
        };
        (*ace).Mask = SYSTEM_MANDATORY_LABEL_NO_WRITE_UP;
        std::ptr::copy_nonoverlapping(
            low_sid.cast::<u8>(),
            std::ptr::addr_of_mut!((*ace).SidStart).cast::<u8>(),
            sid_length(low_sid)?,
        );
    }
    Ok(bytes)
}

fn sid_length(sid: windows_sys::Win32::Security::PSID) -> Result<usize, SandboxError> {
    if sid.is_null() {
        return Err(SandboxError::AclSid);
    }
    let length = unsafe { windows_sys::Win32::Security::GetLengthSid(sid) } as usize;
    if length == 0 {
        return Err(SandboxError::AclSid);
    }
    Ok(length)
}

fn aligned_ace_size(size: usize) -> usize {
    (size + 3) & !3
}

fn acl_size_or_header(acl: *const ACL) -> Result<usize, SandboxError> {
    if acl.is_null() {
        return Ok(size_of::<ACL>());
    }
    let size = unsafe { (*acl).AclSize } as usize;
    if size < size_of::<ACL>() {
        return Err(SandboxError::AclRead);
    }
    Ok(size)
}

fn drop_local_security_descriptor(pointer: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR) {
    if !pointer.is_null() {
        unsafe {
            LocalFree(pointer.cast());
        }
    }
}

fn drop_local_string_sid(pointer: windows_sys::core::PWSTR) {
    if !pointer.is_null() {
        unsafe {
            LocalFree(pointer.cast());
        }
    }
}

#[cfg(test)]
mod integration_tests {
    use super::{
        ensure_write_grant, inspect_write_grant, revoke_write_grant, GrantChange, GrantStatus,
    };
    use crate::platform::windows::capability_sid::workspace_capability_sid;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let test_temp = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-temp");
            fs::create_dir_all(&test_temp).expect("test temp parent should be created");
            let path = test_temp.join(format!("caelush-acl-test-{suffix}"));
            fs::create_dir(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn real_acl_prepare_status_and_revoke_are_idempotent() {
        let directory = TempDirectory::new();
        let canonical = directory
            .path()
            .canonicalize()
            .expect("test path should canonicalize");
        let sid = workspace_capability_sid(&canonical.to_string_lossy())
            .expect("workspace capability SID should derive");

        assert_eq!(
            inspect_write_grant(directory.path(), &sid).expect("ACL should be inspectable"),
            GrantStatus::Missing
        );
        assert_eq!(
            ensure_write_grant(directory.path(), &sid).expect("ACL should be prepared"),
            GrantChange::Added
        );
        assert_eq!(
            inspect_write_grant(directory.path(), &sid)
                .expect("prepared ACL should be inspectable"),
            GrantStatus::Ready
        );
        assert_eq!(
            ensure_write_grant(directory.path(), &sid).expect("repeated prepare should succeed"),
            GrantChange::Unchanged
        );
        assert_eq!(
            revoke_write_grant(directory.path(), &sid).expect("ACL should be revoked"),
            GrantChange::Removed
        );
        assert_eq!(
            revoke_write_grant(directory.path(), &sid).expect("repeated revoke should succeed"),
            GrantChange::NotFound
        );
        assert_eq!(
            inspect_write_grant(directory.path(), &sid).expect("revoked ACL should be inspectable"),
            GrantStatus::Missing
        );
    }

    #[test]
    fn refuses_to_mutate_a_missing_path() {
        let directory = TempDirectory::new();
        let missing = directory.path().join("missing");
        let sid = "S-1-4-101-202-303-404";

        assert_eq!(
            ensure_write_grant(&missing, sid).err(),
            Some(crate::platform::windows::error::SandboxError::AclRead)
        );
    }
}
