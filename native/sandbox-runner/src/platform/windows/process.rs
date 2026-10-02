use super::acl;
use super::error::SandboxError;
use super::handle::OwnedHandle;
use super::job::JobObject;
use super::token::RestrictedToken;
use crate::platform::windows::command_line::build_command_line;
use std::ffi::OsString;
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, ERROR_INSUFFICIENT_BUFFER, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

pub fn build_environment_block(entries: &[(OsString, OsString)]) -> Result<Vec<u16>, SandboxError> {
    let mut encoded = Vec::with_capacity(entries.len());
    for (name, value) in entries {
        let name: Vec<u16> = name.encode_wide().collect();
        let value: Vec<u16> = value.encode_wide().collect();
        if name.is_empty()
            || name.iter().any(|unit| *unit == 0 || *unit == b'=' as u16)
            || value.contains(&0)
        {
            return Err(SandboxError::EnvironmentBuild);
        }
        encoded.push((name, value));
    }
    encoded.sort_by(|left, right| {
        left.0
            .iter()
            .map(|unit| ascii_lowercase(*unit))
            .cmp(right.0.iter().map(|unit| ascii_lowercase(*unit)))
    });

    let mut block = Vec::new();
    for (name, value) in encoded {
        block.extend(name);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    Ok(block)
}

fn ascii_lowercase(unit: u16) -> u16 {
    if (b'A' as u16..=b'Z' as u16).contains(&unit) {
        unit + (b'a' - b'A') as u16
    } else {
        unit
    }
}

pub trait RestrictedProcessBackend {
    type Job;
    type Suspended;
    type Running;

    fn create_job(&self) -> Result<Self::Job, SandboxError>;
    fn configure_job(&self, job: &Self::Job) -> Result<(), SandboxError>;
    fn create_suspended(&self) -> Result<Self::Suspended, SandboxError>;
    fn assign_job(&self, job: &Self::Job, process: &Self::Suspended) -> Result<(), SandboxError>;
    fn resume(&self, process: Self::Suspended) -> Result<Self::Running, SandboxError>;
    #[cfg(test)]
    fn wait(&self, process: &Self::Running) -> Result<u32, SandboxError>;
}

pub fn spawn_with<B: RestrictedProcessBackend>(
    backend: &B,
) -> Result<(B::Running, B::Job), SandboxError> {
    let job = backend.create_job()?;
    backend.configure_job(&job)?;
    let suspended = backend.create_suspended()?;
    backend.assign_job(&job, &suspended)?;
    let running = backend.resume(suspended)?;
    Ok((running, job))
}

#[derive(Debug)]
pub struct RestrictedProcess {
    process: OwnedHandle,
    _job: JobObject,
    temp_grant: Option<TempGrantCleanup>,
}

impl RestrictedProcess {
    pub fn spawn(
        token: &RestrictedToken,
        program: &str,
        args: &[String],
        cwd: &Path,
        environment: &[(OsString, OsString)],
    ) -> Result<Self, SandboxError> {
        let backend = Win32ProcessBackend {
            token,
            program,
            args,
            cwd,
            environment,
        };
        let (process, job) = spawn_with(&backend)?;
        Ok(Self {
            process,
            _job: job,
            temp_grant: None,
        })
    }

    pub fn spawn_with_temp_grant(
        token: &RestrictedToken,
        program: &str,
        args: &[String],
        cwd: &Path,
        environment: &[(OsString, OsString)],
        temp_path: PathBuf,
        temp_sid: String,
    ) -> Result<Self, SandboxError> {
        let mut process = Self::spawn(token, program, args, cwd, environment)?;
        process.temp_grant = Some(TempGrantCleanup {
            path: temp_path,
            sid: temp_sid,
            armed: true,
        });
        Ok(process)
    }

    pub fn wait(&mut self) -> Result<u32, SandboxError> {
        let wait_result = wait_for_process(&self.process);
        let cleanup_result = self.cleanup_temp_grant();
        match (wait_result, cleanup_result) {
            (Err(error), _) => Err(error),
            (Ok(code), Ok(())) => Ok(code),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    fn cleanup_temp_grant(&mut self) -> Result<(), SandboxError> {
        if let Some(cleanup) = self.temp_grant.as_mut() {
            cleanup.revoke()?;
            self.temp_grant = None;
        }
        Ok(())
    }
}

#[derive(Debug)]
struct TempGrantCleanup {
    path: PathBuf,
    sid: String,
    armed: bool,
}

impl TempGrantCleanup {
    fn revoke(&mut self) -> Result<(), SandboxError> {
        if !self.armed {
            return Ok(());
        }
        acl::revoke_write_grant(&self.path, &self.sid)?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for TempGrantCleanup {
    fn drop(&mut self) {
        let _ = self.revoke();
    }
}

struct Win32ProcessBackend<'a> {
    token: &'a RestrictedToken,
    program: &'a str,
    args: &'a [String],
    cwd: &'a Path,
    environment: &'a [(OsString, OsString)],
}

impl RestrictedProcessBackend for Win32ProcessBackend<'_> {
    type Job = JobObject;
    type Suspended = SuspendedProcess;
    type Running = OwnedHandle;

    fn create_job(&self) -> Result<Self::Job, SandboxError> {
        JobObject::create()
    }

    fn configure_job(&self, job: &Self::Job) -> Result<(), SandboxError> {
        job.configure_kill_on_close()
    }

    fn create_suspended(&self) -> Result<Self::Suspended, SandboxError> {
        create_suspended_process(
            self.token,
            self.program,
            self.args,
            self.cwd,
            self.environment,
        )
    }

    fn assign_job(&self, job: &Self::Job, process: &Self::Suspended) -> Result<(), SandboxError> {
        job.assign(process.process_handle())
    }

    fn resume(&self, process: Self::Suspended) -> Result<Self::Running, SandboxError> {
        process.resume()
    }

    #[cfg(test)]
    fn wait(&self, process: &Self::Running) -> Result<u32, SandboxError> {
        wait_for_process(process)
    }
}

struct SuspendedProcess {
    process: Option<OwnedHandle>,
    thread: Option<OwnedHandle>,
    armed: bool,
}

impl SuspendedProcess {
    fn from_process_information(information: PROCESS_INFORMATION) -> Result<Self, SandboxError> {
        let process = unsafe {
            OwnedHandle::from_raw(
                information.hProcess,
                SandboxError::RestrictedProcessCreate.code(),
            )
        }
        .map_err(|_| SandboxError::RestrictedProcessCreate)?;
        let thread = match unsafe {
            OwnedHandle::from_raw(
                information.hThread,
                SandboxError::RestrictedProcessCreate.code(),
            )
        } {
            Ok(thread) => thread,
            Err(_) => {
                unsafe {
                    TerminateProcess(process.as_raw(), 1);
                }
                return Err(SandboxError::RestrictedProcessCreate);
            }
        };
        Ok(Self {
            process: Some(process),
            thread: Some(thread),
            armed: true,
        })
    }

    fn process_handle(&self) -> HANDLE {
        self.process
            .as_ref()
            .expect("suspended process invariant")
            .as_raw()
    }

    fn resume(mut self) -> Result<OwnedHandle, SandboxError> {
        let thread = self.thread.as_ref().ok_or(SandboxError::ThreadResume)?;
        if unsafe { ResumeThread(thread.as_raw()) } == u32::MAX {
            return Err(SandboxError::ThreadResume);
        }
        self.armed = false;
        drop(self.thread.take());
        self.process
            .take()
            .ok_or(SandboxError::RestrictedProcessCreate)
    }
}

impl Drop for SuspendedProcess {
    fn drop(&mut self) {
        if self.armed {
            if let Some(process) = self.process.as_ref() {
                unsafe {
                    TerminateProcess(process.as_raw(), 1);
                }
            }
        }
    }
}

fn create_suspended_process(
    token: &RestrictedToken,
    program: &str,
    args: &[String],
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Result<SuspendedProcess, SandboxError> {
    let mut command_line = wide_null(&build_command_line(program, args)?)?;
    let cwd = wide_null(cwd.as_os_str())?;
    let environment = build_environment_block(environment)?;
    let stdio = InheritedStdio::prepare()?;
    let handles = stdio.raw_handles();
    let attributes = AttributeList::for_handles(&handles)?;

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.as_raw();

    let mut information = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessAsUserW(
            token.as_raw(),
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut information,
        )
    };
    if created == 0 {
        cleanup_failed_process_information(information);
        return Err(SandboxError::RestrictedProcessCreate);
    }
    SuspendedProcess::from_process_information(information)
}

fn wait_for_process(process: &OwnedHandle) -> Result<u32, SandboxError> {
    let wait = unsafe { WaitForSingleObject(process.as_raw(), INFINITE) };
    if wait != WAIT_OBJECT_0 {
        return Err(SandboxError::ProcessWait);
    }
    let mut exit_code = 0u32;
    if unsafe { GetExitCodeProcess(process.as_raw(), &mut exit_code) } == 0 {
        return Err(SandboxError::ExitCodeQuery);
    }
    Ok(exit_code)
}

struct InheritedStdio {
    stdin: OwnedHandle,
    stdout: OwnedHandle,
    stderr: OwnedHandle,
}

impl InheritedStdio {
    fn prepare() -> Result<Self, SandboxError> {
        Ok(Self {
            stdin: duplicate_standard_handle(STD_INPUT_HANDLE)?,
            stdout: duplicate_standard_handle(STD_OUTPUT_HANDLE)?,
            stderr: duplicate_standard_handle(STD_ERROR_HANDLE)?,
        })
    }

    fn raw_handles(&self) -> [HANDLE; 3] {
        [
            self.stdin.as_raw(),
            self.stdout.as_raw(),
            self.stderr.as_raw(),
        ]
    }
}

fn duplicate_standard_handle(kind: u32) -> Result<OwnedHandle, SandboxError> {
    let source = unsafe { GetStdHandle(kind) };
    if source.is_null() || source == INVALID_HANDLE_VALUE {
        return Err(SandboxError::StandardHandlePrepare);
    }
    let process = unsafe { GetCurrentProcess() };
    let mut duplicate = null_mut();
    let duplicated = unsafe {
        DuplicateHandle(
            process,
            source,
            process,
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if duplicated == 0 {
        return Err(SandboxError::StandardHandlePrepare);
    }
    unsafe { OwnedHandle::from_raw(duplicate, SandboxError::StandardHandlePrepare.code()) }
        .map_err(|_| SandboxError::StandardHandlePrepare)
}

struct AttributeList {
    _storage: Vec<usize>,
    pointer: *mut core::ffi::c_void,
}

impl AttributeList {
    fn for_handles(handles: &[HANDLE]) -> Result<Self, SandboxError> {
        let mut bytes = 0usize;
        let sized = unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes) };
        if sized != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || bytes == 0 {
            return Err(SandboxError::StandardHandlePrepare);
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let pointer = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) } == 0 {
            return Err(SandboxError::StandardHandlePrepare);
        }
        let updated = unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            )
        };
        if updated == 0 {
            unsafe {
                DeleteProcThreadAttributeList(pointer);
            }
            return Err(SandboxError::StandardHandlePrepare);
        }
        Ok(Self {
            _storage: storage,
            pointer,
        })
    }

    fn as_raw(&self) -> *mut core::ffi::c_void {
        self.pointer
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}

fn wide_null(value: impl AsRef<std::ffi::OsStr>) -> Result<Vec<u16>, SandboxError> {
    let mut encoded: Vec<u16> = value.as_ref().encode_wide().collect();
    if encoded.contains(&0) {
        return Err(SandboxError::CommandLineBuild);
    }
    encoded.push(0);
    Ok(encoded)
}

fn cleanup_failed_process_information(information: PROCESS_INFORMATION) {
    if let Ok(process) = unsafe {
        OwnedHandle::from_raw(
            information.hProcess,
            SandboxError::RestrictedProcessCreate.code(),
        )
    } {
        unsafe {
            TerminateProcess(process.as_raw(), 1);
        }
        drop(process);
    }
    if let Ok(thread) = unsafe {
        OwnedHandle::from_raw(
            information.hThread,
            SandboxError::RestrictedProcessCreate.code(),
        )
    } {
        drop(thread);
    }
}

#[cfg(test)]
mod tests {
    use super::{build_environment_block, spawn_with, RestrictedProcessBackend, SandboxError};
    use std::cell::RefCell;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStrExt;
    use std::rc::Rc;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Failure {
        CreateJob,
        ConfigureJob,
        CreateProcess,
        AssignJob,
        Resume,
        Wait,
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

    impl RestrictedProcessBackend for MockBackend {
        type Job = Resource;
        type Suspended = Resource;
        type Running = Resource;

        fn create_job(&self) -> Result<Self::Job, SandboxError> {
            self.calls.borrow_mut().push("create-job");
            if self.failure == Some(Failure::CreateJob) {
                return Err(SandboxError::JobCreate);
            }
            Ok(self.resource("job"))
        }

        fn configure_job(&self, _job: &Self::Job) -> Result<(), SandboxError> {
            self.calls.borrow_mut().push("configure-job");
            if self.failure == Some(Failure::ConfigureJob) {
                return Err(SandboxError::JobConfigure);
            }
            Ok(())
        }

        fn create_suspended(&self) -> Result<Self::Suspended, SandboxError> {
            self.calls.borrow_mut().push("create-suspended");
            if self.failure == Some(Failure::CreateProcess) {
                return Err(SandboxError::RestrictedProcessCreate);
            }
            Ok(self.resource("suspended-process"))
        }

        fn assign_job(
            &self,
            _job: &Self::Job,
            _process: &Self::Suspended,
        ) -> Result<(), SandboxError> {
            self.calls.borrow_mut().push("assign-job");
            if self.failure == Some(Failure::AssignJob) {
                return Err(SandboxError::JobAssign);
            }
            Ok(())
        }

        fn resume(&self, _process: Self::Suspended) -> Result<Self::Running, SandboxError> {
            self.calls.borrow_mut().push("resume-thread");
            if self.failure == Some(Failure::Resume) {
                return Err(SandboxError::ThreadResume);
            }
            Ok(self.resource("running-process"))
        }

        fn wait(&self, _process: &Self::Running) -> Result<u32, SandboxError> {
            self.calls.borrow_mut().push("wait");
            if self.failure == Some(Failure::Wait) {
                return Err(SandboxError::ProcessWait);
            }
            Ok(0xc000_0409)
        }
    }

    #[test]
    fn creates_suspended_assigns_the_job_and_only_then_resumes() {
        let backend = MockBackend::new(None);
        let (process, job) = spawn_with(&backend).expect("mock spawn should succeed");
        assert_eq!(
            backend.calls.borrow().as_slice(),
            [
                "create-job",
                "configure-job",
                "create-suspended",
                "assign-job",
                "resume-thread",
            ]
        );
        assert_eq!(backend.wait(&process), Ok(0xc000_0409));
        drop(process);
        drop(job);
    }

    #[test]
    fn forwards_each_creation_failure_and_releases_partial_resources() {
        let cases = [
            (Failure::CreateJob, SandboxError::JobCreate),
            (Failure::ConfigureJob, SandboxError::JobConfigure),
            (
                Failure::CreateProcess,
                SandboxError::RestrictedProcessCreate,
            ),
            (Failure::AssignJob, SandboxError::JobAssign),
            (Failure::Resume, SandboxError::ThreadResume),
        ];
        for (failure, expected) in cases {
            let backend = MockBackend::new(Some(failure));
            assert_eq!(spawn_with(&backend).err(), Some(expected));
            if matches!(failure, Failure::AssignJob | Failure::Resume) {
                assert!(backend.drops.borrow().contains(&"suspended-process"));
            }
        }
    }

    #[test]
    fn preserves_full_width_exit_codes_and_wait_failures() {
        let backend = MockBackend::new(None);
        let (process, _job) = spawn_with(&backend).expect("mock spawn should succeed");
        assert_eq!(backend.wait(&process), Ok(0xc000_0409));

        let failing = MockBackend::new(Some(Failure::Wait));
        let (process, _job) = spawn_with(&failing).expect("mock spawn should succeed");
        assert_eq!(failing.wait(&process), Err(SandboxError::ProcessWait));
    }

    #[test]
    fn builds_a_sorted_double_nul_terminated_unicode_environment() {
        let block = build_environment_block(&[
            (OsString::from("Path"), OsString::from(r"C:\工具")),
            (OsString::from("alpha"), OsString::from("一")),
        ])
        .expect("environment should build");
        let expected: Vec<u16> = OsString::from("alpha=一\0Path=C:\\工具\0\0")
            .encode_wide()
            .collect();
        assert_eq!(block, expected);
    }

    #[test]
    fn rejects_invalid_environment_names_and_nuls() {
        for entries in [
            vec![(OsString::new(), OsString::from("value"))],
            vec![(OsString::from("A=B"), OsString::from("value"))],
            vec![(OsString::from("A\0B"), OsString::from("value"))],
            vec![(OsString::from("A"), OsString::from("v\0x"))],
        ] {
            assert_eq!(
                build_environment_block(&entries).err(),
                Some(SandboxError::EnvironmentBuild)
            );
        }
    }

    #[test]
    fn spawns_and_waits_for_a_real_restricted_windows_process() {
        use crate::platform::windows::token::RestrictedToken;

        let token = RestrictedToken::create_read_only().expect("restricted token should build");
        let program = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let environment = std::env::vars_os().collect::<Vec<_>>();
        let mut process = super::RestrictedProcess::spawn(
            &token,
            &program,
            &[
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "exit /b 37".to_string(),
            ],
            &std::env::current_dir().expect("test cwd should resolve"),
            &environment,
        )
        .expect("restricted child should start");
        assert_eq!(process.wait(), Ok(37));
    }

    #[test]
    fn closing_the_job_terminates_a_running_restricted_child() {
        use crate::platform::windows::handle::OwnedHandle;
        use crate::platform::windows::token::RestrictedToken;
        use std::ptr::null_mut;
        use windows_sys::Win32::Foundation::{
            DuplicateHandle, DUPLICATE_SAME_ACCESS, WAIT_OBJECT_0,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, WaitForSingleObject};

        let token = RestrictedToken::create_read_only().expect("restricted token should build");
        let program = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let environment = std::env::vars_os().collect::<Vec<_>>();
        let process = super::RestrictedProcess::spawn(
            &token,
            &program,
            &[
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "ping -n 30 127.0.0.1 >nul".to_string(),
            ],
            &std::env::current_dir().expect("test cwd should resolve"),
            &environment,
        )
        .expect("restricted child should start");

        let current = unsafe { GetCurrentProcess() };
        let mut observed = null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    current,
                    process.process.as_raw(),
                    current,
                    &mut observed,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            },
            0
        );
        let observed = unsafe { OwnedHandle::from_raw(observed, "TEST_DUPLICATE_FAILED") }
            .expect("test process handle should duplicate");
        drop(process);
        assert_eq!(
            unsafe { WaitForSingleObject(observed.as_raw(), 5_000) },
            WAIT_OBJECT_0
        );
    }
}
