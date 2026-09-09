//! Experimental trusted-local-application host. Not an Electron sandbox.
use std::{collections::HashSet, io::{BufRead, Write}, num::NonZeroU32, path::PathBuf,
    rc::Rc, sync::Arc, time::{Duration, Instant}};
use obscura_browser::{BrowserContext, Page};
use serde::Deserialize;
use serde_json::{json, Value};
use winit::{application::ApplicationHandler, dpi::LogicalSize,
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop}, keyboard::{Key, NamedKey},
    window::{Window, WindowId}};

const MAX_FRAME: usize = 1024 * 1024;
const TICK: Duration = Duration::from_millis(33);
type Result<T> = std::result::Result<T, String>;
pub type NativeHandler = Box<dyn FnMut(&str, Value) -> Result<Value>>;

#[derive(Debug, Deserialize)]
struct Request { id: u64, method: String, #[serde(default)] params: Value }
enum UserEvent { Request(Request), Disconnected }

fn output(value: Value) {
    let line = format!("@weber:{value}\n");
    if line.len() > MAX_FRAME {
        // Never silently drop a response and leave the peer waiting.
        let fallback = json!({"id": value.get("id"), "error": "Response exceeds 1 MiB"});
        let _ = writeln!(std::io::stdout().lock(), "@weber:{fallback}");
    } else {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(line.as_bytes());
        let _ = stdout.flush();
    }
}

/// Start the private-pipe host used by the Node.js and Bun packages.
pub fn run_host() -> Result<()> {
    let event_loop = EventLoop::<UserEvent>::with_user_event().build().map_err(|e| e.to_string())?;
    let proxy = event_loop.create_proxy();
    // An acknowledgement bounds the winit event queue to one pipe request.
    let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        loop {
            let mut line = Vec::new();
            let mut limited = std::io::Read::take(&mut input, (MAX_FRAME + 1) as u64);
            match limited.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > MAX_FRAME || !line.ends_with(b"\n") => break,
                _ => {}
            }
            let request: Request = match serde_json::from_slice(&line) { Ok(r) => r, Err(_) => break };
            if proxy.send_event(UserEvent::Request(request)).is_err() { return; }
            if ack_rx.recv().is_err() { return; }
        }
        let _ = proxy.send_event(UserEvent::Disconnected);
    });
    let mut app = Host::new(None, None)?;
    app.ack = Some(ack_tx);
    event_loop.run_app(&mut app).map_err(|e| e.to_string())
}

/// Run without a Node.js/Bun process. The callback executes on the GUI thread;
/// expensive application work should be moved to an application-owned worker.
pub fn run_native(path: PathBuf, allowed_channels: Vec<String>, handler: NativeHandler) -> Result<()> {
    let event_loop = EventLoop::<UserEvent>::with_user_event().build().map_err(|e| e.to_string())?;
    let mut app = Host::new(Some((path, allowed_channels)), Some(handler))?;
    event_loop.run_app(&mut app).map_err(|e| e.to_string())?;
    if let Some(error) = app.fatal { Err(error) } else { Ok(()) }
}

struct View {
    // Drop the surface before its backing window and the page before runtime.
    surface: softbuffer::Surface<Rc<Window>, Rc<Window>>,
    window: Rc<Window>,
    page: Page,
    channels: HashSet<String>,
    epoch: u64,
    loaded: bool,
    cursor: (f64, f64),
}
struct Host {
    view: Option<View>,
    runtime: tokio::runtime::Runtime,
    startup: Option<(PathBuf, Vec<String>)>,
    native: Option<NativeHandler>,
    ack: Option<std::sync::mpsc::SyncSender<()>>,
    announced: bool,
    next_tick: Instant,
    next_epoch: u64,
    fatal: Option<String>,
}
impl Host {
    fn new(startup: Option<(PathBuf, Vec<String>)>, native: Option<NativeHandler>) -> Result<Self> {
        Ok(Self { view: None,
            runtime: tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?,
            startup, native, ack: None, announced: false, next_tick: Instant::now(), next_epoch: 0, fatal: None })
    }

    fn create(&mut self, event_loop: &ActiveEventLoop, params: &Value) -> Result<Value> {
        if self.view.is_some() { return Err("Prototype supports one window per host; renderer process isolation is pending".into()); }
        let width = dimension(params, "width", 960)?;
        let height = dimension(params, "height", 640)?;
        let channels = params.get("allowedChannels").and_then(Value::as_array).ok_or("allowedChannels must be an array")?;
        if channels.len() > 128 { return Err("Too many allowed channels".into()); }
        let channels = channels.iter().map(|v| {
            let s = v.as_str().ok_or("Invalid channel")?;
            if s.is_empty() || s.len() > 128 { return Err("Invalid channel"); }
            Ok(s.to_owned())
        }).collect::<std::result::Result<HashSet<_>, _>>()?;
        let window = Rc::new(event_loop.create_window(Window::default_attributes()
            .with_title(params.get("title").and_then(Value::as_str).unwrap_or("Weber"))
            .with_visible(params.get("show").and_then(Value::as_bool).unwrap_or(true))
            .with_inner_size(LogicalSize::new(width, height))).map_err(|e| e.to_string())?);
        window.set_ime_allowed(true);
        let context = softbuffer::Context::new(window.clone()).map_err(|e| e.to_string())?;
        let surface = softbuffer::Surface::new(&context, window.clone()).map_err(|e| e.to_string())?;
        let _guard = self.runtime.enter();
        let mut page = Page::new("weber-1".into(), Arc::new(BrowserContext::new("weber".into())));
        page.set_navigation_timeout(Duration::from_secs(15));
        page.add_preload_script(include_str!("bridge.js"));
        page.add_preload_script(include_str!("input.js"));
        self.view = Some(View { surface, window, page, channels, epoch: 0, loaded: false, cursor: (0.0, 0.0) });
        Ok(json!(1))
    }

    fn command(&mut self, event_loop: &ActiveEventLoop, method: &str, params: &Value) -> Result<Value> {
        if method == "app.quit" { event_loop.exit(); return Ok(Value::Null); }
        if method == "window.create" { return self.create(event_loop, params); }
        if params.get("window").and_then(Value::as_u64) != Some(1) { return Err("Unknown window".into()); }
        if method == "window.close" {
            if self.view.take().is_none() { return Err("Window is closed".into()); }
            self.emit(json!({"event": "closed", "window": 1}));
            return Ok(Value::Null);
        }
        let view = self.view.as_mut().ok_or("Window is closed")?;
        let _guard = self.runtime.enter();
        match method {
            "window.loadFile" => {
                let path = std::fs::canonicalize(string(params, "path")?).map_err(|e| e.to_string())?;
                if !path.is_file() { return Err("Expected a file".into()); }
                let url = url::Url::from_file_path(path).map_err(|_| "Invalid file path")?;
                view.loaded = false;
                // Never reuse a document generation after closing/reopening
                // the single supported window in this host session.
                self.next_epoch += 1;
                view.epoch = self.next_epoch;
                let size = view.window.inner_size().to_logical::<f32>(view.window.scale_factor());
                view.page.set_viewport((size.width.max(1.0), size.height.max(1.0)));
                view.page.set_device_scale_factor(view.window.scale_factor() as f32);
                self.runtime.block_on(view.page.navigate(url.as_str())).map_err(|e| e.to_string())?;
                self.runtime.block_on(view.page.prepare_screenshot_resources(100));
                view.loaded = true;
                view.window.request_redraw();
                Ok(Value::Null)
            }
            "window.evaluate" => {
                if !view.loaded { return Err("No loaded document".into()); }
                // Page's convenience evaluate() swallows JS exceptions. Wrap an
                // explicit success envelope so thrown values remain observable.
                let source = serde_json::to_string(string(params, "source")?).map_err(|e| e.to_string())?;
                let result = view.page.evaluate_with_timeout(&format!(
                    "(() => {{ try {{ const result = (0, eval)({source}); if (result && typeof result.then === 'function') throw new Error('Promise results are not supported yet'); return {{ok:true,result:result === undefined ? null : result}}; }} catch(e) {{ return {{ok:false,error:String(e)}}; }} }})()"), Duration::from_secs(2));
                if result.get("ok").and_then(Value::as_bool) == Some(true) { Ok(result["result"].clone()) }
                else { Err(result.get("error").and_then(Value::as_str).unwrap_or("JavaScript execution failed or timed out").into()) }
            }
            "window.url" => Ok(json!(view.page.url_string())),
            "window.title" => { view.window.set_title(string(params, "title")?); Ok(Value::Null) }
            "window.visible" => {
                view.window.set_visible(params.get("visible").and_then(Value::as_bool).ok_or("Invalid visibility")?);
                Ok(Value::Null)
            }
            "ipc.reply" => {
                if params.get("epoch").and_then(Value::as_u64) != Some(view.epoch) { return Err("Stale document reply".into()); }
                if !view.loaded { return Err("No loaded document".into()); }
                view.page.evaluate_with_timeout(&format!("globalThis.__weberReply({params})"), Duration::from_secs(2));
                Ok(Value::Null)
            }
            _ => Err(format!("Unsupported host method: {method}")),
        }
    }

    fn emit(&self, value: Value) { if self.native.is_none() { output(value); } }

    fn tick(&mut self) -> Result<()> {
        let Some(view) = self.view.as_mut() else { return Ok(()); };
        if !view.loaded { return Ok(()); }
        let _guard = self.runtime.enter();
        self.runtime.block_on(view.page.run_autonomous_event_loop_turn())?;
        // Host navigation is explicit. Never turn a local privileged page into
        // an arbitrary remote document in response to a link or location write.
        let _blocked_navigation = view.page.take_pending_navigation();
        let calls = view.page.evaluate_with_timeout("globalThis.__weberDrain()", Duration::from_secs(2));
        if let Some(calls) = calls.as_array() {
            for call in calls {
                let Some(id) = call.get("call").and_then(Value::as_u64) else { continue; };
                let channel = call.get("channel").and_then(Value::as_str).unwrap_or("");
                let result = if !view.channels.contains(channel) { Some(Err("IPC channel denied".to_owned())) }
                    else if let Some(handler) = self.native.as_mut() { Some(handler(channel, call["payload"].clone())) }
                    else { None };
                if let Some(result) = result {
                    let reply = match result {
                        Ok(value) => json!({"call": id, "result": value}),
                        Err(error) => json!({"call": id, "error": error}),
                    };
                    view.page.evaluate_with_timeout(&format!("globalThis.__weberReply({reply})"), Duration::from_secs(2));
                } else {
                    output(json!({"event": "invoke", "window": 1, "epoch": view.epoch,
                        "call": id, "channel": channel, "payload": call["payload"]}));
                }
            }
        }
        if view.window.is_visible().unwrap_or(true) { view.window.request_redraw(); }
        Ok(())
    }

    fn paint(&mut self) -> Result<()> {
        let Some(view) = self.view.as_mut() else { return Ok(()); };
        let size = view.window.inner_size();
        let (Some(width), Some(height)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) else { return Ok(()); };
        // Bound allocations even during externally initiated window resizes.
        if u64::from(size.width) * u64::from(size.height) > 16_777_216 { return Err("Window exceeds pixel budget".into()); }
        view.surface.resize(width, height).map_err(|e| e.to_string())?;
        let mut buffer = view.surface.buffer_mut().map_err(|e| e.to_string())?;
        buffer.fill(0x00ff_ffff);
        if view.loaded {
            let logical = size.to_logical::<f32>(view.window.scale_factor());
            view.page.set_viewport((logical.width, logical.height));
            view.page.set_device_scale_factor(view.window.scale_factor() as f32);
            let _guard = self.runtime.enter();
            let png = view.page.screenshot((logical.width, logical.height)).ok_or("Obscura did not produce a frame")?;
            let rgba = image::load_from_memory_with_format(&png, image::ImageFormat::Png).map_err(|e| e.to_string())?.to_rgba8();
            // Normally dimensions match exactly. Fractional DPI may differ by
            // one pixel; resample explicitly instead of indexing out of bounds.
            for y in 0..size.height {
                for x in 0..size.width {
                    let pixel = rgba.get_pixel(
                        (u64::from(x) * u64::from(rgba.width()) / u64::from(size.width)) as u32,
                        (u64::from(y) * u64::from(rgba.height()) / u64::from(size.height)) as u32).0;
                    let a = u32::from(pixel[3]);
                    let blend = |c: u8| (u32::from(c) * a + 255 * (255 - a)) / 255;
                    buffer[(y * size.width + x) as usize] = (blend(pixel[0]) << 16) | (blend(pixel[1]) << 8) | blend(pixel[2]);
                }
            }
        }
        buffer.present().map_err(|e| e.to_string())
    }

    fn input(&mut self, value: Value) {
        if let Some(view) = self.view.as_mut().filter(|v| v.loaded) {
            let _guard = self.runtime.enter();
            view.page.evaluate_with_timeout(&format!("globalThis.__weberInput({value})"), Duration::from_secs(2));
        }
    }
}

impl ApplicationHandler<UserEvent> for Host {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.announced { return; }
        self.announced = true;
        if let Some((path, channels)) = self.startup.take() {
            let result = self.create(event_loop, &json!({"allowedChannels": channels})).and_then(|_| {
                self.command(event_loop, "window.loadFile", &json!({"window": 1, "path": path}))
            });
            if let Err(error) = result { self.fatal = Some(error); event_loop.exit(); }
        } else { self.emit(json!({"event": "ready", "protocol": 1})); }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Disconnected => event_loop.exit(),
            UserEvent::Request(request) => {
                let response = match self.command(event_loop, &request.method, &request.params) {
                    Ok(result) => json!({"id": request.id, "result": result}),
                    Err(error) => json!({"id": request.id, "error": error}),
                };
                self.emit(response);
                if let Some(ack) = &self.ack { let _ = ack.send(()); }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(view) = self.view.as_mut() else { return; };
        if view.window.id() != id { return; }
        match event {
            WindowEvent::CloseRequested => {
                self.view.take();
                self.emit(json!({"event": "closed", "window": 1}));
                if self.native.is_some() { event_loop.exit(); }
            }
            WindowEvent::RedrawRequested => {
                if let Err(error) = self.paint() { eprintln!("Weber paint: {error}"); }
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => view.window.request_redraw(),
            WindowEvent::CursorMoved { position, .. } => {
                let position = position.to_logical::<f64>(view.window.scale_factor());
                view.cursor = (position.x, position.y);
                self.input(json!({"type": "move", "x": position.x, "y": position.y}));
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                let (x, y) = view.cursor;
                self.input(json!({"type": if state == ElementState::Pressed { "down" } else { "up" }, "x": x, "y": y}));
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (x, y) = view.cursor;
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(dx, dy) => (-f64::from(dx) * 32.0, -f64::from(dy) * 32.0),
                    MouseScrollDelta::PixelDelta(pos) => (-pos.x / view.window.scale_factor(), -pos.y / view.window.scale_factor()),
                };
                self.input(json!({"type": "wheel", "x": x, "y": y, "dx": dx, "dy": dy}));
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let pressed = event.state == ElementState::Pressed;
                let key = match &event.logical_key {
                    Key::Character(text) => text.to_string(),
                    Key::Named(NamedKey::Backspace) => "Backspace".into(),
                    Key::Named(NamedKey::Enter) => "Enter".into(),
                    other => format!("{other:?}"),
                };
                self.input(json!({"type": "key", "key": key, "pressed": pressed}));
                if pressed {
                    if let Some(text) = event.text.filter(|t| !t.chars().any(char::is_control)) {
                        self.input(json!({"type": "text", "text": text.as_str()}));
                    }
                }
            }
            WindowEvent::Ime(Ime::Commit(text)) => self.input(json!({"type": "text", "text": text})),
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if Instant::now() >= self.next_tick {
            if let Err(error) = self.tick() { eprintln!("Weber event loop: {error}"); }
            self.next_tick = Instant::now() + TICK;
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(self.next_tick));
    }
}

fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| format!("Expected string: {key}"))
}
fn dimension(params: &Value, key: &str, default: u32) -> Result<u32> {
    match params.get(key) {
        None => Ok(default),
        Some(value) => match value.as_u64() {
            Some(n @ 1..=4096) => Ok(n as u32),
            _ => Err(format!("{key} must be an integer between 1 and 4096")),
        }
    }
}
