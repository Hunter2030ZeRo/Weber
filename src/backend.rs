use anyhow::{Context, Result, anyhow, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const MAX_REPLY: usize = 1024 * 1024;
const MAX_REQUEST: usize = 48 * 1024;
const MAX_PENDING: usize = 128;
struct Pending {
    owner: u64,
    created: Instant,
    result: Option<Value>,
}
struct State {
    alive: bool,
    failure: String,
    pending: BTreeMap<u64, Pending>,
    subscriptions: BTreeMap<u64, u64>,
    events: VecDeque<(u64, Value)>,
    event_bytes: usize,
    delivering: BTreeMap<u64, (u64, bool)>,
    ended: BTreeSet<u64>,
}
struct Bridge {
    child: Child,
    writes: mpsc::SyncSender<String>,
    state: Arc<Mutex<State>>,
    capability: String,
    runtime: String,
    next: u64,
}
impl Drop for Bridge {
    fn drop(&mut self) {
        kill_group(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Reader/writer threads own only pipes/shared state. They are not joined
        // on the UI thread: an app's grandchild may have inherited a pipe.
    }
}
#[cfg(target_os = "linux")]
#[expect(
    unsafe_code,
    reason = "Kill only the dedicated process group created for this owned backend"
)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}
#[cfg(not(target_os = "linux"))]
fn kill_group(_: u32) {}

#[cfg(target_os = "linux")]
#[expect(
    unsafe_code,
    reason = "Async-signal-safe syscalls in pre_exec ensure an owned backend dies with its parent"
)]
fn parent_lifetime(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    let parent = std::process::id();
    command.process_group(0);
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent as libc::pid_t {
                libc::raise(libc::SIGKILL);
            }
            Ok(())
        });
    }
}
#[cfg(not(target_os = "linux"))]
fn parent_lifetime(_: &mut Command) {}
static WAKE_PENDING: AtomicBool = AtomicBool::new(false);
type WakeCallback = Box<dyn Fn() + Send>;
static WAKER: Mutex<Option<WakeCallback>> = Mutex::new(None);
pub fn set_waker(waker: winit::event_loop::EventLoopProxy<crate::host::Wake>) {
    set_wake_callback(move || {
        let _ = waker.send_event(crate::host::Wake::Backend);
    });
}
pub fn set_wake_callback(waker: impl Fn() + Send + 'static) {
    if let Ok(mut slot) = WAKER.lock() {
        *slot = Some(Box::new(waker));
    }
}
fn notify() {
    if !WAKE_PENDING.swap(true, Ordering::AcqRel)
        && let Ok(slot) = WAKER.lock()
        && let Some(waker) = &*slot
    {
        waker();
    }
}
pub fn take_events() -> Vec<(u64, Value)> {
    if let Ok(slot) = BACKEND.lock()
        && let Some(bridge) = &*slot
        && let Ok(mut state) = bridge.state.lock()
    {
        WAKE_PENDING.store(false, Ordering::Release);
        let mut deliver = Vec::new();
        let mut retained = VecDeque::new();
        while let Some((owner, event)) = state.events.pop_front() {
            if let std::collections::btree_map::Entry::Vacant(entry) = state.delivering.entry(owner)
            {
                entry.insert((event["id"].as_u64().unwrap_or(0), event["kind"] == "end"));
                state.event_bytes = state.event_bytes.saturating_sub(event.to_string().len());
                deliver.push((owner, event));
            } else {
                retained.push_back((owner, event));
            }
        }
        state.events = retained;
        return deliver;
    }
    Vec::new()
}
pub fn acknowledge(owner: u64) {
    if let Ok(slot) = BACKEND.lock()
        && let Some(bridge) = &*slot
        && let Ok(mut state) = bridge.state.lock()
    {
        if let Some((id, terminal)) = state.delivering.remove(&owner)
            && terminal
        {
            state.subscriptions.remove(&id);
            state.ended.remove(&id);
        }
        if state
            .events
            .iter()
            .any(|(candidate, _)| *candidate == owner)
        {
            notify();
        }
    }
}
pub fn close_window(owner: u64) {
    if let Ok(mut slot) = BACKEND.lock()
        && let Some(bridge) = &mut *slot
        && let Ok(mut state) = bridge.state.lock()
    {
        let calls: Vec<_> = state
            .pending
            .iter()
            .filter_map(|(id, call)| (call.owner == owner).then_some(*id))
            .collect();
        for id in calls {
            state.pending.remove(&id);
            let _ = bridge
                .writes
                .try_send(json!({ "op": "cancel", "id": id }).to_string());
        }
        let ids: Vec<_> = state
            .subscriptions
            .iter()
            .filter_map(|(id, candidate)| (*candidate == owner).then_some(*id))
            .collect();
        for id in ids {
            state.subscriptions.remove(&id);
            state.ended.remove(&id);
            let _ = bridge
                .writes
                .try_send(json!({ "op": "cancel", "id": id }).to_string());
        }
        state.delivering.remove(&owner);
        state.events.retain(|(candidate, _)| *candidate != owner);
        state.event_bytes = state
            .events
            .iter()
            .map(|(_, value)| value.to_string().len())
            .sum();
    }
}
static BACKEND: Mutex<Option<Bridge>> = Mutex::new(None);
pub struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        if let Ok(mut slot) = BACKEND.lock() {
            slot.take();
        }
    }
}
pub(crate) fn random_capability() -> Result<String> {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .ok_or_else(|| anyhow!("TLS provider missing"))?;
    let mut bytes = [0; 32];
    provider
        .secure_random
        .fill(&mut bytes)
        .map_err(|_| anyhow!("Capability generation failed"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
pub fn start(path: &Path, cwd: &Path, supplied: Option<String>) -> Result<Guard> {
    let capability = supplied.map_or_else(random_capability, Ok)?;
    ensure!(
        capability.len() == 64 && capability.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid backend capability"
    );
    let mut slot = BACKEND.lock().map_err(|_| anyhow!("Backend lock failed"))?;
    ensure!(slot.is_none(), "Backend already started");
    let mut command = Command::new(path);
    command
        .current_dir(cwd)
        .env("WEBER_APP_DIR", cwd)
        .env("WEBER_HOST_EXECUTABLE", std::env::current_exe()?)
        .env_remove("XDG_ACTIVATION_TOKEN")
        .env_remove("DESKTOP_STARTUP_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    parent_lifetime(&mut command);
    let mut child = command.spawn().context("Starting Bun backend")?;
    let input = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Backend stdin missing"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Backend stdout missing"))?;
    let state = Arc::new(Mutex::new(State {
        alive: true,
        failure: String::new(),
        pending: BTreeMap::new(),
        subscriptions: BTreeMap::new(),
        events: VecDeque::new(),
        event_bytes: 0,
        delivering: BTreeMap::new(),
        ended: BTreeSet::new(),
    }));
    let (writes, receive) = mpsc::sync_channel::<String>(MAX_PENDING);
    let (ready, hello) = mpsc::sync_channel::<Result<String, String>>(1);
    let writer_state = state.clone();
    std::thread::spawn(move || {
        let mut input = input;
        for line in receive {
            if let Err(error) = input
                .write_all(line.as_bytes())
                .and_then(|()| input.write_all(b"\n"))
            {
                fail(&writer_state, format!("Backend write failed: {error}"));
                break;
            }
        }
    });
    let reader_state = state.clone();
    let reader_writes = writes.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let result = (|| -> Result<()> {
            let first = packet(&mut reader)?;
            ensure!(
                first["protocol"] == 1 && first["ready"] == true,
                "Backend startup failed: {first}"
            );
            let version = first["runtime"]
                .as_str()
                .ok_or_else(|| anyhow!("Backend runtime version missing"))?;
            ready
                .send(Ok(version.to_owned()))
                .map_err(|_| anyhow!("Backend startup abandoned"))?;
            loop {
                let reply = packet(&mut reader)?;
                let id = reply["id"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("Backend response id missing"))?;
                if reply["kind"] == "event" || reply["kind"] == "end" {
                    ensure!(
                        if reply["kind"] == "event" {
                            reply.get("value").is_some()
                        } else {
                            reply["ok"].is_boolean()
                        },
                        "Invalid backend event"
                    );
                    let mut shared = reader_state
                        .lock()
                        .map_err(|_| anyhow!("Backend state poisoned"))?;
                    if let Some(owner) = shared.subscriptions.get(&id).copied() {
                        if shared.ended.contains(&id) {
                            continue;
                        }
                        let mut event = reply;
                        let bytes = event.to_string().len();
                        if bytes > 32768
                            || shared.events.len() >= 128
                            || shared.event_bytes + bytes > 2 * 1024 * 1024
                        {
                            shared.ended.insert(id);
                            let _ = reader_writes
                                .try_send(json!({ "op": "cancel", "id": id }).to_string());
                            shared
                                .events
                                .retain(|(_, value)| value["id"].as_u64() != Some(id));
                            shared.event_bytes = shared
                                .events
                                .iter()
                                .map(|(_, value)| value.to_string().len())
                                .sum();
                            event = json!({ "id": id, "kind": "end", "ok": false, "error": { "name": "BackendOverflowError", "message": "Backend event queue overflow" } });
                        } else if event["kind"] == "end" {
                            shared.ended.insert(id);
                        }
                        shared.event_bytes += event.to_string().len();
                        shared.events.push_back((owner, event));
                        let wake = !shared.delivering.contains_key(&owner);
                        drop(shared);
                        if wake {
                            notify();
                        }
                    }
                    continue;
                }
                ensure!(reply["ok"].is_boolean(), "Invalid backend response");
                ensure!(
                    if reply["ok"] == true {
                        reply.get("result").is_some()
                    } else {
                        reply["error"]["message"].is_string()
                    },
                    "Invalid backend response payload"
                );
                let mut shared = reader_state
                    .lock()
                    .map_err(|_| anyhow!("Backend state poisoned"))?;
                if let Some(call) = shared.pending.get_mut(&id) {
                    call.result = Some(reply);
                }
            }
        })();
        if let Err(error) = result {
            let message = format!("Backend stopped: {error}");
            let _ = ready.try_send(Err(message.clone()));
            fail(&reader_state, message);
        }
    });
    let mut bridge = Bridge {
        child,
        writes,
        state,
        capability,
        runtime: String::new(),
        next: 1,
    };
    bridge.runtime = hello
        .recv_timeout(Duration::from_secs(5))
        .context("Bun backend startup timeout")?
        .map_err(anyhow::Error::msg)?;
    *slot = Some(bridge);
    Ok(Guard)
}
fn packet(reader: &mut BufReader<std::process::ChildStdout>) -> Result<Value> {
    let mut bytes = Vec::new();
    let length = reader
        .take(MAX_REPLY as u64 + 1)
        .read_until(b'\n', &mut bytes)?;
    ensure!(length > 0, "Backend stdout closed");
    ensure!(
        length <= MAX_REPLY && bytes.last() == Some(&b'\n'),
        "Backend response exceeds limit or is truncated"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
fn fail(state: &Mutex<State>, message: String) {
    if let Ok(mut state) = state.lock() {
        state.alive = false;
        state.failure = message.clone();
        let subscriptions = state.subscriptions.clone();
        for (id, owner) in subscriptions {
            if !state.ended.insert(id) {
                continue;
            }
            state.events.push_back((owner, json!({ "id": id, "kind": "end", "ok": false, "error": { "name": "BackendError", "message": message } })));
        }
        notify();
        for call in state.pending.values_mut() {
            if call.result.is_none() {
                call.result = Some(
                    json!({ "ok": false, "error": { "name": "BackendError", "message": message } }),
                );
            }
        }
    }
}
pub fn capability() -> Option<String> {
    BACKEND
        .lock()
        .ok()?
        .as_ref()
        .map(|bridge| bridge.capability.clone())
}
pub fn authorized(candidate: &str) -> bool {
    capability().is_some_and(|expected| expected == candidate)
}
pub fn exchange(payload: &str) -> String {
    let result = (|| -> Result<Value> {
        ensure!(
            payload.len() <= MAX_REQUEST,
            "Backend request exceeds 48KiB"
        );
        let request: Value = serde_json::from_str(payload)?;
        let mut slot = BACKEND.lock().map_err(|_| anyhow!("Backend lock failed"))?;
        let bridge = slot
            .as_mut()
            .ok_or_else(|| anyhow!("This application has no Bun backend"))?;
        let mut state = bridge
            .state
            .lock()
            .map_err(|_| anyhow!("Backend state failed"))?;
        state
            .pending
            .retain(|_, call| call.created.elapsed() < Duration::from_secs(65));
        match request["op"].as_str() {
            Some("call" | "subscribe") => {
                ensure!(state.alive, "{}", state.failure);
                let method = request["method"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Backend method required"))?;
                ensure!(
                    !method.is_empty()
                        && method.len() <= 128
                        && method.as_bytes()[0].is_ascii_alphabetic()
                        && method
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)),
                    "Invalid backend method"
                );
                ensure!(
                    state.pending.len() + state.subscriptions.len() < MAX_PENDING,
                    "Too many pending backend calls"
                );
                ensure!(
                    bridge.next < 9_007_199_254_740_991,
                    "Backend request id exhausted"
                );
                let id = bridge.next;
                bridge.next += 1;
                let line = serde_json::to_string(
                    &json!({ "op": request["op"], "id": id, "method": method, "params": request.get("params").unwrap_or(&Value::Null) }),
                )?;
                if request["op"] == "subscribe" {
                    ensure!(
                        state.subscriptions.len() < 64,
                        "Too many backend subscriptions"
                    );
                    state.subscriptions.insert(id, crate::native::current_id());
                } else {
                    state.pending.insert(
                        id,
                        Pending {
                            owner: crate::native::current_id(),
                            created: Instant::now(),
                            result: None,
                        },
                    );
                }
                if let Err(error) = bridge.writes.try_send(line) {
                    state.pending.remove(&id);
                    state.subscriptions.remove(&id);
                    return Err(anyhow!("Backend write queue unavailable: {error}"));
                }
                Ok(json!({ "ok": true, "id": id }))
            }
            Some("poll") => {
                let id = request["id"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("Backend request id required"))?;
                let call = state
                    .pending
                    .get_mut(&id)
                    .ok_or_else(|| anyhow!("Unknown backend request"))?;
                if let Some(result) = call.result.take() {
                    state.pending.remove(&id);
                    return Ok(result);
                }
                ensure!(state.alive, "{}", state.failure);
                Ok(json!({ "ok": true, "pending": true }))
            }
            Some("cancel") => {
                let id = request["id"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("Backend request id required"))?;
                state.pending.remove(&id);
                state.subscriptions.remove(&id);
                state.ended.remove(&id);
                state
                    .events
                    .retain(|(_, value)| value["id"].as_u64() != Some(id));
                state.event_bytes = state
                    .events
                    .iter()
                    .map(|(_, value)| value.to_string().len())
                    .sum();
                let _ = bridge
                    .writes
                    .try_send(serde_json::to_string(&json!({ "op": "cancel", "id": id }))?);
                Ok(json!({ "ok": true }))
            }
            Some("status") => Ok(
                json!({ "ok": true, "alive": state.alive, "pid": bridge.child.id(), "runtime": bridge.runtime, "pending": state.pending.len() }),
            ),
            _ => Err(anyhow!("Unknown backend operation")),
        }
    })();
    let reply = match result {
        Ok(value) => value,
        Err(error) => {
            json!({ "ok": false, "error": { "name": "BackendError", "message": error.to_string() } })
        }
    };
    reply.to_string()
}
