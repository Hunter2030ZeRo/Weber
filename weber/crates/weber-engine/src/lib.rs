//! Renderer-side C ABI. Never load alongside Electron's separate V8 build.
//! The caller owns valid input/callback pointers; all calls use the creating thread.
use std::{cell::RefCell, collections::{HashMap, VecDeque}, ffi::c_void, panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, atomic::{AtomicU64, Ordering}}, time::Duration};
use obscura_browser::{BrowserContext, Page};
use serde_json::{json, Value};

mod desktop;
mod preload;
mod protocol;
use obscura_net::desktop_protocol::DesktopProtocolHandler;

const MAX_REQUEST: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 64 * 1024 * 1024;
const MAX_CRITICAL_EVENTS: usize = 256;
const MAX_CRITICAL_BYTES: usize = 4 * 1024 * 1024;
// IDs are at most 128 UTF-8 bytes, including worst-case JSON escaping. This
// leaves ample room for a bounded completion failure and its generation.
const COMPLETION_RESERVE: usize = 2048;
static NEXT: AtomicU64 = AtomicU64::new(1);
thread_local! { static ENGINE: RefCell<Option<(u64, Engine)>> = const { RefCell::new(None) }; }
struct Engine {
    // Page/V8 must be destroyed before the Tokio runtime.
    page: Page,
    protocols: Option<Arc<protocol::Protocols>>,
    preload: preload::Preload,
    runtime: tokio::runtime::Runtime,
    loaded: bool,
    width: u32,
    height: u32,
    poisoned: bool,
    events: VecDeque<(Value, usize)>,
    event_bytes: usize,
    dropped_events: u64,
    critical_events: VecDeque<(Value, usize)>,
    critical_bytes: usize,
    queued_ipc: usize,
    // true: completion is pending; false: completion is queued but not polled.
    evaluation_tickets: HashMap<String, bool>,
}
type Reply = extern "C" fn(*const u8, usize, *mut c_void);

impl Engine {
    fn new() -> Result<Self, String> { Self::with_resources(-1) }
    fn with_resources(resource_fd: i32) -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all()
            .build().map_err(|e| e.to_string())?;
        let protocols = { let _guard = runtime.enter(); protocol::Protocols::from_fd(resource_fd)? };
        let mut page = {
            let _guard = runtime.enter();
            let mut page = Page::new("weber-renderer".into(), Arc::new(BrowserContext::new("weber-renderer".into())));
            page.set_navigation_timeout(Duration::from_secs(15));
            page.set_viewport((800., 600.));
            page
        };
        if let Some(protocols) = &protocols { *page.context.http_client.desktop_protocol.write().unwrap() = Some(protocols.clone()); }
        let preload = preload::Preload::new(&mut page);
        Ok(Self { page, protocols, preload, runtime, loaded: false, width: 800, height: 600, poisoned: false,
            events: VecDeque::new(), event_bytes: 0, dropped_events: 0,
            critical_events: VecDeque::new(), critical_bytes: 0, queued_ipc: 0,
            evaluation_tickets: HashMap::new() })
    }

    fn push_event(&mut self, event: Value) {
        let size = event.to_string().len();
        if size > MAX_REQUEST {
            self.dropped_events = self.dropped_events.saturating_add(1);
            return;
        }
        while self.events.len() >= 256 || self.event_bytes + size > MAX_REQUEST {
            if let Some((_, removed_size)) = self.events.pop_front() {
                self.event_bytes -= removed_size;
                self.dropped_events = self.dropped_events.saturating_add(1);
            }
        }
        self.event_bytes += size;
        self.events.push_back((event, size));
    }

    fn completion_reservations(&self) -> usize {
        self.evaluation_tickets.values().filter(|pending| **pending).count() * COMPLETION_RESERVE
    }

    fn push_critical_event(&mut self, mut event: Value) -> Result<(), String> {
        match event.get("type").and_then(Value::as_str) {
            Some("evaluation-result") => {
                let id = event.get("id").and_then(Value::as_str).ok_or("Missing completion ID")?.to_string();
                if self.evaluation_tickets.get(&id) != Some(&true) {
                    return Err("Unreserved or duplicate evaluation completion".into());
                }
                let remaining_reservations = self.completion_reservations() - COMPLETION_RESERVE;
                let available = MAX_CRITICAL_BYTES - self.critical_bytes - remaining_reservations;
                let mut size = event.to_string().len();
                if size > MAX_REQUEST || size > available {
                    event = json!({"type": "evaluation-result", "id": id,
                        "generation": self.preload.generation, "ok": false,
                        "error": "Evaluation result exceeded the bounded delivery queue; poll events before submitting more work"});
                    size = event.to_string().len();
                }
                if size > available || size > MAX_REQUEST {
                    return Err("Completion reservation invariant violated".into());
                }
                self.evaluation_tickets.insert(id, false);
                self.critical_bytes += size;
                self.critical_events.push_back((event, size));
            }
            Some("ipc-invoke") => {
                let size = event.to_string().len();
                if size > MAX_REQUEST
                    || self.evaluation_tickets.len() + self.queued_ipc >= MAX_CRITICAL_EVENTS
                    || self.critical_bytes + self.completion_reservations() + size > MAX_CRITICAL_BYTES {
                    // Reject only this invocation, using the existing isolated
                    // resolver. Accepted tickets already queued remain intact.
                    self.preload.command(&mut self.page, &json!({"method": "resolveIpc",
                        "generation": event["generation"], "id": event["id"], "ok": false,
                        "error": "IPC delivery queue is full; poll events before submitting more work"}))
                        .ok_or("Missing IPC resolver")??;
                    return Ok(());
                }
                self.queued_ipc += 1;
                self.critical_bytes += size;
                self.critical_events.push_back((event, size));
            }
            _ => return Err("Unsupported critical event".into()),
        }
        Ok(())
    }

    fn collect_navigation_request(&mut self) {
        if let Some((url, method, body)) = self.page.take_pending_navigation() {
            // Renderer observations are not navigation authorization. The browser
            // owner must apply its origin/permission policy before calling loadURL.
            self.push_event(json!({"type": "navigation-requested", "url": url,
                "method": method, "body": body, "sourceURL": self.page.url_string()}));
        }
    }

    fn navigate(&mut self, target: &str) -> Result<Vec<u8>, String> {
        let url = url::Url::parse(target).map_err(|e| e.to_string())?;
        match url.scheme() {
            "http" | "https" | "file" | "data" => {},
            "about" if url.as_str() == "about:blank" => {},
            scheme if self.protocols.as_ref().is_some_and(|p| p.accepts(scheme)) => {},
            _ => return Err("Unsupported navigation scheme".into()),
        }
        self.preload.before_navigation()?;
        self.events.clear();
        self.event_bytes = 0;
        self.dropped_events = 0;
        self.critical_events.clear();
        self.critical_bytes = 0;
        self.queued_ipc = 0;
        self.evaluation_tickets.clear();
        self.loaded = false;
        self.push_event(json!({"type": "navigation-started", "url": url.as_str(),
            "generation": self.preload.generation}));
        let result = self.runtime.block_on(self.page.navigate(url.as_str()));
        if let Err(error) = result {
            let error = error.to_string();
            self.push_event(json!({"type": "navigation-failed", "url": url.as_str(),
                "error": error, "generation": self.preload.generation}));
            return Err(error);
        }
        self.runtime.block_on(self.page.prepare_screenshot_resources(100));
        self.loaded = true;
        let state = json!({"url": self.page.url_string(), "title": self.page.title,
            "generation": self.preload.generation});
        self.push_event(json!({"type": "navigation-finished", "url": self.page.url_string(),
            "title": self.page.title, "generation": self.preload.generation}));
        self.collect_navigation_request();
        Ok(state.to_string().into_bytes())
    }

    fn pump_preload(&mut self) -> Result<(), String> {
        let result = self.preload.pump(&mut self.page).and_then(|events| {
            for event in events { self.push_critical_event(event)?; }
            Ok(())
        });
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                self.poisoned = true;
                Err(format!("Isolated bridge failed; renderer restart required: {error}"))
            }
        }
    }

    fn command(&mut self, value: Value) -> Result<Vec<u8>, String> {
        if self.poisoned { return Err("Engine is poisoned; destroy the renderer".into()); }
        let runtime_handle = self.runtime.handle().clone();
        let _guard = runtime_handle.enter();
        match value.get("method").and_then(Value::as_str).ok_or("Missing method")? {
            "configureProtocols" => {
                if let Some(protocols) = &self.protocols { protocols.configure(&value["schemes"])?; }
                else if value["schemes"].as_array().is_none_or(|v| !v.is_empty()) { return Err("Resource channel unavailable".into()); }
                Ok(b"null".to_vec())
            }
            "startEvaluation" => {
                let id = value.get("id").and_then(Value::as_str)
                    .filter(|id| !id.is_empty() && id.len() <= 128).ok_or("Invalid evaluation ID")?;
                if self.evaluation_tickets.contains_key(id) { return Err("Duplicate evaluation ID awaiting delivery".into()); }
                if self.evaluation_tickets.len() + self.queued_ipc >= MAX_CRITICAL_EVENTS
                    || self.critical_bytes + self.completion_reservations() + COMPLETION_RESERVE > MAX_CRITICAL_BYTES {
                    return Err("Evaluation delivery queue is full; pollEvents before submitting more work".into());
                }
                let response = self.preload.command(&mut self.page, &value)
                    .ok_or("Missing evaluation dispatcher")??;
                self.evaluation_tickets.insert(id.to_string(), true);
                Ok(response)
            }
            "loadFile" => {
                let path = value.get("path").and_then(Value::as_str).ok_or("Missing path")?;
                let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
                if !path.is_file() { return Err("Expected a file".into()); }
                let url = url::Url::from_file_path(path).map_err(|_| "Invalid path")?;
                self.navigate(url.as_str())
            }
            "loadURL" => {
                let target = value.get("url").and_then(Value::as_str).ok_or("Missing URL")?;
                self.navigate(target)
            }
            "setPreloadScripts" => {
                // Page preloads execute in the page's MAIN world. Do not pass
                // Electron's privileged preload here as contextIsolation=true.
                if value.get("world").and_then(Value::as_str) != Some("main") {
                    return Err("Only explicit main-world preloads are implemented".into());
                }
                let scripts = value.get("scripts").and_then(Value::as_array).ok_or("Missing scripts")?;
                if scripts.len() > 128 { return Err("Too many preload scripts".into()); }
                let scripts: Result<Vec<_>, _> = scripts.iter().map(|script|
                    script.as_str().map(str::to_owned).ok_or("Expected preload source string")).collect();
                self.page.set_preload_scripts(scripts?);
                Ok(b"null".to_vec())
            }
            "viewport" => {
                let width = value.get("width").and_then(Value::as_u64).ok_or("Missing width")?;
                let height = value.get("height").and_then(Value::as_u64).ok_or("Missing height")?;
                // A raw frame includes the 12-byte OBF1 header in MAX_RESPONSE.
                if width == 0 || height == 0 || width > 8192 || height > 8192
                    || width * height > ((MAX_RESPONSE - 12) / 4) as u64 {
                    return Err("Viewport exceeds bounds".into());
                }
                self.width = width as u32; self.height = height as u32;
                self.page.set_viewport((width as f32, height as f32));
                Ok(b"null".to_vec())
            }
            "evaluate" => {
                if !self.loaded { return Err("No document loaded".into()); }
                let source = value.get("source").and_then(Value::as_str).ok_or("Missing source")?;
                let timeout_ms = match value.get("timeoutMs") {
                    Some(timeout) => timeout.as_u64().filter(|timeout| (1..=15_000).contains(timeout))
                        .ok_or("timeoutMs must be between 1 and 15000")?,
                    None => 2_000,
                };
                let js = self.page.js.as_mut().ok_or("JavaScript runtime unavailable")?;
                // The CDP await deadline only bounds a pending Promise. The V8
                // watchdog also bounds synchronous loops and Promise callbacks.
                let watchdog = js.arm_watchdog(Duration::from_millis(timeout_ms));
                let result = self.runtime.block_on(self.page.evaluate_for_cdp_with_timeout(
                    source, true, true, timeout_ms));
                let js = self.page.js.as_mut().ok_or("JavaScript runtime unavailable")?;
                // This ABI exposes copied JSON values, never CDP object handles.
                // The pinned Obscura API retains handles even for by-value calls;
                // release the bridge-owned group to avoid retaining every result.
                js.release_object_group();
                let timed_out = js.disarm_watchdog(watchdog);
                self.collect_navigation_request();
                if timed_out || result.as_ref().err().is_some_and(|error|
                    error.contains("promise did not settle within")) {
                    // The interrupted async wrapper can still resolve later.
                    // Restart rather than letting its shared CDP result state
                    // contaminate the next evaluation.
                    self.poisoned = true;
                    return Err("JavaScript execution timed out; renderer restart required".into());
                }
                let result = result?;
                if result.thrown {
                    return Err(if result.description.is_empty() {
                        result.value.map(|value| value.to_string())
                            .unwrap_or_else(|| "JavaScript execution threw".into())
                    } else { result.description });
                }
                // This ABI currently transports the JSON-compatible subset.
                // Undefined remains null; structured clone needs a versioned codec.
                Ok(result.value.unwrap_or(Value::Null).to_string().into_bytes())
            }
            "tick" => {
                if self.loaded {
                    self.runtime.block_on(async {
                        match tokio::time::timeout(Duration::from_millis(2), self.page.run_autonomous_event_loop_turn()).await {
                            Ok(result) => result.map(|_| ()),
                            Err(_) => Ok(()),
                        }
                    })?;
                    self.collect_navigation_request();
                    self.pump_preload()?;
                }
                Ok(b"null".to_vec())
            }
            "pollEvents" => {
                if self.loaded { self.pump_preload()?; }
                self.collect_navigation_request();
                let mut events = Vec::with_capacity(self.critical_events.len() + self.events.len());
                for (event, _) in self.critical_events.drain(..) {
                    if event["type"] == "evaluation-result" {
                        if let Some(id) = event["id"].as_str() { self.evaluation_tickets.remove(id); }
                    }
                    events.push(event);
                }
                self.critical_bytes = 0;
                self.queued_ipc = 0;
                events.extend(self.events.drain(..).map(|(event, _)| event));
                self.event_bytes = 0;
                let dropped = std::mem::take(&mut self.dropped_events);
                Ok(json!({"events": events, "dropped": dropped}).to_string().into_bytes())
            }
            "getState" => Ok(json!({"url": self.page.url_string(), "title": self.page.title,
                "loaded": self.loaded, "lifecycle": format!("{:?}", self.page.lifecycle),
                "generation": self.preload.generation})
                .to_string().into_bytes()),
            "capturePng" => {
                if !self.loaded { return Err("No document loaded".into()); }
                // Diagnostic bring-up only. Raw frames are a separate engine API task.
                let _guard = self.runtime.enter();
                self.page.screenshot((self.width as f32, self.height as f32)).ok_or("Rendering failed".into())
            }
            _ => {
                if let Some(result) = self.preload.command(&mut self.page, &value) { return result; }
                desktop::dispatch(&mut self.page, &value)
                    .unwrap_or_else(|| Err("Unsupported engine method".into()))
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn weber_engine_abi_version() -> u32 { 1 }

/// One engine per owner thread. Zero means startup failed or an engine already exists.
#[no_mangle]
pub extern "C" fn weber_engine_create() -> u64 { weber_engine_create_with_resources(-1) }

#[no_mangle]
pub extern "C" fn weber_engine_create_with_resources(resource_fd: i32) -> u64 {
    catch_unwind(AssertUnwindSafe(|| ENGINE.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else { return 0; };
        if slot.is_some() { return 0; }
        let Ok(engine) = Engine::with_resources(resource_fd) else { return 0; };
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        if id == 0 { return 0; }
        *slot = Some((id, engine)); id
    }))).unwrap_or(0)
}

/// Status 0: JSON, PNG for capturePng, or an OBF1 frame for captureFrame.
/// Status 1: UTF-8 error bytes. Every response is bounded to MAX_RESPONSE.
/// Callback bytes are borrowed only for the duration of the callback.
/// Callback must not throw, retain the pointer, or reenter the engine.
/// Invalid pointers are caller errors; this is not a sandbox boundary.
#[no_mangle]
pub unsafe extern "C" fn weber_engine_command(id: u64, input: *const u8, len: usize,
    reply: Option<Reply>, user: *mut c_void) -> i32 {
    let Some(reply) = reply else { return 1; };
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<Vec<u8>, String> {
        if input.is_null() || len == 0 || len > MAX_REQUEST { return Err("Invalid request size/pointer".into()); }
        let value = serde_json::from_slice(std::slice::from_raw_parts(input, len)).map_err(|e| e.to_string())?;
        ENGINE.with(|slot| {
            let mut slot = slot.try_borrow_mut().map_err(|_| "Reentrant engine call")?;
            let (owner, engine) = slot.as_mut().ok_or("Unknown engine or wrong thread")?;
            if *owner != id { return Err("Unknown engine or wrong thread".into()); }
            engine.command(value)
        })
    }));
    let result = match result {
        Ok(result) => result,
        Err(_) => {
            ENGINE.with(|slot| { if let Ok(mut slot) = slot.try_borrow_mut() {
                if let Some((owner, engine)) = slot.as_mut() { if *owner == id { engine.poisoned = true; } }
            }});
            Err("Engine panicked; renderer restart required".into())
        }
    };
    let (status, bytes) = match result {
        Ok(bytes) if bytes.len() <= MAX_RESPONSE => (0, bytes),
        Ok(_) => (1, b"Response exceeds 64 MiB".to_vec()),
        Err(error) if error.len() <= MAX_RESPONSE => (1, error.into_bytes()),
        Err(_) => (1, b"Error response exceeds 64 MiB".to_vec()),
    };
    reply(bytes.as_ptr(), bytes.len(), user);
    status
}

#[no_mangle]
pub extern "C" fn weber_engine_destroy(id: u64) -> i32 {
    catch_unwind(AssertUnwindSafe(|| ENGINE.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else { return 1; };
        if slot.as_ref().map(|(owner, _)| *owner) != Some(id) { return 1; }
        drop(slot.take()); 0
    }))).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(engine: &mut Engine, request: Value) -> Result<Value, String> {
        let bytes = engine.command(request)?;
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())
    }

    fn evaluate(engine: &mut Engine, source: &str) -> Result<Value, String> {
        command(engine, json!({"method": "evaluate", "source": source}))
    }

    #[test]
    fn engine_observation_overflow_preserves_ipc_and_completion_events() {
        let mut engine = Engine::new().unwrap();
        command(&mut engine, json!({"method": "configurePreload", "source": r#"
            const { contextBridge, ipcRenderer } = require('electron');
            contextBridge.exposeInMainWorld('queueApi', {
                echo: value => ipcRenderer.invoke('queue:echo', value),
            });
        "#})).unwrap();
        command(&mut engine, json!({"method": "loadURL", "url": "about:blank"})).unwrap();
        command(&mut engine, json!({"method": "startEvaluation", "id": "keep-me",
            "source": "queueApi.echo('accepted')"})).unwrap();
        command(&mut engine, json!({"method": "tick"})).unwrap();
        for number in 0..600 { engine.push_event(json!({"type": "observation", "number": number})); }
        let delivery = command(&mut engine, json!({"method": "pollEvents"})).unwrap();
        assert!(delivery["dropped"].as_u64().unwrap() > 0);
        let invokes: Vec<_> = delivery["events"].as_array().unwrap().iter()
            .filter(|event| event["type"] == "ipc-invoke").collect();
        assert_eq!(invokes.len(), 1, "observation overflow discarded accepted IPC");
        let invoke = invokes[0];
        command(&mut engine, json!({"method": "resolveIpc", "generation": invoke["generation"],
            "id": invoke["id"], "ok": true, "value": invoke["args"][0]})).unwrap();
        command(&mut engine, json!({"method": "tick"})).unwrap();
        for number in 0..600 { engine.push_event(json!({"type": "observation", "number": number})); }
        let delivery = command(&mut engine, json!({"method": "pollEvents"})).unwrap();
        let results: Vec<_> = delivery["events"].as_array().unwrap().iter()
            .filter(|event| event["type"] == "evaluation-result").collect();
        assert_eq!(results.len(), 1, "observation overflow discarded the completion");
        assert_eq!(results[0]["id"], "keep-me");
        assert_eq!(results[0]["ok"], true);
        assert_eq!(results[0]["value"], "accepted");
        assert!(!engine.poisoned);
    }

    #[test]
    fn idle_queue_probes_preserve_timer_driven_ipc_progress() {
        let mut engine = Engine::new().unwrap();
        command(&mut engine, json!({"method": "configurePreload", "source": r#"
            const { contextBridge, ipcRenderer } = require('electron');
            contextBridge.exposeInMainWorld('timerApi', {
                echo: value => ipcRenderer.invoke('timer:echo', value),
            });
        "#})).unwrap();
        command(&mut engine, json!({"method": "loadURL", "url": "about:blank"})).unwrap();
        command(&mut engine, json!({"method": "pollEvents"})).unwrap();
        for _ in 0..100 {
            assert!(!engine.page.desktop_bridge_has_events(false).unwrap());
            assert!(!engine.page.desktop_bridge_has_events(true).unwrap());
        }
        evaluate(&mut engine,
            "setTimeout(() => timerApi.echo(21).then(value => globalThis.timerReply = value), 20); null").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut invoked = false;
        while std::time::Instant::now() < deadline {
            command(&mut engine, json!({"method": "tick"})).unwrap();
            let events = command(&mut engine, json!({"method": "pollEvents"})).unwrap();
            for event in events["events"].as_array().unwrap() {
                if event["type"] == "ipc-invoke" {
                    assert!(!invoked, "timer invocation was duplicated");
                    invoked = true;
                    assert_eq!(event["channel"], "timer:echo");
                    command(&mut engine, json!({"method": "resolveIpc", "id": event["id"],
                        "generation": event["generation"], "ok": true, "value": 42})).unwrap();
                }
            }
            if invoked && evaluate(&mut engine, "globalThis.timerReply === 42").unwrap() == true { break; }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(invoked, "empty queue probes must not stop timers from generating IPC");
        assert_eq!(evaluate(&mut engine, "timerReply").unwrap().as_f64(), Some(42.0));
        assert!(!engine.poisoned);
    }

    #[test]
    fn engine_delivery_budget_reports_every_accepted_evaluation() {
        let mut engine = Engine::new().unwrap();
        command(&mut engine, json!({"method": "loadURL", "url": "about:blank"})).unwrap();
        for index in 0..8 {
            command(&mut engine, json!({"method": "startEvaluation", "id": format!("large-{index}"),
                "source": "'x'.repeat(700000)"})).unwrap();
            command(&mut engine, json!({"method": "tick"})).unwrap();
        }
        let delivery = command(&mut engine, json!({"method": "pollEvents"})).unwrap();
        let mut seen = std::collections::HashSet::new();
        let mut succeeded = 0;
        let mut rejected = 0;
        for event in delivery["events"].as_array().unwrap() {
            if event["type"] != "evaluation-result" { continue; }
            assert!(seen.insert(event["id"].as_str().unwrap()), "duplicate completion");
            if event["ok"] == true {
                succeeded += 1;
                assert_eq!(event["value"].as_str().unwrap().len(), 700000);
            } else {
                rejected += 1;
                assert!(event["error"].as_str().unwrap().contains("bounded delivery queue"));
            }
        }
        assert_eq!(seen.len(), 8, "every accepted evaluation must have an explicit outcome");
        assert!(succeeded > 0 && rejected > 0, "the byte budget must reject oversized delivery pressure");
        assert!(!engine.poisoned);

        // Reservations also bound unfinished work, and reject before executing
        // an additional script which has no guaranteed completion slot.
        for index in 0..MAX_CRITICAL_EVENTS {
            command(&mut engine, json!({"method": "startEvaluation", "id": format!("pending-{index}"),
                "source": "new Promise(() => {})"})).unwrap();
        }
        let error = command(&mut engine, json!({"method": "startEvaluation", "id": "overflow",
            "source": "globalThis.unadmittedScriptRan=true"})).unwrap_err();
        assert!(error.contains("delivery queue is full"));
        assert_eq!(evaluate(&mut engine, "typeof unadmittedScriptRan").unwrap(), "undefined");
        assert!(!engine.poisoned);
    }

    // One owning thread exercises the actual Page/V8 implementation. These
    // regressions cannot be covered by a mock transport or source-text checks.
    #[test]
    fn page_commands_preserve_results_preloads_navigation_and_deadlines() {
        let mut engine = Engine::new().unwrap();
        assert!(command(&mut engine, json!({"method": "setPreloadScripts",
            "world": "isolated", "scripts": []})).is_err());
        command(&mut engine, json!({"method": "setPreloadScripts", "world": "main",
            "scripts": ["globalThis.weberPreload = 11"]})).unwrap();
        command(&mut engine, json!({"method": "loadURL", "url":
            "data:text/html,<script>globalThis.preloadAtAuthorScript=globalThis.weberPreload</script><title>Weber test</title>"})).unwrap();
        assert_eq!(evaluate(&mut engine, "preloadAtAuthorScript").unwrap().as_f64(), Some(11.0));
        assert_eq!(evaluate(&mut engine, "var weberAnswer = 20; weberAnswer + 22;\n//# sourceURL=weber-test.js").unwrap().as_f64(), Some(42.0));
        assert_eq!(evaluate(&mut engine, "Promise.resolve({answer:42})").unwrap()["answer"].as_f64(), Some(42.0));
        assert_eq!(evaluate(&mut engine, "new Promise(resolve => setTimeout(() => resolve(33), 20))").unwrap().as_f64(), Some(33.0));
        assert_eq!(evaluate(&mut engine, "null").unwrap(), Value::Null);
        assert!(evaluate(&mut engine, "throw new TypeError('weber sync failure')").unwrap_err()
            .contains("weber sync failure"));
        assert!(evaluate(&mut engine, "Promise.reject(new Error('weber async failure'))").unwrap_err()
            .contains("weber async failure"));
        assert!(evaluate(&mut engine, "throw null").is_err());
        assert_eq!(evaluate(&mut engine, "6 * 7").unwrap().as_f64(), Some(42.0));

        // A by-value call must not keep its result rooted indefinitely.
        evaluate(&mut engine, "({retained: new Array(1000).fill('large')})").unwrap();
        assert_eq!(evaluate(&mut engine, "Object.keys(globalThis.__obscura_objects).length").unwrap().as_f64(), Some(0.0));

        command(&mut engine, json!({"method": "viewport", "width": 200, "height": 80})).unwrap();
        evaluate(&mut engine, "document.body.innerHTML = '<textarea id=editor style=\"position:absolute;left:0;top:0;width:180px;height:40px\"></textarea>'; null").unwrap();
        let frame = engine.command(json!({"method": "captureFrame"})).unwrap();
        assert_eq!(&frame[..4], b"OBF1");
        assert_eq!(u32::from_le_bytes(frame[4..8].try_into().unwrap()), 200);
        assert_eq!(u32::from_le_bytes(frame[8..12].try_into().unwrap()), 80);
        assert_eq!(frame.len(), 12 + 200 * 80 * 4);
        for kind in ["mousePressed", "mouseReleased"] {
            command(&mut engine, json!({"method": "dispatchMouseEvent", "type": kind,
                "x": 10, "y": 10, "button": "left"})).unwrap();
        }
        assert_eq!(evaluate(&mut engine, "document.activeElement.id").unwrap(), json!("editor"));
        let text = "한글🙂'\\\n";
        command(&mut engine, json!({"method": "insertText", "text": text})).unwrap();
        assert_eq!(evaluate(&mut engine, "document.getElementById('editor').value").unwrap(), json!(text));
        evaluate(&mut engine, "document.getElementById('editor').addEventListener('keydown', event => { globalThis.weberModifiers = [event.ctrlKey, event.shiftKey]; event.preventDefault(); }); null").unwrap();
        command(&mut engine, json!({"method": "dispatchKeyEvent", "type": "keyDown",
            "key": "x", "code": "KeyX", "text": "x", "modifiers": 10})).unwrap();
        assert_eq!(evaluate(&mut engine, "weberModifiers").unwrap(), json!([true, true]));
        command(&mut engine, json!({"method": "dispatchKeyEvent", "type": "keyDown",
            "key": "x", "code": "KeyX", "text": "x"})).unwrap();
        assert_eq!(evaluate(&mut engine, "document.getElementById('editor').value").unwrap(), json!(text),
            "cancelled keydown must not insert text");

        evaluate(&mut engine, "location.href = 'https://example.invalid/next'; null").unwrap();
        let events = command(&mut engine, json!({"method": "pollEvents"})).unwrap();
        assert!(events["events"].as_array().unwrap().iter().any(|event|
            event["type"] == "navigation-requested" && event["url"] == "https://example.invalid/next"));
        let state = command(&mut engine, json!({"method": "getState"})).unwrap();
        assert!(state["url"].as_str().unwrap().starts_with("data:"), "navigation waits for browser authorization");
        assert!(command(&mut engine, json!({"method": "pollEvents"})).unwrap()["events"]
            .as_array().unwrap().is_empty());
        command(&mut engine, json!({"method": "loadURL", "url": "about:blank"})).unwrap();
        assert_eq!(evaluate(&mut engine, "weberPreload").unwrap().as_f64(), Some(11.0));
        assert!(command(&mut engine, json!({"method": "loadURL", "url": "javascript:1"})).is_err());

        // Queue size is bounded even if a browser owner stops draining events.
        for number in 0..300 { engine.push_event(json!({"type": "test", "number": number})); }
        let events = command(&mut engine, json!({"method": "pollEvents"})).unwrap();
        assert_eq!(events["events"].as_array().unwrap().len(), 256);
        assert!(events["dropped"].as_u64().unwrap() >= 44);

        let started = std::time::Instant::now();
        let error = command(&mut engine, json!({"method": "evaluate",
            "source": "new Promise(() => {})", "timeoutMs": 20})).unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(evaluate(&mut engine, "1").unwrap_err().contains("poisoned"));
        drop(engine);

        // A tight synchronous loop also needs the V8 watchdog; an async timeout
        // alone cannot interrupt it. Restart restores an independent renderer.
        let mut engine = Engine::new().unwrap();
        command(&mut engine, json!({"method": "loadURL", "url": "about:blank"})).unwrap();
        let started = std::time::Instant::now();
        let error = command(&mut engine, json!({"method": "evaluate",
            "source": "while (true) {}", "timeoutMs": 20})).unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
