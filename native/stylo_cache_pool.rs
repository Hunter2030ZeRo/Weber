// Reuse completed Stylo TLS allocations without changing borrow lifetimes.
// SPDX-License-Identifier: MPL-2.0
use atomic_refcell::AtomicRefCell;
use std::sync::Mutex;

type Pool<T> = Mutex<Vec<&'static AtomicRefCell<T>>>;

/// A thread's lease of a stable-address cache. Borrow guards can outlive this
/// lease, as Stylo traversal contexts may be dropped from a parent thread.
pub(crate) struct ReusableCache<T: Default + Send + Sync + 'static> {
    cache: &'static AtomicRefCell<T>,
    pool: &'static Pool<T>,
}
impl<T: Default + Send + Sync + 'static> ReusableCache<T> {
    pub(crate) fn new(pool: &'static Pool<T>) -> Self {
        let cache = pool
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pop()
            .unwrap_or_else(|| Box::leak(Box::default()));
        Self { cache, pool }
    }
    pub(crate) fn get(&self) -> &'static AtomicRefCell<T> {
        self.cache
    }
}
impl<T: Default + Send + Sync + 'static> Drop for ReusableCache<T> {
    fn drop(&mut self) {
        // Never free or recycle a cell that an outstanding traversal can access.
        // If a guard outlives TLS, retain the original intentional-leak behavior.
        let Ok(guard) = self.cache.try_borrow_mut() else {
            return;
        };
        drop(guard);
        // All legitimate access is via guards or the dying TLS lease. No future
        // access can start from this lease once its destructor returns. Stylo's
        // StyleBloom/StyleSharingCache Drop clears DOM state before guard release.
        self.pool
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(self.cache);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_thread_caches_are_reused_across_many_lifetimes()
    -> Result<(), Box<dyn std::error::Error>> {
        static POOL: Pool<[u8; 32]> = Mutex::new(Vec::new());
        thread_local! { static CACHE: ReusableCache<[u8; 32]> = ReusableCache::new(&POOL); }
        let mut first = None;
        for _ in 0..64 {
            let address = std::thread::spawn(|| {
                CACHE.with(|cache| {
                    cache.get().borrow_mut()[0] = 9;
                    cache.get() as *const _ as usize
                })
            })
            .join()
            .map_err(|_| "cache worker panicked")?;
            if let Some(first) = first {
                assert_eq!(address, first);
            } else {
                first = Some(address);
            }
        }
        assert_eq!(POOL.lock().map_err(|_| "cache lock poisoned")?.len(), 1);
        Ok(())
    }
    #[test]
    fn a_guard_outliving_its_worker_prevents_recycling() -> Result<(), Box<dyn std::error::Error>> {
        static POOL: Pool<[u8; 32]> = Mutex::new(Vec::new());
        thread_local! { static CACHE: ReusableCache<[u8; 32]> = ReusableCache::new(&POOL); }
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            CACHE.with(|cache| {
                let _ = send.send((cache.get() as *const _ as usize, cache.get().borrow_mut()));
            })
        })
        .join()
        .map_err(|_| "cache worker panicked")?;
        let (old, mut held) = receive.recv()?;
        assert!(POOL.lock().map_err(|_| "cache lock poisoned")?.is_empty());
        let next = std::thread::spawn(|| CACHE.with(|cache| cache.get() as *const _ as usize))
            .join()
            .map_err(|_| "cache worker panicked")?;
        assert_ne!(old, next);
        held[0] = 42;
        assert_eq!(held[0], 42); // Valid after the worker exited.
        drop(held);
        let reused = std::thread::spawn(|| CACHE.with(|cache| cache.get() as *const _ as usize))
            .join()
            .map_err(|_| "cache worker panicked")?;
        assert_eq!(next, reused);
        Ok(())
    }
}
