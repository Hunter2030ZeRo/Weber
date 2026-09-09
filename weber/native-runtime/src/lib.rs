//! Synchronous Rust main-process API for Weber's actual desktop host.
//!
//! No Node.js, Bun, Chromium, or GUI toolkit is linked into the caller. Runtime
//! and window handles share one owned host process and are intentionally !Send.
//! The host supplies the native windows and isolated Obscura renderer processes.

use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_MESSAGE: usize = 1024 * 1024;
const MAX_EVENTS: usize = 64;

#[derive(Debug)]
pub enum Error {
    Configuration(String),
    Transport(String),
    Host(String),
    Timeout,
    Closed,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) | Self::Transport(message) | Self::Host(message) => formatter.write_str(message),
            Self::Timeout => formatter.write_str("Weber desktop request timed out"),
            Self::Closed => formatter.write_str("Weber runtime or window is closed"),
        }
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Event {
    FramePresented { window_id: u64, width: u64, height: u64 },
    Closed { window_id: u64 },
    Other(Value),
}

pub struct WindowOptions {
    pub width: u32,
    pub height: u32,
    pub title: String,
    pub show: bool,
}

impl Default for WindowOptions {
    fn default() -> Self {
        Self { width: 800, height: 600, title: "Weber".into(), show: true }
    }
}

pub struct Runtime { host: Rc<RefCell<Host>> }
pub struct Window { host: Rc<RefCell<Host>>, id: u64, renderer_pid: u32 }

impl Runtime {
    /// Spawn the desktop host selected by the project launcher. The explicit
    /// development sandbox opt-in is inherited, never enabled by this library.
    pub fn from_env() -> Result<Self> {
        let host = env_path("WEBER_DESKTOP_HOST")?;
        let renderer = env_path("WEBER_OBSCURA_RENDERER")?;
        Self::spawn(&host, &renderer, Duration::from_secs(30))
    }

    /// Spawn an owned host, pass the renderer path as its sole argument, and
    /// validate its protocol handshake before returning. Paths must be absolute.
    pub fn spawn(host: &Path, renderer: &Path, timeout: Duration) -> Result<Self> {
        validate_path(host, "desktop host")?;
        validate_path(renderer, "Obscura renderer")?;
        if timeout.is_zero() { return Err(Error::Configuration("Timeout must be positive".into())); }
        let mut host = Host::spawn(host, renderer, timeout)?;
        let handshake = host.receive(Instant::now() + timeout);
        match handshake {
            Ok(message) if message["event"] == "ready" && message["protocol"] == 1 && message["engine"] == "obscura" => {}
            Ok(message) => return Err(host.fail(format!("Invalid desktop handshake: {message}"))),
            Err(error) => { host.shutdown(true); return Err(error); }
        }
        Ok(Self { host: Rc::new(RefCell::new(host)) })
    }

    pub fn host_pid(&self) -> u32 { self.host.borrow().child.id() }

    pub fn create_window(&self, options: WindowOptions) -> Result<Window> {
        if options.width == 0 || options.height == 0 || options.width > 8192 || options.height > 8192
            || u64::from(options.width) * u64::from(options.height) > 16_000_000 {
            return Err(Error::Configuration("Invalid Weber window dimensions".into()));
        }
        let mut host = self.host.borrow_mut();
        host.next_window += 1;
        let id = host.next_window;
        if id > i32::MAX as u64 { return Err(Error::Configuration("Window ID limit reached".into())); }
        let result = host.request(json!({"method": "window.create", "windowId": id,
            "options": {"width": options.width, "height": options.height, "title": options.title, "show": options.show}}))?;
        let pid = result["rendererPid"].as_u64().and_then(|pid| u32::try_from(pid).ok()).filter(|pid| *pid > 0);
        if result["windowId"].as_u64() != Some(id) || pid.is_none() {
            return Err(host.fail(format!("Invalid window creation result: {result}")));
        }
        Ok(Window { host: Rc::clone(&self.host), id, renderer_pid: pid.expect("validated pid") })
    }

    /// Return queued events first, then wait up to `timeout`. An idle timeout
    /// returns None and does not invalidate the connection.
    pub fn next_event(&self, timeout: Duration) -> Result<Option<Event>> {
        self.host.borrow_mut().next_event(timeout)
    }

    /// Close all windows and wait for host shutdown. Idempotent after quitting.
    pub fn quit(&self) -> Result<()> {
        let mut host = self.host.borrow_mut();
        if host.closed { return Ok(()); }
        let result = host.request(json!({"method": "app.quit"})).map(|_| ());
        host.shutdown(result.is_err());
        result
    }
}

impl Window {
    pub fn id(&self) -> u64 { self.id }
    pub fn renderer_pid(&self) -> u32 { self.renderer_pid }
    pub fn is_closed(&self) -> bool {
        let host = self.host.borrow();
        host.closed || host.closed_windows.contains(&self.id)
    }

    fn command(&self, command: Value) -> Result<Value> {
        let mut host = self.host.borrow_mut();
        if host.closed_windows.contains(&self.id) { return Err(Error::Closed); }
        host.request(json!({"method": "page.command", "windowId": self.id, "command": command}))
    }

    /// Resolve a document relative to the main process's working directory
    /// (the project directory when launched through weber-backend).
    pub fn load_file(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref().canonicalize().map_err(|error| Error::Configuration(format!("Page path: {error}")))?;
        let path = path.to_str().ok_or_else(|| Error::Configuration("The JSON host protocol requires UTF-8 page paths".into()))?;
        self.command(json!({"method": "loadFile", "path": path})).map(|_| ())
    }

    pub fn evaluate(&self, source: &str) -> Result<Value> {
        self.command(json!({"method": "evaluate", "source": source}))
    }

    /// Wait until GTK has presented this window's first Obscura frame. Events
    /// remain available through Runtime::next_event after this check.
    pub fn wait_for_frame(&self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        let mut host = self.host.borrow_mut();
        while !host.presented.contains(&self.id) {
            if host.closed || host.closed_windows.contains(&self.id) { return Err(Error::Closed); }
            let event = match host.receive(deadline) {
                Ok(event) => event,
                Err(Error::Timeout) => return Err(Error::Timeout),
                Err(error) => { host.shutdown(true); return Err(error); }
            };
            if let Err(error) = host.record_event(event) { host.shutdown(true); return Err(error); }
        }
        Ok(())
    }

    pub fn close(&self) -> Result<()> {
        let mut host = self.host.borrow_mut();
        if host.closed || host.closed_windows.contains(&self.id) { return Ok(()); }
        host.request(json!({"method": "window.close", "windowId": self.id}))?;
        host.closed_windows.insert(self.id);
        Ok(())
    }
}

fn validate_path(path: &Path, label: &str) -> Result<()> {
    if !path.is_absolute() || !path.is_file() {
        return Err(Error::Configuration(format!("{label} must name an existing absolute file path")));
    }
    Ok(())
}
fn env_path(name: &str) -> Result<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
        .ok_or_else(|| Error::Configuration(format!("{name} is required")))
}

struct WriteRequest { bytes: Vec<u8>, done: mpsc::Sender<std::result::Result<(), String>> }
struct Host {
    child: Child,
    writes: Option<SyncSender<WriteRequest>>,
    replies: Option<Receiver<Result<Value>>>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    timeout: Duration,
    next_id: u64,
    next_window: u64,
    closed: bool,
    events: VecDeque<Event>,
    presented: HashSet<u64>,
    closed_windows: HashSet<u64>,
}

impl Host {
    fn spawn(host: &Path, renderer: &Path, timeout: Duration) -> Result<Self> {
        let mut child = Command::new(host).arg(renderer)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
            .spawn().map_err(|error| Error::Transport(format!("Cannot start Weber desktop host: {error}")))?;
        let mut input = child.stdin.take().expect("piped stdin");
        let output = child.stdout.take().expect("piped stdout");
        let (writes, incoming_writes) = mpsc::sync_channel::<WriteRequest>(1);
        let writer = thread::spawn(move || {
            for request in incoming_writes {
                let result = input.write_all(&request.bytes).and_then(|_| input.flush()).map_err(|error| error.to_string());
                let failed = result.is_err();
                let _ = request.done.send(result);
                if failed { break; }
            }
        });
        let (sender, replies) = mpsc::sync_channel(4);
        let reader = thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let read = output.by_ref().take(MAX_MESSAGE as u64 + 1).read_until(b'\n', &mut line);
                let message = match read {
                    Ok(0) => break,
                    Ok(_) if line.len() > MAX_MESSAGE => Err(Error::Transport("Host response exceeds 1 MiB".into())),
                    Ok(_) if !line.ends_with(b"\n") => Err(Error::Transport("Host response ended before its newline".into())),
                    Ok(_) => serde_json::from_slice(&line).map_err(|error| Error::Transport(format!("Invalid host JSON: {error}"))),
                    Err(error) => Err(Error::Transport(format!("Reading host response: {error}"))),
                };
                let failed = message.is_err();
                if sender.send(message).is_err() || failed { break; }
            }
        });
        Ok(Self { child, writes: Some(writes), replies: Some(replies), writer: Some(writer), reader: Some(reader),
            timeout, next_id: 0, next_window: 0, closed: false, events: VecDeque::new(), presented: HashSet::new(), closed_windows: HashSet::new() })
    }

    fn receive(&self, deadline: Instant) -> Result<Value> {
        if self.closed { return Err(Error::Closed); }
        let remaining = deadline.checked_duration_since(Instant::now()).ok_or(Error::Timeout)?;
        self.replies.as_ref().ok_or(Error::Closed)?.recv_timeout(remaining).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => Error::Timeout,
            mpsc::RecvTimeoutError::Disconnected => Error::Transport("Desktop host output closed".into()),
        })?
    }

    fn request(&mut self, mut message: Value) -> Result<Value> {
        if self.closed { return Err(Error::Closed); }
        self.next_id = self.next_id.checked_add(1).ok_or_else(|| Error::Configuration("Request ID limit reached".into()))?;
        let id = self.next_id;
        message["id"] = json!(id);
        let mut bytes = serde_json::to_vec(&message).map_err(|error| Error::Configuration(error.to_string()))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_MESSAGE { return Err(Error::Configuration("Host request exceeds 1 MiB".into())); }
        let result = self.exchange(id, bytes);
        if matches!(&result, Err(Error::Transport(_)) | Err(Error::Timeout) | Err(Error::Closed)) { self.shutdown(true); }
        result
    }

    fn exchange(&mut self, id: u64, bytes: Vec<u8>) -> Result<Value> {
        let deadline = Instant::now() + self.timeout;
        let (done, written) = mpsc::channel();
        self.writes.as_ref().ok_or(Error::Closed)?.try_send(WriteRequest { bytes, done })
            .map_err(|error| Error::Transport(format!("Host input unavailable: {error}")))?;
        written.recv_timeout(self.timeout).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => Error::Timeout,
            mpsc::RecvTimeoutError::Disconnected => Error::Transport("Desktop host input closed".into()),
        })?.map_err(|error| Error::Transport(format!("Writing host request: {error}")))?;
        loop {
            let response = self.receive(deadline)?;
            if response.get("event").is_some() { self.record_event(response)?; continue; }
            if response["id"].as_u64() != Some(id) {
                return Err(Error::Transport(format!("Unexpected host request id: {}", response["id"])));
            }
            if let Some(error) = response.get("error") { return Err(Error::Host(format!("Host error: {error}"))); }
            return response.get("result").cloned().ok_or_else(|| Error::Transport("Host response has no result".into()));
        }
    }

    fn record_event(&mut self, message: Value) -> Result<()> {
        let name = message["event"].as_str().ok_or_else(|| Error::Transport("Expected a host event".into()))?;
        if name == "protocol-error" { return Err(Error::Transport(format!("Host protocol error: {message}"))); }
        if self.events.len() >= MAX_EVENTS { return Err(Error::Transport("Event queue overflow; poll Runtime::next_event regularly".into())); }
        let window_id = message["windowId"].as_u64();
        let id = || window_id.ok_or_else(|| Error::Transport("Event has no windowId".into()));
        let event = match name {
            "frame-presented" => {
                let window_id = id()?;
                let width = message["width"].as_u64().ok_or_else(|| Error::Transport("Frame has no width".into()))?;
                let height = message["height"].as_u64().ok_or_else(|| Error::Transport("Frame has no height".into()))?;
                self.presented.insert(window_id);
                Event::FramePresented { window_id, width, height }
            }
            "closed" => { let window_id = id()?; self.closed_windows.insert(window_id); Event::Closed { window_id } }
            _ => Event::Other(message),
        };
        self.events.push_back(event);
        Ok(())
    }

    fn next_event(&mut self, timeout: Duration) -> Result<Option<Event>> {
        if let Some(event) = self.events.pop_front() { return Ok(Some(event)); }
        let incoming = if timeout.is_zero() {
            self.replies.as_ref().ok_or(Error::Closed)?.try_recv().map_err(|error| match error {
                mpsc::TryRecvError::Empty => Error::Timeout,
                mpsc::TryRecvError::Disconnected => Error::Transport("Desktop host output closed".into()),
            }).and_then(|message| message)
        } else { self.receive(Instant::now() + timeout) };
        let message = match incoming {
            Ok(message) => message,
            Err(Error::Timeout) => return Ok(None),
            Err(error) => { self.shutdown(true); return Err(error); }
        };
        if let Err(error) = self.record_event(message) { self.shutdown(true); return Err(error); }
        Ok(self.events.pop_front())
    }

    fn fail(&mut self, message: String) -> Error { self.shutdown(true); Error::Transport(message) }

    fn shutdown(&mut self, force: bool) {
        if self.closed { return; }
        self.closed = true;
        self.writes.take();
        // Release a reader blocked on its bounded channel before joining it.
        self.replies.take();
        if force { let _ = self.child.kill(); }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                _ if Instant::now() >= deadline => { let _ = self.child.kill(); let _ = self.child.wait(); break; }
                _ => thread::sleep(Duration::from_millis(10)),
            }
        }
        if let Some(writer) = self.writer.take() { let _ = writer.join(); }
        if let Some(reader) = self.reader.take() { let _ = reader.join(); }
    }
}

impl Drop for Host { fn drop(&mut self) { self.shutdown(false); } }
