//! Bounded, asynchronous native clipboard requests; no work while idle.
use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::Write,
    os::unix::net::UnixStream,
    sync::{Mutex, mpsc},
    thread::JoinHandle,
    time::Duration,
};
use wayland_client::Connection;

#[path = "clipboard_wayland.rs"]
mod platform;
pub(super) const MAX_TEXT: usize = 8192;
const MAX_PENDING: usize = 16;
pub(super) struct Task {
    id: u64,
    operation: Operation,
}
pub(super) enum Operation {
    Read,
    Write(String),
    Clear,
}
pub(super) struct Reply {
    id: u64,
    result: Result<Value, String>,
}
struct Pending {
    owner: u64,
    result: Option<Result<Value, String>>,
}
pub(super) struct ReplySender {
    send: mpsc::Sender<Reply>,
    proxy: winit::event_loop::EventLoopProxy<crate::host::Wake>,
}
impl ReplySender {
    fn send(&self, reply: Reply) {
        let _ = self.send.send(reply);
        let _ = self.proxy.send_event(crate::host::Wake::Clipboard);
    }
}
struct BrowserRequest {
    owner: u64,
    request: Option<servo::StringRequest>,
}
thread_local! {
    // Servo callbacks stay on the event-loop thread. Workers only send values.
    static BROWSER: RefCell<BTreeMap<u64, BrowserRequest>> = const { RefCell::new(BTreeMap::new()) };
}
struct Worker {
    send: mpsc::SyncSender<Task>,
    receive: mpsc::Receiver<Reply>,
    wake: UnixStream,
    thread: JoinHandle<()>,
}
#[derive(Default)]
struct Service {
    connection: Option<Connection>,
    proxy: Option<winit::event_loop::EventLoopProxy<crate::host::Wake>>,
    worker: Option<Worker>,
    pending: BTreeMap<u64, Pending>,
    next: u64,
}
static SERVICE: Mutex<Service> = Mutex::new(Service {
    connection: None,
    proxy: None,
    worker: None,
    pending: BTreeMap::new(),
    next: 0,
});

/// Borrow App's owned display. shutdown() joins the worker before that guard dies.
#[expect(
    unsafe_code,
    reason = "App retains an OwnedDisplayHandle and joins this service before releasing that guard"
)]
pub fn attach(
    display: winit::raw_window_handle::DisplayHandle<'_>,
    proxy: winit::event_loop::EventLoopProxy<crate::host::Wake>,
) -> Result<()> {
    let winit::raw_window_handle::RawDisplayHandle::Wayland(handle) = display.as_raw() else {
        return Err(anyhow!("Wayland clipboard unavailable"));
    };
    // SAFETY: App retains an OwnedDisplayHandle even after run_app consumes the
    // event loop. App::drop joins this worker and releases its foreign backend
    // and proxies before dropping that owned display guard.
    let backend = unsafe {
        wayland_client::backend::Backend::from_foreign_display(handle.display.as_ptr().cast())
    };
    let mut service = SERVICE
        .lock()
        .map_err(|_| anyhow!("Clipboard lock failed"))?;
    service.connection = Some(Connection::from_backend(backend));
    service.proxy = Some(proxy);
    // Mutter assigns clipboard devices when client focus changes. Binding after
    // the first window is focused misses its initial offer; register first.
    service.worker()?;
    Ok(())
}
impl Service {
    fn drain(&mut self) {
        if let Some(worker) = &self.worker {
            loop {
                match worker.receive.try_recv() {
                    Ok(reply) => {
                        if let Some(pending) = self.pending.get_mut(&reply.id) {
                            pending.result = Some(reply.result);
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        for pending in self
                            .pending
                            .values_mut()
                            .filter(|pending| pending.result.is_none())
                        {
                            pending.result = Some(Err("Clipboard worker stopped".into()));
                        }
                        break;
                    }
                }
            }
        }
    }
    fn worker(&mut self) -> Result<&mut Worker> {
        if self.worker.is_none() {
            let connection = self
                .connection
                .clone()
                .ok_or_else(|| anyhow!("Clipboard display unavailable"))?;
            let (send, tasks) = mpsc::sync_channel(MAX_PENDING);
            let (replies, receive) = mpsc::channel();
            let proxy = self
                .proxy
                .clone()
                .ok_or_else(|| anyhow!("Clipboard event loop unavailable"))?;
            let replies = ReplySender {
                send: replies,
                proxy: proxy.clone(),
            };
            let (ready, initialized) = mpsc::sync_channel(1);
            let (wake, receiver) = UnixStream::pair()?;
            wake.set_nonblocking(true)?;
            receiver.set_nonblocking(true)?;
            let thread = std::thread::Builder::new()
                .name("WeberClipboard".into())
                .spawn(move || {
                    if let Err(error) = platform::run(connection, receiver, tasks, replies, ready) {
                        log::warn!("Clipboard worker: {error}");
                    }
                    let _ = proxy.send_event(crate::host::Wake::Clipboard);
                })?;
            self.worker = Some(Worker {
                send,
                receive,
                wake,
                thread,
            });
            initialized
                .recv_timeout(Duration::from_secs(3))
                .map_err(|_| anyhow!("Wayland clipboard registration timed out or failed"))?;
        }
        self.worker
            .as_mut()
            .ok_or_else(|| anyhow!("Clipboard worker unavailable"))
    }
}
fn text(request: &Value) -> Result<Operation> {
    match request["action"].as_str() {
        Some("read") => Ok(Operation::Read),
        Some("clear") => Ok(Operation::Clear),
        Some("write") => {
            let text = request["text"]
                .as_str()
                .ok_or_else(|| anyhow!("Clipboard text must be a string"))?;
            ensure!(
                text.len() <= MAX_TEXT,
                "Clipboard text exceeds 8192 UTF-8 bytes"
            );
            ensure!(!text.contains('\0'), "Clipboard text must not contain NUL");
            Ok(Operation::Write(text.into()))
        }
        _ => Err(anyhow!("Unknown clipboard action")),
    }
}
pub fn submit(owner: u64, request: &Value) -> Result<Value> {
    Ok(json!({"id": submit_id(owner, request)?}))
}
fn submit_id(owner: u64, request: &Value) -> Result<u64> {
    let operation = text(request)?;
    let mut service = SERVICE
        .lock()
        .map_err(|_| anyhow!("Clipboard lock failed"))?;
    service.drain();
    ensure!(
        service.pending.len() < MAX_PENDING,
        "Clipboard request limit reached"
    );
    service.next += 1;
    let id = service.next;
    let worker = service.worker()?;
    worker
        .send
        .try_send(Task { id, operation })
        .map_err(|_| anyhow!("Clipboard queue full or stopped"))?;
    match worker.wake.write(&[1]) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
        Err(error) => return Err(error.into()),
    }
    service.pending.insert(
        id,
        Pending {
            owner,
            result: None,
        },
    );
    Ok(id)
}
fn request_id(request: &Value) -> Result<u64> {
    request["requestId"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(|| anyhow!("Clipboard request id required"))
}
pub fn poll(owner: u64, request: &Value) -> Result<Value> {
    let id = request_id(request)?;
    let mut service = SERVICE
        .lock()
        .map_err(|_| anyhow!("Clipboard lock failed"))?;
    service.drain();
    let pending = service
        .pending
        .get(&id)
        .filter(|p| p.owner == owner)
        .ok_or_else(|| anyhow!("Unknown clipboard request"))?;
    if pending.result.is_none() {
        if !service
            .worker
            .as_ref()
            .is_some_and(|w| !w.thread.is_finished())
        {
            service.pending.remove(&id);
            return Err(anyhow!("Clipboard worker stopped"));
        }
        return Ok(json!({ "pending": true }));
    }
    let pending = service
        .pending
        .remove(&id)
        .ok_or_else(|| anyhow!("Clipboard request disappeared"))?;
    match pending.result {
        Some(Ok(value)) => Ok(json!({ "pending": false, "value": value })),
        Some(Err(error)) => Err(anyhow!(error)),
        None => Err(anyhow!("Clipboard result unavailable")),
    }
}
pub fn cancel(owner: u64, request: &Value) -> Result<()> {
    let id = request_id(request)?;
    let mut service = SERVICE
        .lock()
        .map_err(|_| anyhow!("Clipboard lock failed"))?;
    ensure!(
        service.pending.get(&id).is_some_and(|p| p.owner == owner),
        "Unknown clipboard request"
    );
    service.pending.remove(&id);
    Ok(())
}
pub fn close_window(owner: u64) {
    if let Ok(mut service) = SERVICE.lock() {
        service.pending.retain(|_, p| p.owner != owner);
        service.drain();
    }
    let removed = BROWSER.with(|requests| {
        let mut requests = requests.borrow_mut();
        let ids: Vec<_> = requests
            .iter()
            .filter(|(_, request)| request.owner == owner)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| requests.remove(&id))
            .collect::<Vec<_>>()
    });
    for pending in removed {
        if let Some(request) = pending.request {
            request.failure("Clipboard window closed or navigated".into());
        }
    }
}
/// Queue Servo's clipboard callbacks on the same bounded service as SDK requests.
pub fn browser(owner: u64, contents: Option<String>, request: Option<servo::StringRequest>) {
    let payload = match contents {
        Some(text) => json!({"action":"write","text":text}),
        None => json!({"action":"read"}),
    };
    browser_submit(owner, &payload, request);
}
pub fn browser_clear(owner: u64) {
    browser_submit(owner, &json!({"action":"clear"}), None);
}
fn browser_submit(owner: u64, payload: &Value, request: Option<servo::StringRequest>) {
    match submit_id(owner, payload) {
        Ok(id) => {
            BROWSER.with(|requests| {
                requests
                    .borrow_mut()
                    .insert(id, BrowserRequest { owner, request })
            });
        }
        Err(error) => {
            if let Some(request) = request {
                request.failure(error.to_string());
            } else {
                log::warn!("Browser clipboard: {error}");
            }
        }
    }
}
/// Called only on worker replies; browser operations need no polling timer.
pub fn deliver_browser() {
    let ready = BROWSER.with(|requests| {
        let mut requests = requests.borrow_mut();
        let ids: Vec<_> = requests.keys().copied().collect();
        let mut ready = Vec::new();
        for id in ids {
            let owner = requests[&id].owner;
            match poll(owner, &json!({"requestId":id})) {
                Ok(value) if value["pending"] == true => {}
                result => {
                    if let Some(pending) = requests.remove(&id) {
                        ready.push((pending, result));
                    }
                }
            }
        }
        ready
    });
    for (pending, result) in ready {
        match (pending.request, result) {
            (Some(request), Ok(value)) => {
                request.success(value["value"].as_str().unwrap_or_default().into())
            }
            (Some(request), Err(error)) => request.failure(error.to_string()),
            (None, Err(error)) => log::warn!("Browser clipboard write: {error}"),
            (None, Ok(_)) => {}
        }
    }
}
pub fn shutdown() {
    BROWSER.with(|requests| requests.borrow_mut().clear());
    let worker = if let Ok(mut service) = SERVICE.lock() {
        service.connection.take();
        service.proxy.take();
        service.pending.clear();
        service.worker.take()
    } else {
        None
    };
    if let Some(Worker {
        send,
        mut wake,
        thread,
        receive,
    }) = worker
    {
        drop(send);
        let _ = wake.write(&[1]);
        drop(wake);
        drop(receive);
        let _ = thread.join();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_disconnect_fails_waiters_without_losing_completed_results() -> Result<()> {
        let (send, _tasks) = mpsc::sync_channel(1);
        let (replies, receive) = mpsc::channel();
        let (wake, _reader) = UnixStream::pair()?;
        let mut service = Service {
            worker: Some(Worker {
                send,
                receive,
                wake,
                thread: std::thread::spawn(|| {}),
            }),
            ..Service::default()
        };
        service.pending.insert(
            1,
            Pending {
                owner: 7,
                result: None,
            },
        );
        service.pending.insert(
            2,
            Pending {
                owner: 7,
                result: Some(Ok(json!("complete"))),
            },
        );
        drop(replies);
        service.drain();
        assert_eq!(
            service.pending[&1].result,
            Some(Err("Clipboard worker stopped".into()))
        );
        assert_eq!(service.pending[&2].result, Some(Ok(json!("complete"))));
        if let Some(worker) = service.worker.take() {
            let _ = worker.thread.join();
        }
        Ok(())
    }
    #[test]
    fn text_and_native_payload_are_bounded() {
        assert!(text(&json!({"action":"write","text":"한".repeat(2730)})).is_ok());
        assert!(text(&json!({"action":"write","text":"한".repeat(2731)})).is_err());
        assert!(text(&json!({"action":"write","text":"\0"})).is_err());
        assert!(text(&json!({"action":"write","text":42})).is_err());
        assert!(text(&json!({"action":"write","text":""})).is_ok());
    }
    #[test]
    fn replies_and_cancellation_belong_to_the_requesting_window() -> Result<()> {
        SERVICE
            .lock()
            .map_err(|_| anyhow!("test lock"))?
            .pending
            .insert(
                99,
                Pending {
                    owner: 7,
                    result: Some(Ok(json!("private"))),
                },
            );
        let request = json!({"requestId":99});
        assert!(poll(8, &request).is_err());
        assert!(cancel(8, &request).is_err());
        assert_eq!(poll(7, &request)?["value"], "private");
        assert!(poll(7, &request).is_err());
        SERVICE
            .lock()
            .map_err(|_| anyhow!("test lock"))?
            .pending
            .insert(
                100,
                Pending {
                    owner: 8,
                    result: None,
                },
            );
        close_window(7);
        assert!(
            SERVICE
                .lock()
                .map_err(|_| anyhow!("test lock"))?
                .pending
                .contains_key(&100)
        );
        close_window(8);
        assert!(
            !SERVICE
                .lock()
                .map_err(|_| anyhow!("test lock"))?
                .pending
                .contains_key(&100)
        );
        Ok(())
    }
}
