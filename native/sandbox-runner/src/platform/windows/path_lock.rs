use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

#[derive(Default)]
pub struct PathLockRegistry {
    locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl PathLockRegistry {
    pub fn with_lock<R>(&self, path: &Path, operation: impl FnOnce() -> R) -> R {
        let key = lock_key(path);
        let lock = {
            let mut locks = self
                .locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        };

        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        operation()
    }
}

fn lock_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::PathLockRegistry;
    use std::path::Path;
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn serializes_acl_mutations_for_the_same_path() {
        let registry = Arc::new(PathLockRegistry::default());
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(Mutex::new(0u32));
        let maximum = Arc::new(Mutex::new(0u32));

        let workers = (0..2)
            .map(|_| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                thread::spawn(move || {
                    barrier.wait();
                    registry.with_lock(Path::new(r"C:\workspace"), || {
                        let mut current = active.lock().expect("active lock");
                        *current += 1;
                        let mut observed = maximum.lock().expect("maximum lock");
                        *observed = (*observed).max(*current);
                        drop(observed);
                        drop(current);
                        thread::sleep(Duration::from_millis(20));
                        *active.lock().expect("active lock") -= 1;
                    });
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        for worker in workers {
            worker.join().expect("worker should finish");
        }

        assert_eq!(*maximum.lock().expect("maximum lock"), 1);
    }

    #[test]
    fn does_not_alias_distinct_paths() {
        let registry = Arc::new(PathLockRegistry::default());
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(Mutex::new(0u32));
        let maximum = Arc::new(Mutex::new(0u32));

        let workers = [r"C:\workspace-a", r"C:\workspace-b"]
            .into_iter()
            .map(|path| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                thread::spawn(move || {
                    barrier.wait();
                    registry.with_lock(Path::new(path), || {
                        let mut current = active.lock().expect("active lock");
                        *current += 1;
                        let mut observed = maximum.lock().expect("maximum lock");
                        *observed = (*observed).max(*current);
                        drop(observed);
                        drop(current);
                        thread::sleep(Duration::from_millis(20));
                        *active.lock().expect("active lock") -= 1;
                    });
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        for worker in workers {
            worker.join().expect("worker should finish");
        }

        assert_eq!(*maximum.lock().expect("maximum lock"), 2);
    }
}
