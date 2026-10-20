use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use servo::WebView;

#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
enum Command {
    Clone {
        source: u32,
        deep: bool,
        handles: Vec<CloneHandle>,
    },
    Title {
        value: String,
    },
    Release {
        node: u32,
    },
    Reset {
        epoch: u32,
    },
    Create {
        node: u32,
        tag: String,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        inert: bool,
    },
    Append {
        parent: u32,
        node: u32,
    },
    Createtext {
        node: u32,
        value: String,
    },
    Createfragment {
        node: u32,
        #[serde(default)]
        template: Option<u32>,
    },
    Createcomment {
        node: u32,
        value: String,
    },
    Createinstruction {
        node: u32,
        target: String,
        value: String,
    },
    Insert {
        parent: u32,
        node: u32,
        before: Option<u32>,
    },
    Detach {
        node: u32,
    },
    Removeattribute {
        node: u32,
        name: String,
    },
    Property {
        node: u32,
        name: Property,
        value: String,
    },
    Text {
        node: u32,
        value: String,
    },
    Attribute {
        node: u32,
        name: String,
        value: String,
    },
    Attributens {
        node: u32,
        namespace: Option<String>,
        name: String,
        value: String,
    },
    Removeattributens {
        node: u32,
        namespace: Option<String>,
        name: String,
    },
    Listen {
        node: u32,
        event: EventType,
        listener: u32,
    },
    Remove {
        node: u32,
    },
    Schedule {
        handle: u32,
        kind: TaskKind,
        delay: i32,
    },
    Cancel {
        handle: u32,
    },
    Resizeobserve {
        observer: u32,
        node: u32,
        r#box: ResizeBox,
    },
    Resizeunobserve {
        observer: u32,
        node: u32,
    },
    Resizedisconnect {
        observer: u32,
    },
    Fetchstart {
        handle: u32,
        url: String,
        method: String,
        headers: Vec<(String, String)>,
        body: Option<String>,
    },
    Fetchabort {
        handle: u32,
    },
    Dispose,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CloneHandle {
    node: u32,
    name: String,
    r#type: u8,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ResizeBox {
    #[serde(rename = "content-box")]
    Content,
    #[serde(rename = "border-box")]
    Border,
    #[serde(rename = "device-pixel-content-box")]
    DevicePixelContent,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResizeMessage {
    epoch: u32,
    observer: u32,
    entries: Vec<ResizeEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResizeEntry {
    target: u32,
    content_rect: Rect,
    border_box_size: Vec<BoxSize>,
    content_box_size: Vec<BoxSize>,
    device_pixel_content_box_size: Vec<BoxSize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BoxSize {
    inline_size: f64,
    block_size: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FetchMessage {
    epoch: u32,
    handle: u32,
    error: Option<String>,
    response: Option<FetchResponse>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FetchResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    url: String,
    redirected: bool,
    r#type: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum TaskKind {
    Timeout,
    Interval,
    Frame,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Task {
    epoch: u32,
    handle: u32,
    timestamp: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Property {
    Value,
    Checked,
    Disabled,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum EventType {
    Click,
    Input,
    Change,
    Submit,
    Keydown,
    Keyup,
    Beforeinput,
    Scroll,
    Compositionstart,
    Compositionupdate,
    Compositionend,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Event {
    epoch: u32,
    listener: u32,
    value: String,
    #[serde(default)]
    target: Option<u32>,
    #[serde(default)]
    bubbles: bool,
    #[serde(default)]
    cancelable: bool,
    #[serde(default)]
    default_prevented: bool,
    #[serde(default)]
    checked: Option<bool>,
    #[serde(default)]
    ui: Option<UiEvent>,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum UiEvent {
    Composition {
        data: String,
    },
    Mouse {
        screen_x: i32,
        screen_y: i32,
        client_x: i32,
        client_y: i32,
        button: i16,
        buttons: u16,
        detail: i32,
        related_target: Option<u32>,
        alt_key: bool,
        ctrl_key: bool,
        meta_key: bool,
        shift_key: bool,
    },
    Keyboard {
        key: String,
        code: String,
        location: u32,
        repeat: bool,
        is_composing: bool,
        key_code: u32,
        char_code: u32,
        alt_key: bool,
        ctrl_key: bool,
        meta_key: bool,
        shift_key: bool,
    },
    Input {
        data: Option<String>,
        input_type: String,
        is_composing: bool,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Decision {
    default_prevented: bool,
    stop_propagation: bool,
    stop_immediate_propagation: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SyncReply {
    commands: Vec<Command>,
    decision: Decision,
    #[serde(default)]
    data: Option<serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum QueryKind {
    Rect,
    Rects,
    Computed,
    ComputedNames,
    Metrics,
    Viewport,
    Scroll,
    Focus,
    Blur,
    Active,
    Style,
    Node,
    Selectors,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueryArgs {
    #[serde(default)]
    op: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    pseudo: Option<String>,
    #[serde(default)]
    relative: Option<bool>,
    #[serde(default)]
    behavior: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    prevent_scroll: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LiveQuery {
    epoch: u32,
    kind: QueryKind,
    node: Option<u32>,
    args: QueryArgs,
    commands: Vec<Command>,
}

pub fn validate_query(payload: &str) -> Result<()> {
    ensure!(payload.len() <= 1_048_576, "DOM query too large");
    validate_query_value(serde_json::from_str(payload)?)
}

pub fn validate_query_value(value: serde_json::Value) -> Result<()> {
    let query: LiveQuery = serde_json::from_value(value)?;
    ensure!(query.epoch > 0, "DOM query session missing");
    ensure!(
        query.args.x.is_none_or(f64::is_finite) && query.args.y.is_none_or(f64::is_finite),
        "Nonfinite scroll coordinate"
    );
    Ok(())
}

pub fn sync_exchange(
    runtime: &mut cxx::UniquePtr<crate::aot::ffi::Runtime>,
    payload: &[u8],
    request: serde_json::Value,
    binary: bool,
) -> Result<(Vec<u8>, bool)> {
    ensure!(payload.len() <= 65_536, "host request too large");
    let wpt_start = request["action"] == "wpt-start";
    ensure!(
        matches!(
            request["action"].as_str(),
            Some(
                "browser"
                    | "application"
                    | "application-test"
                    | "application-remount"
                    | "binding-prepare"
                    | "binding-contracts"
                    | "style-contracts"
                    | "solid"
                    | "event"
                    | "dispose"
                    | "task"
                    | "backend-events"
                    | "window-state"
                    | "checkpoint"
                    | "wpt-start"
                    | "wpt-status"
                    | "profile-start"
                    | "profile-status"
                    | "profile-arm-disposal"
                    | "desktop"
                    | "collect"
                    | "desktop-status"
                    | "desktop-command"
                    | "resize"
                    | "fetch"
            )
        ),
        "unsupported synchronous action"
    );
    if request["action"] == "desktop-command" {
        ensure!(
            matches!(
                request["event"]["command"].as_str(),
                Some("mutate" | "retain" | "reinsert" | "releaseRetained")
            ),
            "Unknown desktop workload"
        );
        if let Some(count) = request["event"]["count"].as_u64() {
            ensure!(count <= 2000, "Mutation cohort too large");
        }
    }
    if request["action"] == "application-test" {
        ensure!(
            std::env::var("WEBER_APP_TEST").as_deref() == Ok("1"),
            "Application test API is disabled"
        );
    }
    if request["action"] == "profile-start" {
        *runtime = crate::aot::ffi::create_runtime()?;
    }
    if wpt_start {
        let index = request["event"]["index"]
            .as_u64()
            .filter(|value| *value < 17)
            .ok_or_else(|| anyhow::anyhow!("Unknown locked WPT index"))? as u32;
        *runtime = crate::aot::ffi::create_runtime()?;
        if binary {
            runtime
                .pin_mut()
                .host_call_bytes(payload, false, false, false)?;
        } else {
            runtime
                .pin_mut()
                .host_call(std::str::from_utf8(payload)?, false, false, false)?;
        }
        runtime.pin_mut().wpt_start(index)?;
    }
    if request["action"] == "event" {
        let _: Event = serde_json::from_value(request["event"].clone())?;
    }
    if request["action"] == "task" {
        let task: Task = serde_json::from_value(request["event"].clone())?;
        ensure!(
            task.epoch > 0 && task.handle > 0 && task.timestamp.is_finite(),
            "invalid scheduled task"
        );
    }
    if request["action"] == "resize" {
        let message: ResizeMessage = serde_json::from_value(request["event"].clone())?;
        ensure!(
            message.epoch > 0 && message.observer > 0 && message.entries.len() <= 1024,
            "Invalid resize delivery"
        );
        for entry in message.entries {
            ensure!(
                entry.target > 0
                    && [
                        entry.content_rect.x,
                        entry.content_rect.y,
                        entry.content_rect.width,
                        entry.content_rect.height
                    ]
                    .into_iter()
                    .all(f64::is_finite),
                "Invalid resize rectangle"
            );
            for size in entry
                .border_box_size
                .into_iter()
                .chain(entry.content_box_size)
                .chain(entry.device_pixel_content_box_size)
            {
                ensure!(
                    size.inline_size.is_finite() && size.block_size.is_finite(),
                    "Invalid resize size"
                );
            }
        }
    }
    if request["action"] == "fetch" {
        let message: FetchMessage = serde_json::from_value(request["event"].clone())?;
        ensure!(
            message.epoch > 0
                && message.handle > 0
                && (message.error.is_some() != message.response.is_some()),
            "Invalid fetch delivery"
        );
        if let Some(response) = message.response {
            ensure!(
                response.status <= 599
                    && response.status_text.len() <= 1024
                    && response.headers.len() <= 1024
                    && response
                        .body
                        .as_ref()
                        .is_none_or(|body| body.len() <= 1_048_576)
                    && response.url.len() <= 65_536
                    && matches!(
                        response.r#type.as_str(),
                        "basic" | "cors" | "default" | "opaque" | "opaqueredirect" | "error"
                    ),
                "Invalid fetch response"
            );
            let _redirected = response.redirected;
        }
    }
    let checkpoint = request["action"] != "event";
    let collect = request["action"] == "collect";
    let report = matches!(
        request["action"].as_str(),
        Some(
            "binding-contracts"
                | "wpt-start"
                | "wpt-status"
                | "profile-start"
                | "profile-status"
                | "desktop-status"
                | "collect"
                | "style-contracts"
                | "application-test"
        )
    );
    let raw = if binary {
        runtime
            .pin_mut()
            .host_call_bytes(payload, checkpoint, collect, report)?
    } else {
        runtime
            .pin_mut()
            .host_call(std::str::from_utf8(payload)?, checkpoint, collect, report)?
            .into_bytes()
    };
    ensure!(raw.len() <= 1_048_576, "host reply too large");
    let _: SyncReply = if binary {
        serde_json::from_value(crate::wire::decode(&raw)?)?
    } else {
        serde_json::from_slice(&raw)?
    };
    // Preserve validation, then forward the original bytes without serializing
    // the complete command/report tree a second time.
    Ok((raw, request["action"] != "dispose"))
}

pub fn dispatch(
    runtime: &mut cxx::UniquePtr<crate::aot::ffi::Runtime>,
    view: &WebView,
    url: &url::Url,
) {
    if url.host_str() == Some("dom-solid") {
        view.evaluate_javascript(
            format!(
                "{}\nwindow.__weberDom.call('solid')",
                [include_str!("wire.js"), include_str!("dom_adapter.js")].join("\n")
            ),
            |result| {
                if let Err(error) = result {
                    log::error!("Solid bootstrap failed: {error:?}");
                }
            },
        );
        return;
    }
    let result = commands(runtime, url).and_then(|raw| {
        ensure!(raw.len() <= 65_536, "DOM command batch too large");
        let commands: Vec<Command> = serde_json::from_str(&raw)?;
        Ok(serde_json::to_string(&commands)?)
    });
    let script = match result {
        Ok(commands) => format!(
            "{}\nwindow.__weberDom.apply({commands})",
            [include_str!("wire.js"), include_str!("dom_adapter.js")].join("\n")
        ),
        Err(error) => {
            log::warn!("DOM binding rejected: {error}");
            let message = serde_json::to_string(&error.to_string())
                .unwrap_or_else(|_| "\"DOM binding error\"".to_owned());
            format!("window.__weberDom?.fail({message})")
        }
    };
    view.evaluate_javascript(script, |result| {
        if let Err(error) = result {
            log::error!("DOM adapter evaluation: {error:?}");
        }
    });
}

fn commands(
    runtime: &mut cxx::UniquePtr<crate::aot::ffi::Runtime>,
    url: &url::Url,
) -> Result<String> {
    match url.host_str() {
        Some("dom-start") => Ok(runtime.pin_mut().dom_start()?),
        Some("dom-browser") => Ok(runtime.pin_mut().dom_browser()?),
        Some("dom-dispose") => Ok(runtime.pin_mut().dom_dispose()?),
        Some("dom-event") => {
            let raw = url
                .query_pairs()
                .find(|(key, _)| key == "event")
                .map(|(_, value)| value.into_owned())
                .ok_or_else(|| anyhow::anyhow!("DOM event missing"))?;
            ensure!(raw.len() <= 8192, "DOM event too large");
            let event: Event = serde_json::from_str(&raw)?;
            Ok(runtime
                .pin_mut()
                .dom_event(&serde_json::to_string(&event)?)?)
        }
        _ => anyhow::bail!("unsupported DOM request"),
    }
}
