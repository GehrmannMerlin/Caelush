use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};

#[derive(Debug)]
pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub unsafe fn from_raw(handle: HANDLE, error_code: &'static str) -> Result<Self, String> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(error_code.to_string());
        }
        Ok(Self(handle))
    }

    pub fn as_raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[derive(Debug)]
pub struct OwnedLocal<T>(*mut T);

impl<T> OwnedLocal<T> {
    pub unsafe fn from_raw(pointer: *mut T, error_code: &'static str) -> Result<Self, String> {
        if pointer.is_null() {
            return Err(error_code.to_string());
        }
        Ok(Self(pointer))
    }

    #[allow(dead_code)] // Consumed by the restricted-token implementation in the next checkpoint.
    pub fn as_ptr(&self) -> *mut T {
        self.0
    }
}

impl<T> Drop for OwnedLocal<T> {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0.cast::<core::ffi::c_void>() as HLOCAL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{OwnedHandle, OwnedLocal};
    use std::ptr::null_mut;
    use windows_sys::Win32::System::Threading::CreateEventW;

    #[test]
    fn rejects_null_handles_even_after_nominal_api_success() {
        let result = unsafe { OwnedHandle::from_raw(null_mut(), "NULL_HANDLE") };
        assert_eq!(result.err().as_deref(), Some("NULL_HANDLE"));
    }

    #[test]
    fn owns_a_valid_kernel_handle() {
        let raw = unsafe { CreateEventW(null_mut(), 0, 0, null_mut()) };
        let owned = unsafe { OwnedHandle::from_raw(raw, "EVENT_CREATE_FAILED") }
            .expect("test event should be created");
        assert_eq!(owned.as_raw(), raw);
    }

    #[test]
    fn rejects_null_local_allocations() {
        let result =
            unsafe { OwnedLocal::<core::ffi::c_void>::from_raw(null_mut(), "LOCAL_ALLOC_FAILED") };
        assert_eq!(result.err().as_deref(), Some("LOCAL_ALLOC_FAILED"));
    }
}
