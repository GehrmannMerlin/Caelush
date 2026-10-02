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
    if !metadata.is_dir() {
        return Err(SandboxError::PathBoundaryInvalid);
    }
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(SandboxError::PathBoundaryReparse);
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
    use super::validate_workspace_and_temp;
    use std::fs::{self, File};
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn rejects_reparse_directories_when_the_host_allows_test_symlinks() {
        let root = test_root("reparse");
        let target = root.join("target");
        let link = root.join("link");
        fs::create_dir_all(&target).expect("target directory should be created");
        if std::os::windows::fs::symlink_dir(&target, &link).is_ok() {
            assert!(validate_workspace_and_temp(&link, None).is_err());
        }
        cleanup(&root);
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
