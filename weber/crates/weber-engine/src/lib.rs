//! Renderer-side C ABI. Never load alongside Electron's separate V8 build.
//! The caller owns valid input/callback pointers; all calls use the creating thread.
use std::{cell::RefCell, collections::VecDeque, ffi::c_void, panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, atomic::{AtomicU64, Ordering}}, time::Duration};
use obscura_browser::{BrowserContext, Page};
use serde_json::{json, Value};

mod desktop;

const MAX_REQUEST: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 64 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
thread_local! { static ENGINE: RefCell<Option<(u64, Engine)>> = const { RefCell::new(None) }; }
struct Engine {
    // Page/V8 must be destroyed before the Tokio runtime.
    page: Page,
    runtime: tokio::runtime::Runtime,
    loaded: bool,
    width: u32,
    height: u32,
    poisoned: bool,
    events: VecDeque<(Value, usize)>,
    event_bytes: usize,
    dropped_events: u64,
}
type Reply = extern "C" fn(*const u8, usize, *mut c_void);

impl Engine {
    fn new() -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all()
            .build().map_err(|e| e.to_string())?;
        let page = {
            let _guard = runtime.enter();
            let mut page = Page::new("weber-renderer".into(), Arc::new(BrowserContext::new("weber-renderer".into())));
            page.set_navigation_timeout(Duration::from_secs(15));
            page.set_viewport((800., 600.));
            page
        };
        Ok(Self { page, runtime, loaded: false, width: 800, height: 600, poisoned: false,
            events: VecDeque::new(), event_bytes: 0, dropped_events: 0 })
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
            _ => return Err("Unsupported navigation scheme".into()),
        }
        self.loaded = false;
        self.push_event(json!({"type": "navigation-started", "url": url.as_str()}));
        let result = self.runtime.block_on(self.page.navigate(url.as_str()));
        if let Err(error) = result {
            let error = error.to_string();
            self.push_event(json!({"type": "navigation-failed", "url": url.as_str(),
                "error": error}));
            return Err(error);
        }
        self.runtime.block_on(self.page.prepare_screenshot_resources(100));
        self.loaded = true;
        let state = json!({"url": self.page.url_string(), "title": self.page.title});
        self.push_event(json!({"type": "navigation-finished", "url": self.page.url_string(),
            "title": self.page.title}));
        self.collect_navigation_request();
        Ok(state.to_string().into_bytes())
    }

    fn command(&mut self, value: Value) -> Result<Vec<u8>, String> {
        if self.poisoned { return Err("Engine is poisoned; destroy the renderer".into()); }
        let runtime_handle = self.runtime.handle().clone();
        let _guard = runtime_handle.enter();
        match value.get("method").and_then(Value::as_str).ok_or("Missing method")? {
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
                }
                Ok(b"null".to_vec())
            }
            "pollEvents" => {
                self.collect_navigation_request();
                let events: Vec<_> = self.events.drain(..).map(|(event, _)| event).collect();
                self.event_bytes = 0;
                let dropped = std::mem::take(&mut self.dropped_events);
                Ok(json!({"events": events, "dropped": dropped}).to_string().into_bytes())
            }
            "getState" => Ok(json!({"url": self.page.url_string(), "title": self.page.title,
                "loaded": self.loaded, "lifecycle": format!("{:?}", self.page.lifecycle)})
                .to_string().into_bytes()),
            "capturePng" => {
                if !self.loaded { return Err("No document loaded".into()); }
                // Diagnostic bring-up only. Raw frames are a separate engine API task.
                let _guard = self.runtime.enter();
                self.page.screenshot((self.width as f32, self.height as f32)).ok_or("Rendering failed".into())
            }
            _ => desktop::dispatch(&mut self.page, &value)
                .unwrap_or_else(|| Err("Unsupported engine method".into())),
        }
    }
}

#[no_mangle]
pub extern "C" fn weber_engine_abi_version() -> u32 { 1 }

/// One engine per owner thread. Zero means startup failed or an engine already exists.
#[no_mangle]
pub extern "C" fn weber_engine_create() -> u64 {
    catch_unwind(AssertUnwindSafe(|| ENGINE.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else { return 0; };
        if slot.is_some() { return 0; }
        let Ok(engine) = Engine::new() else { return 0; };
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
        assert_eq!(evaluate(&mut engine, "preloadAtAuthorScript").unwrap(), json!(11));
        assert_eq!(evaluate(&mut engine, "var weberAnswer = 20; weberAnswer + 22;\n//# sourceURL=weber-test.js").unwrap(), json!(42));
        assert_eq!(evaluate(&mut engine, "Promise.resolve({answer:42})").unwrap(), json!({"answer": 42}));
        assert_eq!(evaluate(&mut engine, "new Promise(resolve => setTimeout(() => resolve(33), 20))").unwrap(), json!(33));
        assert_eq!(evaluate(&mut engine, "null").unwrap(), Value::Null);
        assert!(evaluate(&mut engine, "throw new TypeError('weber sync failure')").unwrap_err()
            .contains("weber sync failure"));
        assert!(evaluate(&mut engine, "Promise.reject(new Error('weber async failure'))").unwrap_err()
            .contains("weber async failure"));
        assert!(evaluate(&mut engine, "throw null").is_err());
        assert_eq!(evaluate(&mut engine, "6 * 7").unwrap(), json!(42));

        // A by-value call must not keep its result rooted indefinitely.
        evaluate(&mut engine, "({retained: new Array(1000).fill('large')})").unwrap();
        assert_eq!(evaluate(&mut engine, "Object.keys(globalThis.__obscura_objects).length").unwrap(), json!(0));

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
        assert_eq!(evaluate(&mut engine, "weberPreload").unwrap(), json!(11));
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
