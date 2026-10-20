//! Return unused glibc pages after window teardown, away from the UI thread.
//! This does not collect JS, discard live DOM state or disable graphics caches.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod platform {
    use std::{
        sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
        thread::JoinHandle,
        time::{Duration, Instant},
    };
    pub struct Reclaimer {
        started: Instant,
        disabled: bool,
        sender: Option<SyncSender<()>>,
        worker: Option<JoinHandle<()>>,
    }
    impl Reclaimer {
        pub fn new(started: Instant) -> Self {
            Self {
                started,
                disabled: std::env::var("WEBER_RECLAIM").as_deref() == Ok("0"),
                sender: None,
                worker: None,
            }
        }
        pub fn schedule(&mut self) {
            if self.disabled {
                return;
            }
            if self.sender.is_none() {
                let (sender, receiver) = mpsc::sync_channel(1);
                let started = self.started;
                let path = std::env::var_os("WEBER_TELEMETRY").map(std::path::PathBuf::from);
                match std::thread::Builder::new()
                    .name("weber-reclaim".into())
                    .spawn(move || {
                        while receiver.recv().is_ok() {
                            if !debounce(&receiver) {
                                break;
                            }
                            let result = reclaim();
                            if let Some(path) = &path {
                                crate::telemetry::write_event(path, started, result);
                            }
                        }
                    }) {
                    Ok(worker) => {
                        self.sender = Some(sender);
                        self.worker = Some(worker);
                    }
                    Err(error) => {
                        self.disabled = true;
                        log::warn!("Memory reclaimer unavailable: {error}");
                    }
                }
            }
            if let Some(sender) = &self.sender {
                let _ = sender.try_send(());
            }
        }
    }
    impl Drop for Reclaimer {
        fn drop(&mut self) {
            self.sender.take();
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
    // Coalesce close bursts. Reclaim after 750ms quiet, or at most 2s of continued
    // requests. No thread/timer exists until the first non-final window close.
    fn debounce(receiver: &Receiver<()>) -> bool {
        let limit = Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = limit.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return true;
            }
            match receiver.recv_timeout(remaining.min(Duration::from_millis(750))) {
                Ok(()) => {}
                Err(RecvTimeoutError::Timeout) => return true,
                Err(RecvTimeoutError::Disconnected) => return false,
            }
        }
    }
    #[expect(
        unsafe_code,
        reason = "glibc malloc_trim is MT-safe, accepts no pointers, and reclaims only already-free allocator pages"
    )]
    fn reclaim() -> serde_json::Value {
        let started = Instant::now();
        let released = unsafe { libc::malloc_trim(0) } != 0;
        serde_json::json!({ "stage": "memory-reclaim", "released": released,
            "durationMs": started.elapsed().as_secs_f64() * 1000.0 })
    }
    #[cfg(test)]
    mod tests {
        #[test]
        fn shutdown_cancels_pending_debounce() {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            drop(sender);
            assert!(!super::debounce(&receiver));
        }
    }
}
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
mod platform {
    pub struct Reclaimer;
    impl Reclaimer {
        pub fn new(_: std::time::Instant) -> Self {
            Self
        }
        pub fn schedule(&mut self) {}
    }
}
pub use platform::Reclaimer;

/// Opt-in diagnostics through Servo's existing asynchronous memory-report API.
/// No periodic timer, GC request or public JavaScript capability is installed.
pub struct Profiler {
    path: std::path::PathBuf,
    started: std::time::Instant,
    pending: bool,
    send: std::sync::mpsc::SyncSender<ProfileReply>,
    receive: std::sync::mpsc::Receiver<ProfileReply>,
}
type ProfileReply = (
    String,
    std::time::Instant,
    Result<servo::profile_traits::mem::MemoryReportResult, String>,
);
impl Profiler {
    pub fn new(started: std::time::Instant) -> Option<Self> {
        if std::env::var("WEBER_MEMORY_PROFILE").as_deref() != Ok("1") {
            return None;
        }
        let path = std::env::var_os("WEBER_TELEMETRY")?.into();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        Some(Self {
            path,
            started,
            pending: false,
            send,
            receive,
        })
    }
    pub fn request(
        &mut self,
        servo: &servo::Servo,
        proxy: &winit::event_loop::EventLoopProxy<crate::host::Wake>,
        label: String,
    ) {
        if self.pending {
            return;
        }
        let send = self.send.clone();
        let wake = proxy.clone();
        let requested = std::time::Instant::now();
        let callback = servo_base::generic_channel::GenericCallback::new(
            move |result: Result<servo::profile_traits::mem::MemoryReportResult, _>| {
                // The engine callback only queues owned data and a wakeup. Formatting
                // and file I/O happen later, outside the profiler/router callback.
                if send
                    .try_send((
                        label.clone(),
                        requested,
                        result.map_err(|error| error.to_string()),
                    ))
                    .is_ok()
                {
                    let _ = wake.send_event(crate::host::Wake::MemoryReady);
                }
            },
        );
        match callback {
            Ok(callback) => {
                self.pending = true;
                servo.create_memory_report(callback);
            }
            Err(error) => crate::telemetry::write_event(
                &self.path,
                self.started,
                serde_json::json!({"stage":"memory-report-error", "message":error.to_string()}),
            ),
        }
    }
    pub fn deliver(&mut self) {
        if let Ok((label, requested, result)) = self.receive.try_recv() {
            self.pending = false;
            let data = match result {
                Ok(report) => {
                    serde_json::json!({"stage":"memory-report", "label":label, "durationMs":requested.elapsed().as_secs_f64()*1000.0, "report":report})
                }
                Err(error) => {
                    serde_json::json!({"stage":"memory-report-error", "label":label, "message":error})
                }
            };
            crate::telemetry::write_event(&self.path, self.started, data);
        }
    }
}
