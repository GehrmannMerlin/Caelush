use super::error::SandboxError;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Security::Cryptography::{
    BCryptCloseAlgorithmProvider, BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash,
    BCryptGetProperty, BCryptHashData, BCryptOpenAlgorithmProvider, BCRYPT_ALG_HANDLE,
    BCRYPT_HASH_HANDLE, BCRYPT_HASH_LENGTH, BCRYPT_OBJECT_LENGTH, BCRYPT_SHA256_ALGORITHM,
};

const CAPABILITY_IDENTIFIER_AUTHORITY: &str = "S-1-4";
const WORKSPACE_DOMAIN: &str = "caelush.workspace-write.v1";
const TEMP_DOMAIN: &str = "caelush.private-temp.v1";

pub fn workspace_capability_sid(canonical_root: &str) -> Result<String, SandboxError> {
    derive_capability_sid(WORKSPACE_DOMAIN, canonical_root)
}

pub fn temp_capability_sid(marker_id: &str) -> Result<String, SandboxError> {
    derive_capability_sid(TEMP_DOMAIN, marker_id)
}

fn derive_capability_sid(domain: &str, identity: &str) -> Result<String, SandboxError> {
    let normalized = normalize_identity(identity)?;
    let input = format!("{domain}\0{normalized}");
    let digest = sha256(input.as_bytes())?;
    let (digest_chunks, _) = digest.as_chunks::<4>();
    let subauthorities = digest_chunks
        .iter()
        .take(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    Ok(format!(
        "{CAPABILITY_IDENTIFIER_AUTHORITY}-{}",
        subauthorities
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join("-")
    ))
}

fn normalize_identity(identity: &str) -> Result<String, SandboxError> {
    let normalized = identity
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    if normalized.is_empty() || normalized.contains('\0') {
        return Err(SandboxError::CapabilitySidInput);
    }
    Ok(normalized)
}

fn sha256(input: &[u8]) -> Result<[u8; 32], SandboxError> {
    let mut algorithm: BCRYPT_ALG_HANDLE = null_mut();
    let status =
        unsafe { BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_SHA256_ALGORITHM, null(), 0) };
    if status != 0 || algorithm.is_null() {
        return Err(SandboxError::CapabilitySidHash);
    }
    let algorithm = AlgorithmProvider(algorithm);

    let mut object_length = 0u32;
    let mut returned = 0u32;
    let status = unsafe {
        BCryptGetProperty(
            algorithm.0,
            BCRYPT_OBJECT_LENGTH,
            (&mut object_length as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
            &mut returned,
            0,
        )
    };
    if status != 0 || returned != std::mem::size_of::<u32>() as u32 || object_length == 0 {
        return Err(SandboxError::CapabilitySidHash);
    }

    let mut hash: BCRYPT_HASH_HANDLE = null_mut();
    let mut hash_object = vec![0u8; object_length as usize];
    let status = unsafe {
        BCryptCreateHash(
            algorithm.0,
            &mut hash,
            hash_object.as_mut_ptr(),
            hash_object.len() as u32,
            null(),
            0,
            0,
        )
    };
    if status != 0 || hash.is_null() {
        return Err(SandboxError::CapabilitySidHash);
    }
    let hash = HashHandle(hash);

    let status = unsafe { BCryptHashData(hash.0, input.as_ptr(), input.len() as u32, 0) };
    if status != 0 {
        return Err(SandboxError::CapabilitySidHash);
    }
    let mut digest = [0u8; 32];
    let status = unsafe { BCryptFinishHash(hash.0, digest.as_mut_ptr(), digest.len() as u32, 0) };
    if status != 0 {
        return Err(SandboxError::CapabilitySidHash);
    }
    let mut digest_length = 0u32;
    let status = unsafe {
        BCryptGetProperty(
            algorithm.0,
            BCRYPT_HASH_LENGTH,
            (&mut digest_length as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
            &mut returned,
            0,
        )
    };
    if status != 0 || digest_length != digest.len() as u32 {
        return Err(SandboxError::CapabilitySidHash);
    }
    Ok(digest)
}

struct AlgorithmProvider(BCRYPT_ALG_HANDLE);

impl Drop for AlgorithmProvider {
    fn drop(&mut self) {
        unsafe {
            BCryptCloseAlgorithmProvider(self.0, 0);
        }
    }
}

struct HashHandle(BCRYPT_HASH_HANDLE);

impl Drop for HashHandle {
    fn drop(&mut self) {
        unsafe {
            BCryptDestroyHash(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{temp_capability_sid, workspace_capability_sid};

    #[test]
    fn derives_stable_case_normalized_workspace_capability_sids() {
        let upper = workspace_capability_sid(r"C:\Users\测试\Workspace")
            .expect("workspace SID should derive");
        let lower = workspace_capability_sid(r"c:/users/测试/workspace")
            .expect("workspace SID should derive");
        assert_eq!(upper, lower);
        assert!(is_capability_sid(&upper));
    }

    #[test]
    fn separates_workspace_paths_and_private_temp_markers() {
        let workspace =
            workspace_capability_sid(r"C:\workspace").expect("workspace SID should derive");
        let other_workspace =
            workspace_capability_sid(r"C:\other-workspace").expect("workspace SID should derive");
        let temp_one = temp_capability_sid("run-0001").expect("temp SID should derive");
        let temp_two = temp_capability_sid("run-0002").expect("temp SID should derive");

        assert_ne!(workspace, other_workspace);
        assert_ne!(temp_one, temp_two);
        assert_ne!(workspace, temp_one);
        assert!(is_capability_sid(&temp_one));
    }

    fn is_capability_sid(value: &str) -> bool {
        let mut parts = value.split('-');
        if parts.next() != Some("S") || parts.next() != Some("1") || parts.next() != Some("4") {
            return false;
        }
        let subauthorities: Vec<_> = parts.collect();
        subauthorities.len() == 4
            && subauthorities
                .iter()
                .all(|part| part.parse::<u32>().is_ok())
    }
}
