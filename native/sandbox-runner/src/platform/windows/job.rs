use super::error::SandboxError;
use super::handle::OwnedHandle;
use std::mem::size_of;
use std::ptr::null;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[derive(Debug)]
pub struct JobObject(OwnedHandle);

impl JobObject {
    pub fn create() -> Result<Self, SandboxError> {
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        unsafe { OwnedHandle::from_raw(raw, SandboxError::JobCreate.code()) }
            .map(Self)
            .map_err(|_| SandboxError::JobCreate)
    }

    pub fn configure_kill_on_close(&self) -> Result<(), SandboxError> {
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                self.0.as_raw(),
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(SandboxError::JobConfigure);
        }
        Ok(())
    }

    pub fn assign(&self, process: HANDLE) -> Result<(), SandboxError> {
        if unsafe { AssignProcessToJobObject(self.0.as_raw(), process) } == 0 {
            return Err(SandboxError::JobAssign);
        }
        Ok(())
    }
}
