use super::error::SandboxError;
use std::fs::{self, OpenOptions};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    volume_serial_number: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedPath {
    pub path: PathBuf,
    pub identity: FileIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedWorkspaceBoundary {
    pub workspace: ValidatedPath,
    pub temp: Option<ValidatedPath>,
}

pub fn validate_workspace_and_temp(
    workspace: &Path,
    temp: Option<&Path>,
) -> Result<ValidatedWorkspaceBoundary, SandboxError> {
    let workspace = validate_directory(workspace)?;
    let temp = temp.map(validate_directory).transpose()?;
    if let Some(temp) = temp.as_ref() {
        if workspace.path == temp.path
            || workspace.path.starts_with(&temp.path)
            || temp.path.starts_with(&workspace.path)
            || workspace.identity == temp.identity
        {
            return Err(SandboxError::PathBoundaryOverlap);
        }
    }
    Ok(ValidatedWorkspaceBoundary { workspace, temp })
}

fn validate_directory(path: &Path) -> Result<ValidatedPath, SandboxError> {
    if !path.is_absolute() {
        return Err(SandboxError::PathBoundaryInvalid);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| SandboxError::PathBoundaryInvalid)?;
    // The reparse test comes first, deliberately. A reparse point is refused whatever it points at,
    // and `Metadata::is_dir()` is false for a junction or a directory symlink because Rust classifies
    // both as symlinks. Testing directory-ness first therefore answered `PathBoundaryInvalid` for
    // precisely the paths this check exists to name, leaving `PathBoundaryReparse` reachable only
    // for reparse kinds Rust does not classify as symlinks - so the diagnosis an operator would see
    // for a junction said "invalid path" instead of "reparse points are unsupported here".
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(SandboxError::PathBoundaryReparse);
    }
    if !metadata.is_dir() {
        return Err(SandboxError::PathBoundaryInvalid);
    }

    let canonical = fs::canonicalize(path).map_err(|_| SandboxError::PathBoundaryInvalid)?;
    if is_filesystem_root(&canonical) {
        return Err(SandboxError::PathBoundaryUnsupportedRoot);
    }
    let first_identity = capture_identity(&canonical)?;
    let second_canonical = fs::canonicalize(path).map_err(|_| SandboxError::PathBoundaryInvalid)?;
    let second_identity = capture_identity(&second_canonical)?;
    if canonical != second_canonical || first_identity != second_identity {
        return Err(SandboxError::PathBoundaryIdentityChanged);
    }
    Ok(ValidatedPath {
        path: canonical,
        identity: first_identity,
    })
}

fn capture_identity(path: &Path) -> Result<FileIdentity, SandboxError> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|_| SandboxError::PathBoundaryInvalid)?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(directory.as_raw_handle(), &mut information) } == 0 {
        let _ = unsafe { GetLastError() };
        return Err(SandboxError::PathBoundaryInvalid);
    }
    Ok(FileIdentity {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index_high: information.nFileIndexHigh,
        file_index_low: information.nFileIndexLow,
    })
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().map(|parent| parent == path).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::{validate_workspace_and_temp, SandboxError};
    use std::fs::{self, File};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, HANDLE, GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;

    #[test]
    fn rejects_missing_files_and_files_that_are_not_directories() {
        let root = test_root("missing-and-file");
        fs::create_dir(&root).expect("test root should be created");
        let file = root.join("file.txt");
        File::create(&file).expect("test file should be created");

        assert!(validate_workspace_and_temp(&root.join("missing"), None).is_err());
        assert!(validate_workspace_and_temp(&file, None).is_err());
        cleanup(&root);
    }

    #[test]
    fn rejects_root_equal_and_parent_child_workspace_temp_boundaries() {
        let root = test_root("overlap");
        let workspace = root.join("workspace");
        let child = workspace.join("temp");
        let sibling = root.join("temp");
        fs::create_dir_all(&child).expect("test directories should be created");
        fs::create_dir(&sibling).expect("sibling directory should be created");

        assert!(validate_workspace_and_temp(Path::new(r"C:\"), None).is_err());
        assert!(validate_workspace_and_temp(&workspace, Some(&workspace)).is_err());
        assert!(validate_workspace_and_temp(&workspace, Some(&child)).is_err());
        assert!(validate_workspace_and_temp(&child, Some(&workspace)).is_err());
        assert!(validate_workspace_and_temp(&workspace, Some(&sibling)).is_ok());
        cleanup(&root);
    }

    /// A directory reparse point must be rejected, and the precondition must be *measured*.
    ///
    /// The earlier version of this test created a symlink and asserted the rejection only `if` the
    /// symlink call succeeded. That guard proves nothing on a host where `CreateSymbolicLinkW` is
    /// answered with success while an ordinary directory is materialised: the guard is true, no
    /// reparse point exists, and the test reports a reparse-handling defect that is not there.
    ///
    /// So this test builds a junction — the mechanism `mklink /J` uses, which needs no
    /// `SeCreateSymbolicLinkPrivilege` — reads the attributes back to confirm a reparse point
    /// genuinely exists, and only then asserts the rejection. A host that can produce neither a
    /// junction nor a real symlink fails here rather than passing for the wrong reason.
    #[test]
    fn rejects_a_directory_reparse_point_that_was_verified_to_exist() {
        let root = test_root("reparse");
        let target = root.join("target");
        let link = root.join("link");
        fs::create_dir_all(&target).expect("target directory should be created");

        let kind = create_verified_reparse_directory(&link, &target);

        // Non-vacuity: the rejections below must be about the reparse point rather than about a
        // validator that refuses every directory it is shown.
        assert!(
            validate_workspace_and_temp(&target, None).is_ok(),
            "an ordinary directory beside the {kind} must still be accepted"
        );
        assert_eq!(
            validate_workspace_and_temp(&link, None).err(),
            Some(SandboxError::PathBoundaryReparse),
            "a {kind} must not be usable as a workspace root"
        );
        assert_eq!(
            validate_workspace_and_temp(&target, Some(&link)).err(),
            Some(SandboxError::PathBoundaryReparse),
            "a {kind} must not be usable as a private temp root"
        );
        cleanup(&root);
    }

    /// Creates a directory reparse point and returns the kind that worked.
    ///
    /// Panics when the host produced no reparse point, naming what it did produce, because a
    /// reparse-point test that cannot create a reparse point is not a passing test.
    fn create_verified_reparse_directory(link: &Path, target: &Path) -> &'static str {
        let mut junction_error = None;
        let kind = match create_directory_junction(link, target) {
            Ok(()) => "junction",
            Err(error) => {
                // Junctions need no privilege, so this is already unusual; a symlink is the only
                // other reparse kind a test can ask for. Neither is a skip: both failing panics.
                junction_error = Some(error);
                std::os::windows::fs::symlink_dir(target, link).unwrap_or_else(|symlink_error| {
                    panic!(
                        "this host can create neither a directory junction \
                         ({}) nor a directory symlink ({symlink_error}), so reparse-point \
                         rejection cannot be measured",
                        junction_error.as_deref().unwrap_or_default()
                    )
                });
                "symlink"
            }
        };
        let attributes = fs::symlink_metadata(link)
            .expect("the created link should be queryable")
            .file_attributes();
        assert!(
            attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
            "the host produced no reparse point (attributes {attributes:#x}); the {kind} attempt \
             reported success{}",
            match junction_error.as_deref() {
                Some(error) => format!(", and the junction attempt failed with: {error}"),
                None => String::new(),
            }
        );
        kind
    }

    /// Creates a directory junction with `FSCTL_SET_REPARSE_POINT`, exactly as `mklink /J` does.
    fn create_directory_junction(link: &Path, target: &Path) -> Result<(), String> {
        fs::create_dir_all(link).map_err(|error| format!("create link directory: {error}"))?;
        let handle = unsafe {
            CreateFileW(
                wide(link).as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            discard_plain_link_directory(link);
            return Err(format!("CreateFileW failed with {code}"));
        }
        let result = write_mount_point_reparse_data(handle, target);
        unsafe { CloseHandle(handle) };
        if result.is_err() {
            discard_plain_link_directory(link);
        }
        result
    }

    /// Writes `IO_REPARSE_TAG_MOUNT_POINT` data that redirects `handle`'s directory to `target`.
    ///
    /// The two name offsets are relative to the start of the mount-point structure, which is why
    /// they are computed rather than assumed.
    fn write_mount_point_reparse_data(handle: HANDLE, target: &Path) -> Result<(), String> {
        let canonical = fs::canonicalize(target)
            .map_err(|error| format!("resolve junction target: {error}"))?;
        // `fs::canonicalize` answers with the verbatim `\\?\` form, which cannot be nested inside
        // the `\??\` prefix NT paths use - doing so is rejected as invalid reparse data. The
        // boundary validator already undoes that prefix before handing a path to a child, so reuse
        // that rule rather than writing a second copy of it that could drift.
        let normal = crate::platform::windows::process_current_directory(&canonical);
        let substitute = format!(r"\??\{}", normal.display())
            .encode_utf16()
            .collect::<Vec<_>>();
        let print = normal.display().to_string().encode_utf16().collect::<Vec<_>>();
        let substitute_bytes = u16::try_from(substitute.len() * 2)
            .map_err(|_| "junction target is too long for reparse data".to_string())?;
        let print_bytes = u16::try_from(print.len() * 2)
            .map_err(|_| "junction target is too long for reparse data".to_string())?;
        // Both names are NUL-terminated even though the lengths exclude the terminator.
        let data_length = 8 + substitute_bytes + 2 + print_bytes + 2;

        let mut buffer = Vec::with_capacity(8 + data_length as usize);
        buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        buffer.extend_from_slice(&data_length.to_le_bytes());
        buffer.extend_from_slice(&0u16.to_le_bytes());
        buffer.extend_from_slice(&0u16.to_le_bytes());
        buffer.extend_from_slice(&substitute_bytes.to_le_bytes());
        buffer.extend_from_slice(&(substitute_bytes + 2).to_le_bytes());
        buffer.extend_from_slice(&print_bytes.to_le_bytes());
        // Each name is NUL-terminated, and the terminator counts towards the data length even
        // though it is excluded from the name lengths. Omitting the inner terminator is rejected as
        // ERROR_INVALID_REPARSE_DATA rather than silently ignored.
        for unit in substitute.iter().chain(&[0]).chain(&print).chain(&[0]) {
            buffer.extend_from_slice(&unit.to_le_bytes());
        }

        let mut returned = 0u32;
        let written = unsafe {
            DeviceIoControl(
                handle,
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                null_mut(),
                0,
                &mut returned,
                null_mut(),
            )
        };
        if written == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!("DeviceIoControl failed with {code}"));
        }
        Ok(())
    }

    /// Removes only the plain, empty directory this fixture created.
    ///
    /// A path that has become a reparse point is deliberately left alone: deleting through a
    /// junction is exactly the operation the product refuses, and a test must not do it either.
    fn discard_plain_link_directory(link: &Path) {
        if let Ok(metadata) = fs::symlink_metadata(link) {
            if metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
                let _ = fs::remove_dir(link);
            }
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn test_root(label: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should follow the epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "caelush-phase4-{label}-{}-{suffix}",
            std::process::id()
        ))
    }

    fn cleanup(path: &Path) {
        if path.exists() {
            fs::remove_dir_all(path).expect("test root should be removable");
        }
    }
}
