//! Keep Tokio's reactor alive while the desktop renderer has no commands.
use std::{os::fd::AsRawFd, time::{Duration, Instant}};
use obscura_browser::Page;
use tokio::{io::{unix::AsyncFd, Interest}, runtime::Runtime};

// The C++ owner retains this socket until after engine destruction. We observe
// readiness only; wire.rs/C++ framing remains its sole reader and writer.
struct Channel(i32);
impl AsRawFd for Channel { fn as_raw_fd(&self) -> i32 { self.0 } }
pub(crate) struct Scheduler {
    channel: Option<AsyncFd<Channel>>,
    pub idle: bool,
    pub next_frame: Instant,
}
impl Default for Scheduler {
    fn default() -> Self { Self { channel: None, idle: false, next_frame: Instant::now() } }
}
impl Scheduler {
    pub fn wait(&mut self, runtime: &Runtime, page: &mut Page, loaded: bool,
                fd: i32, watch_frames: bool) -> Result<i32, String> {
        let _guard = runtime.enter();
        if fd < 0 { return Err("Invalid desktop command channel".into()); }
        if let Some(channel) = &self.channel {
            if channel.get_ref().0 != fd { return Err("Desktop command channel changed".into()); }
        } else {
            self.channel = Some(AsyncFd::with_interest(Channel(fd), Interest::READABLE)
                .map_err(|e| e.to_string())?);
        }
        let channel = self.channel.as_ref().unwrap();
        let frame = loaded && watch_frames && page.desktop_frame_changed();
        let deadline = tokio::time::Instant::from_std(self.next_frame);
        let kind = runtime.block_on(async {
            tokio::select! { biased;
                ready = channel.readable() => {
                    // The wire reader runs immediately after returning. Clearing
                    // before that read ensures a later edge can wake us again.
                    ready.map_err(|e| e.to_string())?.clear_ready();
                    Ok::<i32, String>(0)
                }
                _ = tokio::time::sleep_until(deadline), if frame => Ok(2),
                turn = page.run_autonomous_event_loop_turn(), if loaded && !self.idle => {
                    self.idle = turn?;
                    Ok(1)
                }
            }
        })?;
        if kind == 2 { self.next_frame = Instant::now() + Duration::from_millis(16); }
        Ok(kind)
    }
}
