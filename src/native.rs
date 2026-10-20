//! Bounded native window requests. Mutations run after the script callback returns.
use anyhow::{Result, anyhow, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    rc::Rc,
    sync::OnceLock,
};

const MAX_WINDOWS: usize = 16;
static CAPABILITY: OnceLock<String> = OnceLock::new();
pub fn bounded_title(title: &str) -> &str {
    let mut end = title.len().min(1024);
    while !title.is_char_boundary(end) {
        end -= 1;
    }
    &title[..end]
}
pub fn capability() -> Option<&'static str> {
    CAPABILITY.get().map(String::as_str)
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Options {
    pub title: String,
    pub width: u32,
    pub height: u32,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            title: "Weber".into(),
            width: 960,
            height: 720,
        }
    }
}
impl Options {
    fn validate(&self) -> Result<()> {
        ensure!(self.title.len() <= 1024, "Window title too long");
        ensure!(
            (64..=8192).contains(&self.width) && (64..=8192).contains(&self.height),
            "Window dimensions must be 64..8192 logical pixels"
        );
        Ok(())
    }
}
pub enum Command {
    Open {
        id: u64,
        source: u64,
        generation: u64,
        options: Options,
    },
    Close(u64),
    CloseConfirmed(u64),
    Title(u64, String),
    Resize(u64, u32, u32),
    Maximize(u64, bool),
    Fullscreen(u64, bool),
    Resizable(u64, bool),
}
#[derive(Default)]
struct Watch {
    generation: u64,
    delivered: Option<u64>,
    in_flight: bool,
}
struct CloseWatch {
    generation: u64,
    pending: Option<u64>,
}
#[derive(Default)]
pub struct Control {
    pub wake: Option<winit::event_loop::EventLoopProxy<crate::host::Wake>>,
    pub memory_profile_label: Option<String>,
    pub commands: VecDeque<Command>,
    pub windows: BTreeMap<u64, Value>,
    pub portal_parents: BTreeMap<u64, String>,
    next: u64,
    revision: u64,
    watch_generation: u64,
    watches: BTreeMap<u64, Watch>,
    close_watches: BTreeMap<u64, CloseWatch>,
    close_serial: u64,
    wake_queued: bool,
    documents: BTreeMap<u64, u64>,
}
pub type Shared = Rc<RefCell<Control>>;
impl Control {
    pub fn wake(&mut self) {
        if !self.wake_queued
            && let Some(wake) = &self.wake
        {
            self.wake_queued = wake.send_event(crate::host::Wake::Native).is_ok();
        }
    }
    pub fn received_wake(&mut self) {
        self.wake_queued = false;
    }
    pub fn update(&mut self, id: u64, info: Value) {
        self.documents.entry(id).or_default();
        if self.windows.get(&id) != Some(&info) {
            self.windows.insert(id, info);
            self.revision += 1;
        }
    }
    pub fn remove(&mut self, id: u64) {
        self.documents.remove(&id);
        self.portal_parents.remove(&id);
        self.watches.remove(&id);
        self.close_watches.remove(&id);
        if self.windows.remove(&id).is_some() {
            self.revision += 1;
        }
    }
    /// Latest state only: one evaluation in flight per watching window. Intermediate
    /// resize/focus states are coalesced instead of accumulating behind a blocked UI.
    pub fn deliveries(&mut self) -> Vec<(u64, u64, Value)> {
        let revision = self.revision;
        if !self
            .watches
            .values()
            .any(|watch| !watch.in_flight && watch.delivered != Some(revision))
        {
            return Vec::new();
        }
        let snapshot = json!({ "revision": revision, "windows": self.windows.values().filter(|w| w["state"] != "failed").collect::<Vec<_>>() });
        self.watches
            .iter_mut()
            .filter_map(|(id, watch)| {
                if watch.in_flight || watch.delivered == Some(revision) {
                    return None;
                }
                watch.in_flight = true;
                watch.delivered = Some(revision);
                Some((
                    *id,
                    watch.generation,
                    json!({ "generation": watch.generation, "snapshot": snapshot }),
                ))
            })
            .collect()
    }
    pub fn acknowledge(&mut self, id: u64, generation: u64, success: bool) {
        if let Some(watch) = self.watches.get_mut(&id)
            && watch.generation == generation
        {
            if success {
                watch.in_flight = false;
                if watch.delivered != Some(self.revision) {
                    self.wake();
                }
            } else {
                self.watches.remove(&id);
            }
        }
    }
    pub fn detach(&mut self, id: u64) {
        if let Some(generation) = self.documents.get_mut(&id) {
            *generation = generation.wrapping_add(1);
        }
        self.watches.remove(&id);
        self.close_watches.remove(&id);
    }
    pub fn document_generation(&self, id: u64) -> Option<u64> {
        self.windows
            .contains_key(&id)
            .then(|| self.documents.get(&id).copied().unwrap_or(0))
    }
    /// None closes immediately; null coalesces repeated requests; an object
    /// requests a fresh JS decision. No window closes on a stale reply.
    pub fn request_close(&mut self, id: u64) -> Option<Value> {
        let watch = self.close_watches.get_mut(&id)?;
        if watch.pending.is_some() {
            return Some(Value::Null);
        }
        self.close_serial += 1;
        watch.pending = Some(self.close_serial);
        Some(json!({"generation":watch.generation,"token":self.close_serial}))
    }
}
thread_local! { static ACTIVE: RefCell<Option<(Shared, u64)>> = const { RefCell::new(None) }; }
pub struct Scope(Option<(Shared, u64)>);
impl Scope {
    pub fn enter(control: &Shared, id: u64) -> Self {
        Self(ACTIVE.with(|slot| slot.replace(Some((control.clone(), id)))))
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.with(|slot| {
            slot.replace(self.0.take());
        });
    }
}
pub fn current_id() -> u64 {
    ACTIVE.with(|slot| slot.borrow().as_ref().map_or(1, |(_, id)| *id))
}
pub fn initialize(supplied: Option<String>) -> Result<Shared> {
    let token = supplied.map_or_else(crate::backend::random_capability, Ok)?;
    ensure!(
        token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid native capability"
    );
    CAPABILITY
        .set(token)
        .map_err(|_| anyhow!("Native API already initialized"))?;
    let mut control = Control {
        next: 2,
        ..Control::default()
    };
    control
        .windows
        .insert(1, json!({ "id": 1, "state": "opening" }));
    Ok(Rc::new(RefCell::new(control)))
}
#[cfg(feature = "aot")]
pub fn exchange_active(payload: &str) -> String {
    ACTIVE.with(|slot| match slot.borrow().as_ref() {
        Some((control, id)) => exchange(control, *id, payload),
        None => {
            json!({ "ok": false, "error": { "message": "No active native window" } }).to_string()
        }
    })
}
#[cfg(any(feature = "aot", test))]
pub fn exchange(control: &Shared, source: u64, payload: &str) -> String {
    let request = if payload.len() > crate::files::MAX_PAYLOAD {
        Err(anyhow!("Native request too large"))
    } else {
        serde_json::from_str(payload).map_err(Into::into)
    };
    exchange_request(control, source, request, payload.len(), None)
}
/// The JIT host already parsed and authenticated this envelope. Transfer ownership
/// directly; keep the same canonical JSON byte limits as the string entry point.
pub fn exchange_value(control: &Shared, source: u64, request: Value) -> String {
    match crate::json::encoded_len(&request) {
        Ok(bytes) => exchange_request(control, source, Ok(request), bytes, Some(bytes)),
        Err(error) => exchange_request(control, source, Err(error.into()), 0, None),
    }
}
fn exchange_request(
    control: &Shared,
    source: u64,
    request: Result<Value>,
    bytes: usize,
    canonical_bytes: Option<usize>,
) -> String {
    let mut watch_started = false;
    let result = (|| -> Result<Value> {
        ensure!(
            bytes <= crate::files::MAX_PAYLOAD,
            "Native request too large"
        );
        let request = request?;
        if !matches!(
            request["op"].as_str(),
            Some("files.start" | "clipboard.start" | "storage.start")
        ) {
            ensure!(bytes <= 65_536, "Native request too large");
        }
        if !request["op"].as_str().is_some_and(|op| {
            op.starts_with("clipboard.") || op.starts_with("files.") || op == "storage.start"
        }) {
            ensure!(bytes <= 16_000, "Native request too large");
        }
        ensure!(request.is_object(), "Native request must be an object");
        let mut control = control.try_borrow_mut()?;
        ensure!(
            control
                .windows
                .get(&source)
                .is_some_and(|window| window["state"] == "ready"),
            "Calling window is closed"
        );
        let id = match request.get("id") {
            None => source,
            Some(id) => id
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or_else(|| anyhow!("Window id must be a positive integer"))?,
        };
        match request["op"].as_str() {
            Some("close.watch") => {
                ensure!(
                    !control.close_watches.contains_key(&source),
                    "Close handler already registered"
                );
                control.watch_generation += 1;
                let generation = control.watch_generation;
                control.close_watches.insert(
                    source,
                    CloseWatch {
                        generation,
                        pending: None,
                    },
                );
                Ok(json!({"generation":generation}))
            }
            Some("close.unwatch") => {
                if control
                    .close_watches
                    .get(&source)
                    .is_some_and(|w| Some(w.generation) == request["generation"].as_u64())
                {
                    control.close_watches.remove(&source);
                }
                Ok(Value::Null)
            }
            Some("close.reply") => {
                ensure!(control.commands.len() < 64, "Native command queue full");
                let allow = request["allow"]
                    .as_bool()
                    .ok_or_else(|| anyhow!("Close decision required"))?;
                let watch = control
                    .close_watches
                    .get_mut(&source)
                    .ok_or_else(|| anyhow!("Close handler unavailable"))?;
                ensure!(
                    Some(watch.generation) == request["generation"].as_u64()
                        && watch.pending.is_some()
                        && watch.pending == request["token"].as_u64(),
                    "Stale close decision"
                );
                watch.pending = None;
                if allow {
                    control.commands.push_back(Command::CloseConfirmed(source));
                }
                Ok(Value::Null)
            }
            Some("files.start") => {
                ensure!(
                    control
                        .windows
                        .get(&source)
                        .is_some_and(|window| window["focused"] == true),
                    "File chooser requires the calling window to have focus"
                );
                crate::files::submit(
                    source,
                    request,
                    control
                        .portal_parents
                        .get(&source)
                        .cloned()
                        .unwrap_or_default(),
                )
            }
            Some("files.poll") => crate::files::poll(source, &request),
            Some("files.cancel") => {
                crate::files::cancel(source, &request)?;
                Ok(Value::Null)
            }
            Some("clipboard.start") => {
                ensure!(
                    control
                        .windows
                        .get(&source)
                        .is_some_and(|window| window["focused"] == true),
                    "Clipboard requires the calling window to have focus"
                );
                crate::clipboard::submit(source, request)
            }
            Some("clipboard.poll") => crate::clipboard::poll(source, &request),
            Some("clipboard.cancel") => {
                crate::clipboard::cancel(source, &request)?;
                Ok(Value::Null)
            }
            Some("storage.start") => {
                // The string/AOT entry retains its raw transport limit, but its
                // numeric spelling can expand when serialized. Charge the queue
                // for canonical JSON in both paths, as before this optimization.
                let charge = match canonical_bytes {
                    Some(bytes) => bytes,
                    None => crate::json::encoded_len(&request)?,
                };
                crate::storage::submit(source, request, charge)
            }
            Some("storage.poll") => crate::storage::poll(source, &request),
            Some("storage.cancel") => {
                crate::storage::cancel(source, &request)?;
                Ok(Value::Null)
            }
            Some("watch") => {
                control.watch_generation += 1;
                let generation = control.watch_generation;
                control.watches.insert(
                    source,
                    Watch {
                        generation,
                        ..Watch::default()
                    },
                );
                watch_started = true;
                Ok(json!({ "generation": generation }))
            }
            Some("unwatch") => {
                let generation = request["generation"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("Watch generation required"))?;
                if control
                    .watches
                    .get(&source)
                    .is_some_and(|watch| watch.generation == generation)
                {
                    control.watches.remove(&source);
                }
                Ok(Value::Null)
            }
            Some("info") => control
                .windows
                .get(&id)
                .cloned()
                .ok_or_else(|| anyhow!("Unknown or closed window")),
            Some("list") => Ok(json!(
                control
                    .windows
                    .values()
                    .filter(|w| w["state"] != "failed")
                    .collect::<Vec<_>>()
            )),
            Some("open") => {
                ensure!(
                    control
                        .windows
                        .values()
                        .filter(|w| w["state"] != "failed")
                        .count()
                        < MAX_WINDOWS,
                    "Window limit reached"
                );
                ensure!(control.commands.len() < 64, "Native command queue full");
                let options: Options =
                    serde_json::from_value(request.get("options").cloned().unwrap_or(json!({})))?;
                options.validate()?;
                let id = control.next;
                control.next += 1;
                let failed: Vec<_> = control
                    .windows
                    .iter()
                    .filter_map(|(id, window)| (window["state"] == "failed").then_some(*id))
                    .collect();
                for id in failed {
                    control.remove(id);
                }
                let generation = control
                    .document_generation(source)
                    .ok_or_else(|| anyhow!("Opening document closed"))?;
                control.update(id, json!({ "id": id, "state": "opening" }));
                control.commands.push_back(Command::Open {
                    id,
                    source,
                    generation,
                    options,
                });
                Ok(json!({ "id": id }))
            }
            Some("close" | "title" | "resize" | "maximize" | "fullscreen" | "resizable") => {
                ensure!(
                    control.windows.contains_key(&id),
                    "Unknown or closed window"
                );
                ensure!(control.commands.len() < 64, "Native command queue full");
                let command = match request["op"].as_str() {
                    Some("close") => Command::Close(id),
                    Some("resize") => {
                        let size: Options = serde_json::from_value(
                            json!({ "width": request["width"], "height": request["height"] }),
                        )?;
                        size.validate()?;
                        Command::Resize(id, size.width, size.height)
                    }
                    Some(op @ ("maximize" | "fullscreen" | "resizable")) => {
                        let value = request["value"]
                            .as_bool()
                            .ok_or_else(|| anyhow!("Boolean value required"))?;
                        match op {
                            "maximize" => Command::Maximize(id, value),
                            "fullscreen" => Command::Fullscreen(id, value),
                            _ => Command::Resizable(id, value),
                        }
                    }
                    _ => {
                        let title = request["title"]
                            .as_str()
                            .ok_or_else(|| anyhow!("Window title required"))?;
                        ensure!(title.len() <= 1024, "Window title too long");
                        Command::Title(id, title.to_owned())
                    }
                };
                control.commands.push_back(command);
                Ok(Value::Null)
            }
            _ => Err(anyhow!("Unknown native operation")),
        }
    })();
    if let Ok(mut control) = control.try_borrow_mut()
        && (watch_started || !control.commands.is_empty())
    {
        control.wake();
    }
    match result {
        Ok(value) => json!({ "ok": true, "result": value }),
        Err(error) => {
            json!({ "ok": false, "error": { "name": "NativeError", "message": error.to_string() } })
        }
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_opens_keep_document_generation_and_failed_documents_retire() {
        let control = shared();
        control
            .borrow_mut()
            .update(10000, json!({"id":10000,"state":"ready"}));
        let first = call(&control, json!({"op":"open"}));
        assert_eq!(first["ok"], true);
        let old_generation = match control.borrow_mut().commands.pop_front() {
            Some(Command::Open { generation, .. }) => generation,
            _ => panic!("Expected open command"),
        };
        control.borrow_mut().detach(1);
        assert_ne!(
            control.borrow().document_generation(1),
            Some(old_generation)
        );
        assert_eq!(control.borrow().document_generation(10000), Some(0));
        for _ in 0..100 {
            let result = call(&control, json!({"op":"open"}));
            assert_eq!(result["ok"], true);
            let id = result["result"]["id"].as_u64().unwrap_or(0);
            let generation = match control.borrow_mut().commands.pop_front() {
                Some(Command::Open { generation, .. }) => generation,
                _ => panic!("Expected open command"),
            };
            assert_eq!(Some(generation), control.borrow().document_generation(1));
            control
                .borrow_mut()
                .update(id, json!({"id":id,"state":"failed"}));
            assert!(control.borrow().documents.len() <= 4);
        }
        control.borrow_mut().remove(1);
        assert_eq!(control.borrow().document_generation(1), None);
        assert!(!control.borrow().documents.contains_key(&1));
    }

    #[test]
    fn close_decisions_coalesce_and_stale_or_foreign_replies_cannot_close() {
        let control = shared();
        control
            .borrow_mut()
            .update(2, json!({"id":2,"state":"ready"}));
        let generation =
            call(&control, json!({"op":"close.watch"}))["result"]["generation"].clone();
        let event = control.borrow_mut().request_close(1).unwrap_or(Value::Null);
        assert_eq!(control.borrow_mut().request_close(1), Some(Value::Null));
        let reply =
            json!({"op":"close.reply","generation":generation,"token":event["token"],"allow":true});
        let foreign: Value =
            serde_json::from_str(&exchange(&control, 2, &reply.to_string())).unwrap_or(Value::Null);
        assert_eq!(foreign["ok"], false);
        call(
            &control,
            json!({"op":"close.unwatch","generation":generation}),
        );
        call(&control, json!({"op":"close.watch"}));
        assert_eq!(call(&control, reply)["ok"], false);
        let fresh = control.borrow_mut().request_close(1).unwrap_or(Value::Null);
        assert_eq!(
            call(
                &control,
                json!({"op":"close.reply","generation":fresh["generation"],"token":fresh["token"],"allow":false})
            )["ok"],
            true
        );
        assert!(control.borrow().commands.is_empty());
        let next = control.borrow_mut().request_close(1).unwrap_or(Value::Null);
        assert_eq!(
            call(
                &control,
                json!({"op":"close.reply","generation":next["generation"],"token":next["token"],"allow":true})
            )["ok"],
            true
        );
        assert!(matches!(
            control.borrow().commands.front(),
            Some(Command::CloseConfirmed(1))
        ));
    }

    fn shared() -> Shared {
        let mut control = Control {
            next: 2,
            ..Control::default()
        };
        control.update(1, json!({ "id": 1, "state": "ready" }));
        Rc::new(RefCell::new(control))
    }
    fn call(control: &Shared, value: Value) -> Value {
        serde_json::from_str(&exchange(control, 1, &value.to_string())).unwrap_or(Value::Null)
    }
    #[test]
    fn blocked_watcher_coalesces_and_stale_ack_cannot_release_new_generation() {
        let control = shared();
        let generation = call(&control, json!({ "op": "watch" }))["result"]["generation"]
            .as_u64()
            .unwrap_or(0);
        assert!(generation > 0);
        assert_eq!(control.borrow_mut().deliveries().len(), 1);
        for width in 1..1000 {
            control
                .borrow_mut()
                .update(1, json!({ "id": 1, "state": "ready", "width": width }));
        }
        assert!(control.borrow_mut().deliveries().is_empty());
        control.borrow_mut().acknowledge(1, generation, true);
        let deliveries = control.borrow_mut().deliveries();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].2["snapshot"]["windows"][0]["width"], 999);
        assert!(control.borrow_mut().deliveries().is_empty());
        let replacement = call(&control, json!({ "op": "watch" }))["result"]["generation"]
            .as_u64()
            .unwrap_or(0);
        assert!(replacement > generation);
        assert_eq!(control.borrow_mut().deliveries().len(), 1);
        control.borrow_mut().acknowledge(1, generation, true);
        assert!(control.borrow().watches[&1].in_flight);
        call(
            &control,
            json!({ "op": "unwatch", "generation": generation }),
        );
        assert_eq!(control.borrow().watches.len(), 1);
        control.borrow_mut().acknowledge(1, replacement, true);
        assert!(control.borrow_mut().deliveries().is_empty());
        control.borrow_mut().remove(1);
        assert!(control.borrow().watches.is_empty());
    }
    #[test]
    fn invalid_commands_and_full_queue_do_not_enqueue() {
        let control = shared();
        for invalid in [
            json!([]),
            json!({ "op": "close", "id": "1" }),
            json!({ "op": "close", "id": 0 }),
            json!({ "op": "maximize", "value": 1 }),
            json!({ "op": "resize", "width": 0, "height": 100 }),
            json!({ "op": "close", "id": 99 }),
        ] {
            assert_eq!(call(&control, invalid)["ok"], false);
        }
        assert!(control.borrow().commands.is_empty());
        for _ in 0..64 {
            assert_eq!(
                call(
                    &control,
                    json!({ "op": "resize", "width": 640, "height": 480 })
                )["ok"],
                true
            );
        }
        assert_eq!(call(&control, json!({ "op": "close" }))["ok"], false);
        assert_eq!(control.borrow().commands.len(), 64);
        control.borrow_mut().remove(1);
        assert_eq!(call(&control, json!({ "op": "list" }))["ok"], false);
    }
    #[test]
    fn owned_requests_preserve_validation_and_encoded_byte_limits() {
        for request in [
            json!([]),
            json!({"op":"list"}),
            json!({"op":"title", "title":"한글"}),
            json!({"op":"close", "id":99}),
            json!({"op":"unknown", "padding":"\0".repeat(3000)}),
            json!({"op":"clipboard.poll", "padding":"한".repeat(22000)}),
            json!({"op":"storage.start", "padding":"x".repeat(crate::files::MAX_PAYLOAD)}),
        ] {
            let expected = exchange(&shared(), 1, &request.to_string());
            assert_eq!(exchange_value(&shared(), 1, request), expected);
        }
    }
    #[test]
    fn page_titles_fit_snapshot_budget_without_splitting_utf8() {
        let title = "한글".repeat(1000);
        assert!(bounded_title(&title).len() <= 1024);
        assert_eq!(bounded_title(&title).len(), 1023);
        assert_eq!(bounded_title("Short title"), "Short title");
    }
}
