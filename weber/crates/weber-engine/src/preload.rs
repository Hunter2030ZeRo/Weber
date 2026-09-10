//! Isolated preload and asynchronous evaluation transport.
//! The Obscura patch owns V8 handles inside their document's runtime. This
//! module only retains generation-tagged scalar identifiers and copied JSON.
use std::collections::HashSet;
use obscura_browser::Page;
use serde_json::{json, Value};

const MAIN_BOOTSTRAP: &str = include_str!("preload_main.js");
const ISOLATED_BOOTSTRAP: &str = include_str!("preload_isolated.js");
const MAX_PENDING: usize = 256;

pub(crate) struct Preload {
    pub generation: u64,
    pending_ipc: HashSet<u64>,
    pending_browser: HashSet<u64>,
    pending_evaluations: HashSet<String>,
    configured_preload: bool,
    active_preload: bool,
}

fn bridge(page: &mut Page, isolated: bool, request: Value) -> Result<Value, String> {
    let reply = page.desktop_bridge_command(isolated, &request)?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply.get("value").cloned().unwrap_or(Value::Null))
    } else {
        Err(reply.get("error").and_then(Value::as_str)
            .unwrap_or("Isolated bridge command failed").to_string())
    }
}

fn settle_many(page: &mut Page, replies: &[Value]) -> Result<(), String> {
    for batch in replies.chunks(32) {
        if batch.len() == 1 { bridge(page, false, batch[0].clone())?; }
        else { bridge(page, false, json!({"method": "settleBatch", "replies": batch}))?; }
    }
    Ok(())
}

impl Preload {
    pub fn new(page: &mut Page) -> Self {
        page.set_desktop_preload(MAIN_BOOTSTRAP.into(), ISOLATED_BOOTSTRAP.into(), String::new());
        Self { generation: 0, pending_ipc: HashSet::new(), pending_browser: HashSet::new(), pending_evaluations: HashSet::new(),
            configured_preload: false, active_preload: false }
    }

    /// Call before every host-initiated navigation, even one which later fails.
    pub fn before_navigation(&mut self) -> Result<(), String> {
        self.generation = self.generation.checked_add(1).ok_or("Document generation exhausted")?;
        self.pending_ipc.clear();
        self.pending_browser.clear();
        self.pending_evaluations.clear();
        self.active_preload = self.configured_preload;
        Ok(())
    }

    pub fn command(&mut self, page: &mut Page, request: &Value)
        -> Option<Result<Vec<u8>, String>>
    {
        match request.get("method").and_then(Value::as_str)? {
            "configurePreload" => Some((|| {
                let source = request.get("source").and_then(Value::as_str).ok_or("Missing preload source")?;
                if source.len() > 1024 * 1024 { return Err("Preload exceeds 1 MiB".into()); }
                page.set_desktop_preload(MAIN_BOOTSTRAP.into(), ISOLATED_BOOTSTRAP.into(), source.into());
                self.configured_preload = !source.trim().is_empty();
                Ok(json!({"generation": self.generation, "appliesOnNextNavigation": true})
                    .to_string().into_bytes())
            })()),
            "startEvaluation" => Some((|| {
                let id = request.get("id").and_then(Value::as_str)
                    .filter(|id| !id.is_empty() && id.len() <= 128).ok_or("Invalid evaluation ID")?;
                let source = request.get("source").and_then(Value::as_str).ok_or("Missing source")?;
                if self.pending_evaluations.len() >= MAX_PENDING { return Err("Too many pending evaluations".into()); }
                if self.pending_evaluations.contains(id) { return Err("Duplicate evaluation ID".into()); }
                bridge(page, false, json!({"method": "startEvaluation", "id": id, "source": source}))?;
                self.pending_evaluations.insert(id.to_string());
                Ok(json!({"generation": self.generation}).to_string().into_bytes())
            })()),
            "sendToRenderer" => Some((|| {
                if request.get("generation").and_then(Value::as_u64) != Some(self.generation) {
                    return Err("Stale IPC document generation".into());
                }
                bridge(page, true, request.clone())?;
                Ok(b"null".to_vec())
            })()),
            "resolveIpc" => Some((|| {
                if request.get("generation").and_then(Value::as_u64) != Some(self.generation) {
                    return Err("Stale IPC document generation".into());
                }
                let id_text = request.get("id").and_then(Value::as_str).ok_or("Invalid IPC ID")?;
                let id = id_text.parse::<u64>().map_err(|_| "Invalid IPC ID")?;
                if id.to_string() != id_text { return Err("Invalid IPC ID".into()); }
                if !self.pending_ipc.contains(&id) { return Err("Unknown or completed IPC request".into()); }
                let ok = request.get("ok").and_then(Value::as_bool).ok_or("Missing IPC outcome")?;
                let reply = if ok {
                    json!({"method": "resolveIpc", "id": id, "ok": true,
                        "value": request.get("value").cloned().unwrap_or(Value::Null)})
                } else {
                    let error = request.get("error").and_then(Value::as_str).ok_or("Missing IPC error")?;
                    json!({"method": "resolveIpc", "id": id, "ok": false, "error": error})
                };
                bridge(page, true, reply)?;
                self.pending_ipc.remove(&id);
                Ok(b"null".to_vec())
            })()),
            "resolveBrowserOperation" => Some((|| {
                if request.get("generation").and_then(Value::as_u64) != Some(self.generation) {
                    return Err("Stale browser operation document generation".into());
                }
                let text = request.get("id").and_then(Value::as_str).ok_or("Invalid browser operation ID")?;
                let id = text.parse::<u64>().map_err(|_| "Invalid browser operation ID")?;
                if id.to_string() != text || !self.pending_browser.contains(&id) {
                    return Err("Unknown or completed browser operation".into());
                }
                let ok = request.get("ok").and_then(Value::as_bool).ok_or("Missing browser operation outcome")?;
                let reply = if ok {
                    json!({"method": "resolveBrowserOperation", "id": id, "ok": true,
                        "value": request.get("value").cloned().unwrap_or(Value::Null)})
                } else {
                    json!({"method": "resolveBrowserOperation", "id": id, "ok": false,
                        "error": request.get("error").and_then(Value::as_str).ok_or("Missing browser operation error")?,
                        "errorName": request.get("errorName").and_then(Value::as_str).unwrap_or("NotAllowedError")})
                };
                bridge(page, false, reply)?;
                self.pending_browser.remove(&id);
                Ok(b"null".to_vec())
            })()),
            "resolveIpcBatch" => Some((|| {
                if request.get("generation").and_then(Value::as_u64) != Some(self.generation) {
                    return Err("Stale IPC document generation".into());
                }
                let items = request.get("replies").and_then(Value::as_array)
                    .filter(|items| !items.is_empty() && items.len() <= 32)
                    .ok_or("Invalid IPC reply batch")?;
                let mut ids = HashSet::new();
                let mut replies = Vec::with_capacity(items.len());
                // Validate the entire batch before settling any ticket. A
                // malformed/duplicate/stale member cannot partly consume it.
                for item in items {
                    if item.get("generation").and_then(Value::as_u64) != Some(self.generation) {
                        return Err("Stale IPC document generation in batch".into());
                    }
                    let text = item.get("id").and_then(Value::as_str).ok_or("Invalid IPC ID")?;
                    let id = text.parse::<u64>().map_err(|_| "Invalid IPC ID")?;
                    if id.to_string() != text || !self.pending_ipc.contains(&id) || !ids.insert(id) {
                        return Err("Unknown, completed or duplicate IPC request in batch".into());
                    }
                    let ok = item.get("ok").and_then(Value::as_bool).ok_or("Missing IPC outcome")?;
                    replies.push(if ok {
                        json!({"id": id, "ok": true, "value": item.get("value").cloned().unwrap_or(Value::Null)})
                    } else {
                        json!({"id": id, "ok": false,
                            "error": item.get("error").and_then(Value::as_str).ok_or("Missing IPC error")?})
                    });
                }
                // One V8 bridge entry and microtask checkpoint for the batch.
                bridge(page, true, json!({"method": "resolveIpcBatch", "replies": replies}))?;
                for id in ids { self.pending_ipc.remove(&id); }
                Ok(b"null".to_vec())
            })()),
            _ => None,
        }
    }

    /// Bounded work between renderer commands; never waits for the main process.
    /// Application IPC comes only from the isolated preload. Fixed browser API
    /// operations come from the private main bootstrap and carry Rust-owned
    /// document identity, never a URL or session supplied by page JavaScript.
    pub fn pump(&mut self, page: &mut Page) -> Result<Vec<Value>, String> {
        if page.js.is_none() { return Ok(Vec::new()); }
        if !self.active_preload && self.pending_evaluations.is_empty() && self.pending_ipc.is_empty()
            && self.pending_browser.is_empty() && !page.desktop_bridge_has_events(false)? {
            return Ok(Vec::new());
        }
        let mut outgoing = Vec::new();
        for _ in 0..4 {
            let main_events = if page.desktop_bridge_has_events(false)? {
                bridge(page, false, json!({"method": "drain"}))?
            } else { Value::Array(Vec::new()) };
            let main_events = main_events.as_array().ok_or("Invalid main bridge events")?;
            let mut calls = Vec::new();
            for event in main_events {
                match event.get("type").and_then(Value::as_str) {
                    Some("bridge-call") => {
                        calls.push(json!({"method": "call", "id": event["id"],
                            "functionId": event["functionId"], "args": event["args"]}));
                    }
                    Some("evaluation-result") => {
                        let id = event.get("id").and_then(Value::as_str).ok_or("Invalid evaluation completion")?;
                        if !self.pending_evaluations.remove(id) { return Err("Unknown evaluation completion".into()); }
                        let mut event = event.clone();
                        event["generation"] = json!(self.generation);
                        outgoing.push(event);
                    }
                    Some("browser-operation") => {
                        let id = event.get("id").and_then(Value::as_u64).ok_or("Invalid browser operation ID")?;
                        let action = event.get("action").and_then(Value::as_str).ok_or("Missing browser operation")?;
                        if !matches!(action, "clipboard-read" | "clipboard-write" | "permission-query" |
                            "geolocation" | "media" | "display-media" | "notification-permission")
                            || !event.get("args").is_some_and(Value::is_array) {
                            return Err("Invalid browser operation".into());
                        }
                        if self.pending_browser.len() >= MAX_PENDING || !self.pending_browser.insert(id) {
                            return Err("Duplicate browser operation or pending limit exceeded".into());
                        }
                        let mut event = event.clone();
                        event["generation"] = json!(self.generation);
                        event["sourceURL"] = json!(page.url_string());
                        event["id"] = json!(id.to_string());
                        outgoing.push(event);
                    }
                    _ => return Err("Unsupported main bridge event".into()),
                }
            }
            for batch in calls.chunks(32) {
                // Each drained queue is already bounded below 1 MiB; replacing
                // its event envelope with these smaller commands stays bounded.
                let rejected = if batch.len() == 1 {
                    let reply = page.desktop_bridge_command(true, &batch[0])?;
                    match reply.get("ok").and_then(Value::as_bool) {
                        Some(true) => Vec::new(),
                        Some(false) => vec![json!({"method": "settle", "id": batch[0]["id"],
                            "ok": false, "error": reply.get("error").and_then(Value::as_str)
                                .ok_or("Invalid bridge admission failure")?})],
                        _ => return Err("Invalid bridge admission reply".into()),
                    }
                } else {
                    let result = bridge(page, true, json!({"method": "callBatch", "calls": batch}))?;
                    result.as_array().ok_or("Invalid bridge batch result")?.iter().map(|reply|
                        json!({"method": "settle", "id": reply["id"], "ok": false, "error": reply["error"]})
                    ).collect()
                };
                settle_many(page, &rejected)?;
            }
            let isolated_events = if page.desktop_bridge_has_events(true)? {
                bridge(page, true, json!({"method": "drain"}))?
            } else { Value::Array(Vec::new()) };
            let isolated_events = isolated_events.as_array().ok_or("Invalid isolated bridge events")?;
            let mut settlements = Vec::new();
            for event in isolated_events {
                match event.get("type").and_then(Value::as_str) {
                    Some("bridge-result") => {
                        let mut reply = event.clone();
                        reply["method"] = json!("settle");
                        settlements.push(reply);
                    }
                    Some("ipc-send") => {
                        let mut event = event.clone();
                        event["generation"] = json!(self.generation);
                        outgoing.push(event);
                    }
                    Some("ipc-invoke") => {
                        let id = event.get("id").and_then(Value::as_u64).ok_or("Invalid IPC request ID")?;
                        if self.pending_ipc.len() >= MAX_PENDING || !self.pending_ipc.insert(id) {
                            return Err("Duplicate IPC request or pending limit exceeded".into());
                        }
                        let mut event = event.clone();
                        event["generation"] = json!(self.generation);
                        event["id"] = json!(id.to_string());
                        outgoing.push(event);
                    }
                    _ => return Err("Unsupported isolated bridge event".into()),
                }
            }
            settle_many(page, &settlements)?;
            if main_events.is_empty() && isolated_events.is_empty() { break; }
        }
        Ok(outgoing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use obscura_browser::BrowserContext;

    fn command(driver: &mut Preload, page: &mut Page, request: Value) -> Result<Value, String> {
        let bytes = driver.command(page, &request).ok_or("Unknown command")??;
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())
    }

    fn wait_for(driver: &mut Preload, page: &mut Page, event_type: &str) -> Value {
        for _ in 0..16 {
            for event in driver.pump(page).unwrap() {
                if event["type"] == event_type { return event; }
            }
        }
        panic!("Missing {event_type}");
    }

    fn evaluate(driver: &mut Preload, page: &mut Page, id: &str, source: &str) -> Value {
        command(driver, page, json!({"method": "startEvaluation", "id": id, "source": source})).unwrap();
        wait_for(driver, page, "evaluation-result")
    }

    #[test]
    fn browser_permissions_without_preload_have_owned_origin_and_navigation_revocation() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = runtime.enter();
        let mut page = Page::new("browser-permission-test".into(),
            Arc::new(BrowserContext::new("browser-permission-test".into())));
        let mut driver = Preload::new(&mut page);
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../electron-runtime/permission-fixture/index.html").canonicalize().unwrap();
        let document_url = url::Url::from_file_path(fixture).unwrap().to_string();
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate(&document_url)).unwrap();
        // A browser operation from page script must be drained even without an
        // application preload or an executeJavaScript evaluation ticket.
        page.js.as_mut().unwrap().evaluate(
            "navigator.clipboard.readText().then(value => {globalThis.permissionValue=value;});"
        ).unwrap();
        let request = wait_for(&mut driver, &mut page, "browser-operation");
        assert_eq!(request["action"], "clipboard-read");
        assert_eq!(request["sourceURL"], document_url);
        assert_eq!(request["generation"], driver.generation);
        assert!(request.get("channel").is_none());
        let reply = json!({"method": "resolveBrowserOperation", "generation": request["generation"],
            "id": request["id"], "ok": true, "value": "native clipboard"});
        command(&mut driver, &mut page, reply.clone()).unwrap();
        let result = evaluate(&mut driver, &mut page, "read-result", "permissionValue");
        assert_eq!(result["value"], "native clipboard");
        assert!(command(&mut driver, &mut page, reply).unwrap_err().contains("completed"));

        page.js.as_mut().unwrap().evaluate("navigator.clipboard.writeText('old document');").unwrap();
        let old = wait_for(&mut driver, &mut page, "browser-operation");
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate(&document_url)).unwrap();
        page.js.as_mut().unwrap().evaluate("navigator.clipboard.writeText('new document');").unwrap();
        let new = wait_for(&mut driver, &mut page, "browser-operation");
        assert!(command(&mut driver, &mut page, json!({"method": "resolveBrowserOperation",
            "generation": old["generation"], "id": old["id"], "ok": true, "value": null
        })).unwrap_err().contains("Stale"));
        assert_eq!(driver.pending_browser.len(), 1);
        command(&mut driver, &mut page, json!({"method": "resolveBrowserOperation",
            "generation": new["generation"], "id": new["id"], "ok": true, "value": null
        })).unwrap();
        assert!(driver.pending_browser.is_empty());
    }

    #[test]
    fn shared_bridge_watchdog_resets_termination_and_discards_interrupted_bridge() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = runtime.enter();
        let mut page = Page::new("bridge-watchdog-test".into(),
            Arc::new(BrowserContext::new("bridge-watchdog-test".into())));
        let mut driver = Preload::new(&mut page);
        command(&mut driver, &mut page, json!({"method": "configurePreload", "source": r#"
            require('electron').contextBridge.exposeInMainWorld('watchdogApi', {
                hang: () => { while (true) {} },
                healthy: () => 42,
            });
        "#})).unwrap();
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate("about:blank")).unwrap();
        command(&mut driver, &mut page, json!({"method": "startEvaluation", "id": "interrupted",
            "source": "watchdogApi.hang()"})).unwrap();
        let started = std::time::Instant::now();
        assert!(driver.pump(&mut page).unwrap_err().contains("timed out"));
        assert!(started.elapsed() < std::time::Duration::from_secs(6));
        assert!(page.desktop_bridge_has_events(true).unwrap_err().contains("unavailable"));
        // This direct runtime probe checks termination reset only. The engine
        // still requires a restart after interruption; old bridge handles must
        // never become usable again just because V8 can execute a new script.
        assert_eq!(page.js.as_mut().unwrap().evaluate("6 * 7").unwrap().as_f64(), Some(42.0));
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate("about:blank")).unwrap();
        let result = evaluate(&mut driver, &mut page, "after-replacement", "watchdogApi.healthy()");
        assert_eq!(result["ok"], true);
        assert_eq!(result["value"].as_f64(), Some(42.0));
    }

    #[test]
    fn isolated_preload_bridges_only_copied_values_and_authorized_functions() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = runtime.enter();
        // Page is declared after the runtime so every V8 handle drops first.
        let mut page = Page::new("isolated-preload-test".into(),
            Arc::new(BrowserContext::new("isolated-preload-test".into())));
        let mut driver = Preload::new(&mut page);
        command(&mut driver, &mut page, json!({"method": "configurePreload", "source": r#"
            const { contextBridge, ipcRenderer } = require('electron');
            globalThis.privateSecret = 'preload-private';
            contextBridge.exposeInMainWorld('weberApi', {
                sum: (a, b) => ipcRenderer.invoke('math:sum', a, b),
                readPrivate: () => Promise.resolve(globalThis.privateSecret),
                inspect: () => Promise.resolve([typeof process, typeof Deno, typeof document]),
                copied: { value: 42 },
            });
        "#})).unwrap();
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate("data:text/html,<script>globalThis.preloadPresentAtLoad=typeof weberApi</script>")).unwrap();
        let result = evaluate(&mut driver, &mut page, "presence",
            "[preloadPresentAtLoad, typeof require, typeof process, typeof ipcRenderer, typeof privateSecret]");
        assert_eq!(result["value"], json!(["object", "undefined", "undefined", "undefined", "undefined"]));
        let result = evaluate(&mut driver, &mut page, "realm", "weberApi.inspect()");
        assert_eq!(result["value"], json!(["undefined", "undefined", "undefined"]));
        let result = evaluate(&mut driver, &mut page, "constructor",
            "weberApi.readPrivate.constructor('return typeof privateSecret')()");
        assert_eq!(result["value"], json!("undefined"));
        let result = evaluate(&mut driver, &mut page, "secret",
            "globalThis.privateSecret='page-controlled'; weberApi.readPrivate()");
        assert_eq!(result["value"], json!("preload-private"));
        let result = evaluate(&mut driver, &mut page, "freeze",
            "[Object.isFrozen(weberApi), Object.isFrozen(weberApi.copied), Object.getOwnPropertyDescriptor(globalThis,'weberApi').writable]");
        assert_eq!(result["value"], json!([true, true, false]));

        command(&mut driver, &mut page, json!({"method": "startEvaluation", "id": "sum",
            "source": "weberApi.sum(2,5).then(value => value + 1)"})).unwrap();
        let ipc = wait_for(&mut driver, &mut page, "ipc-invoke");
        assert_eq!(ipc["channel"], "math:sum");
        assert_eq!(ipc["args"], json!([2,5]));
        assert_eq!(ipc["generation"], driver.generation);
        command(&mut driver, &mut page, json!({"method": "resolveIpc", "generation": ipc["generation"],
            "id": ipc["id"], "ok": true, "value": 7})).unwrap();
        let result = wait_for(&mut driver, &mut page, "evaluation-result");
        assert_eq!(result["id"], "sum");
        assert_eq!(result["value"], 8);
        assert!(command(&mut driver, &mut page, json!({"method": "resolveIpc", "generation": ipc["generation"],
            "id": ipc["id"], "ok": true, "value": 999})).is_err());

        // An accessor cannot run while arguments are copied across the bridge.
        let result = evaluate(&mut driver, &mut page, "getter",
            "weberApi.sum(Object.defineProperty({},'value',{enumerable:true,get(){globalThis.getterRan=true;return 1}}),2)");
        assert_eq!(result["ok"], false);
        let result = evaluate(&mut driver, &mut page, "getter-state", "typeof getterRan");
        assert_eq!(result["value"], "undefined");

        command(&mut driver, &mut page, json!({"method": "startEvaluation", "id": "abandoned",
            "source": "weberApi.sum(1,2)"})).unwrap();
        let stale = wait_for(&mut driver, &mut page, "ipc-invoke");
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate("about:blank")).unwrap();
        assert!(command(&mut driver, &mut page, json!({"method": "resolveIpc", "generation": stale["generation"],
            "id": stale["id"], "ok": true, "value": 3})).unwrap_err().contains("Stale"));
        let result = evaluate(&mut driver, &mut page, "new-document", "weberApi.readPrivate()");
        assert_eq!(result["value"], "preload-private");

        command(&mut driver, &mut page, json!({"method": "configurePreload",
            "source": "require('fs').readFileSync('/etc/passwd')"})).unwrap();
        driver.before_navigation().unwrap();
        assert!(runtime.block_on(page.navigate("data:text/html,<script>globalThis.authorRan=true</script>")).is_err());
        assert!(page.js.is_none(), "failed preload must not fall back to a main-world execution path");
    }

    #[test]
    fn ipc_overflow_rejects_individual_calls_and_preserves_accepted_tickets() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = runtime.enter();
        let mut page = Page::new("isolated-overflow-test".into(),
            Arc::new(BrowserContext::new("isolated-overflow-test".into())));
        let mut driver = Preload::new(&mut page);
        command(&mut driver, &mut page, json!({"method": "configurePreload", "source": r#"
            const { contextBridge, ipcRenderer } = require('electron');
            contextBridge.exposeInMainWorld('loadApi', {
                send: value => ipcRenderer.invoke('load:echo', value),
            });
        "#})).unwrap();
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate("about:blank")).unwrap();
        command(&mut driver, &mut page, json!({"method": "startEvaluation", "id": "overflow",
            "source": "Promise.all(Array.from({length:300}, (_,value) => loadApi.send(value).then(value=>({ok:true,value}),()=>({ok:false}))))"
        })).unwrap();
        let mut accepted = HashSet::new();
        let mut completion = None;
        for _ in 0..16 {
            // A normal admission rejection must not turn this pump into Err.
            for event in driver.pump(&mut page).unwrap() {
                if event["type"] == "ipc-invoke" {
                    assert_eq!(event["channel"], "load:echo");
                    let value = event["args"][0].as_u64().unwrap();
                    assert!(accepted.insert(value), "IPC request was emitted twice");
                    command(&mut driver, &mut page, json!({"method": "resolveIpc",
                        "generation": event["generation"], "id": event["id"], "ok": true, "value": value})).unwrap();
                } else if event["type"] == "evaluation-result" {
                    completion = Some(event);
                }
            }
            if completion.is_some() { break; }
        }
        let completion = completion.expect("all accepted and rejected calls must settle");
        assert_eq!(completion["ok"], true, "{completion}");
        let results = completion["value"].as_array().unwrap();
        assert_eq!(results.len(), 300);
        let mut fulfilled = 0;
        for result in results {
            if result["ok"] == true {
                fulfilled += 1;
                assert!(accepted.contains(&result["value"].as_u64().unwrap()));
            }
        }
        assert!(fulfilled > 0 && fulfilled < 300, "expected accepted calls and bounded overflow");
        assert_eq!(fulfilled, accepted.len(), "accepted IPC tickets were lost");
        assert!(driver.pending_ipc.is_empty());
        assert!(driver.pending_evaluations.is_empty());

        // Capacity must be released for subsequent requests in the same document.
        command(&mut driver, &mut page, json!({"method": "startEvaluation", "id": "after-overflow",
            "source": "loadApi.send(12345)"})).unwrap();
        let ipc = wait_for(&mut driver, &mut page, "ipc-invoke");
        command(&mut driver, &mut page, json!({"method": "resolveIpc", "generation": ipc["generation"],
            "id": ipc["id"], "ok": true, "value": 12345})).unwrap();
        let result = wait_for(&mut driver, &mut page, "evaluation-result");
        assert_eq!(result["ok"], true);
        assert_eq!(result["value"], 12345);
    }

    #[test]
    fn batch_settlement_validates_all_members_before_consuming_tickets() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = runtime.enter();
        let mut page = Page::new("batch-ipc-test".into(),
            Arc::new(BrowserContext::new("batch-ipc-test".into())));
        let mut driver = Preload::new(&mut page);
        command(&mut driver, &mut page, json!({"method": "configurePreload", "source": r#"
            const { contextBridge, ipcRenderer } = require('electron');
            contextBridge.exposeInMainWorld('api', { echo: n => ipcRenderer.invoke('echo', n) });
        "#})).unwrap();
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate("about:blank")).unwrap();
        command(&mut driver, &mut page, json!({"method": "startEvaluation", "id": "batch",
            "source": "Promise.all(Array.from({length:8}, (_,n) => api.echo(n).then(value=>value,error=>error.message)))"
        })).unwrap();
        let mut replies = Vec::new();
        for _ in 0..16 {
            for event in driver.pump(&mut page).unwrap() {
                assert_eq!(event["type"], "ipc-invoke");
                let n = event["args"][0].as_u64().unwrap();
                replies.push(json!({"id": event["id"], "generation": event["generation"],
                    "ok": n % 2 == 0, "value": n, "error": "expected"}));
            }
            if replies.len() == 8 { break; }
        }
        assert_eq!(replies.len(), 8);
        let generation = driver.generation;
        let batch = |items: Vec<Value>| json!({"method": "resolveIpcBatch", "generation": generation, "replies": items});
        let mut invalid = replies.clone();
        invalid[7]["id"] = replies[0]["id"].clone();
        assert!(command(&mut driver, &mut page, batch(invalid)).unwrap_err().contains("duplicate"));
        assert_eq!(driver.pending_ipc.len(), 8);
        let mut stale = replies.clone();
        stale[7]["generation"] = json!(generation - 1);
        assert!(command(&mut driver, &mut page, batch(stale)).unwrap_err().contains("Stale"));
        assert_eq!(driver.pending_ipc.len(), 8);
        command(&mut driver, &mut page, batch(replies.clone())).unwrap();
        let completion = wait_for(&mut driver, &mut page, "evaluation-result");
        assert_eq!(completion["value"], json!([0, "expected", 2, "expected", 4, "expected", 6, "expected"]));
        assert!(driver.pending_ipc.is_empty());
        assert!(command(&mut driver, &mut page, batch(replies)).unwrap_err().contains("completed"));
    }

    #[test]
    fn owned_json_transport_preserves_copying_and_ignores_prototype_hooks() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = runtime.enter();
        let mut page = Page::new("owned-json-test".into(), Arc::new(BrowserContext::new("owned-json-test".into())));
        let mut driver = Preload::new(&mut page);
        command(&mut driver, &mut page, json!({"method":"configurePreload", "source":r#"
            let hooks = 0;
            require('electron').contextBridge.exposeInMainWorld('copyApi', {
                mutate: value => {
                    value.nested[0] = 'changed';
                    return { value, localPrototype: Object.getPrototypeOf(value) === Object.prototype,
                        polluted: Object.prototype.polluted === true, hooks };
                },
            });
            Object.defineProperty(Object.prototype, 'toJSON', { get() { hooks++; throw Error('inherited serialization hook'); } });
            Object.defineProperty(Array.prototype, 'toJSON', { get() { hooks++; throw Error('array serialization hook'); } });
        "#})).unwrap();
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate("about:blank")).unwrap();
        let result = evaluate(&mut driver, &mut page, "owned", r#"
            globalThis.serializationHooks = 0;
            Object.defineProperty(Object.prototype, 'toJSON', { get() { serializationHooks++; throw Error('page hook'); } });
            const original = JSON.parse('{"__proto__":{"polluted":true},"nested":["한글🙂\\u0000"],"constructor":"data"}');
            copyApi.mutate(original).then(result => [original.nested[0], result.value.nested[0],
                result.localPrototype, result.polluted, result.hooks, serializationHooks,
                Object.getPrototypeOf(result.value) === Object.prototype,
                Object.prototype.polluted === true, result.value.__proto__.polluted, result.value.constructor]);
        "#);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["value"], json!(["한글🙂\u{0000}", "changed", true, false, 0, 0, true, false, true, "data"]));
    }

    #[test]
    fn isolated_dynamic_import_cannot_execute_in_the_page_realm() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = runtime.enter();
        let mut page = Page::new("isolated-import-test".into(),
            Arc::new(BrowserContext::new("isolated-import-test".into())));
        let mut driver = Preload::new(&mut page);
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("weber-isolated-import-{}-{unique}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let module_path = directory.join("probe.mjs");
        let html_path = directory.join("index.html");
        std::fs::write(&module_path, "export default [typeof document,globalThis.realmMarker];").unwrap();
        std::fs::write(&html_path, "<script>globalThis.realmMarker='main';</script>").unwrap();
        let module_url = url::Url::from_file_path(&module_path).unwrap();
        let module_literal = serde_json::to_string(module_url.as_str()).unwrap();
        let source = format!("globalThis.realmMarker='isolated';
            require('electron').contextBridge.exposeInMainWorld('probeApi',{{
                probe:()=>import({module_literal}).then(module=>JSON.parse(JSON.stringify(module.default)))
                    .catch(error=>({{rejected:String(error)}}))
            }});");
        command(&mut driver, &mut page, json!({"method": "configurePreload", "source": source})).unwrap();
        driver.before_navigation().unwrap();
        runtime.block_on(page.navigate(url::Url::from_file_path(&html_path).unwrap().as_str())).unwrap();
        command(&mut driver, &mut page, json!({"method": "startEvaluation", "id": "import",
            "source": "probeApi.probe()"})).unwrap();
        let mut completion = None;
        for _ in 0..64 {
            let _ = runtime.block_on(async {
                tokio::time::timeout(std::time::Duration::from_millis(5), page.run_autonomous_event_loop_turn()).await
            });
            for event in driver.pump(&mut page).unwrap() {
                if event["type"] == "evaluation-result" { completion = Some(event); }
            }
            if completion.is_some() { break; }
        }
        std::fs::remove_dir_all(&directory).unwrap();
        let completion = completion.expect("isolated import must settle or reject cleanly");
        assert_eq!(completion["ok"], true, "{completion}");
        let value = &completion["value"];
        assert!(value.get("rejected").and_then(Value::as_str).is_some()
            || *value == json!(["undefined", "isolated"]),
            "Isolated dynamic import crossed the page context: {value}");
    }
}
