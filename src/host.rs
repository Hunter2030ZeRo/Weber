#[cfg(feature = "aot")]
use std::cell::RefCell;
use std::{cell::Cell, rc::Rc, sync::Arc};

use anyhow::{Result, anyhow};
use euclid::Scale;
use servo::{
    RenderingContext, Servo, ServoBuilder, WebView, WebViewBuilder, WebViewDelegate,
    WindowRenderingContext,
};
use url::Url;
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoopProxy},
    raw_window_handle::{HasDisplayHandle, HasWindowHandle},
    window::{Fullscreen, Window, WindowId},
};

use crate::input::Input;

#[derive(Debug)]
pub enum Wake {
    Servo,
    Exit(u64),
    Native,
    Backend,
    Clipboard,
}

#[derive(Clone)]
struct Waker(EventLoopProxy<Wake>);

impl servo::EventLoopWaker for Waker {
    fn clone_box(&self) -> Box<dyn servo::EventLoopWaker> {
        Box::new(self.clone())
    }
    fn wake(&self) {
        if let Err(error) = self.0.send_event(Wake::Servo) {
            log::debug!("event loop closed: {error}");
        }
    }
}

struct Delegate {
    window: Arc<Window>,
    id: u64,
    control: crate::native::Shared,
    #[cfg(feature = "aot")]
    runtime: RefCell<cxx::UniquePtr<crate::aot::ffi::Runtime>>,
    proxy: EventLoopProxy<Wake>,
    #[cfg(feature = "aot")]
    active: Cell<bool>,
    telemetry: Rc<crate::telemetry::Telemetry>,
    ime: Rc<Cell<bool>>,
}

struct Clipboard {
    window: Arc<Window>,
    id: u64,
    development_origin: Option<String>,
}
impl Clipboard {
    fn allowed(&self, webview: &WebView) -> bool {
        self.window.has_focus()
            && webview.url().is_some_and(|url| {
                url.scheme() == "weber-app"
                    || self
                        .development_origin
                        .as_ref()
                        .is_some_and(|origin| url.origin().ascii_serialization() == *origin)
            })
    }
}
impl servo::ClipboardDelegate for Clipboard {
    fn clear(&self, webview: WebView) {
        if self.allowed(&webview) {
            crate::clipboard::browser_clear(self.id);
        }
    }
    fn get_text(&self, webview: WebView, request: servo::StringRequest) {
        if self.allowed(&webview) {
            crate::clipboard::browser(self.id, None, Some(request));
        } else {
            request.failure("Clipboard requires a focused Weber application window".into());
        }
    }
    fn set_text(&self, webview: WebView, contents: String) {
        if self.allowed(&webview) {
            crate::clipboard::browser(self.id, Some(contents), None);
        } else {
            log::warn!("Clipboard requires a focused Weber application window");
        }
    }
    fn set_text_with_result(
        &self,
        webview: WebView,
        contents: String,
        request: servo::StringRequest,
    ) {
        if self.allowed(&webview) {
            crate::clipboard::browser(self.id, Some(contents), Some(request));
        } else {
            request.failure("Clipboard requires a focused Weber application window".into());
        }
    }
}

#[cfg(feature = "aot")]
thread_local! {
    static DOM_QUERY: RefCell<Option<servo::WeberDomQuery>> = const { RefCell::new(None) };
}

#[cfg(feature = "aot")]
pub fn dom_query(payload: &str) -> Result<String> {
    crate::dom::validate_query(payload)?;
    DOM_QUERY
        .with(|slot| {
            slot.borrow()
                .as_ref()
                .and_then(|query| query.query(payload.to_owned()))
        })
        .ok_or_else(|| anyhow!("No active Servo DOM query route or query failed"))
}

#[cfg(feature = "aot")]
pub fn dom_query_bytes(payload: &[u8]) -> Result<Vec<u8>> {
    crate::dom::validate_query_value(crate::wire::decode(payload)?)?;
    DOM_QUERY
        .with(|slot| {
            slot.borrow()
                .as_ref()
                .and_then(|query| query.query_bytes(payload.to_vec()))
        })
        .ok_or_else(|| anyhow!("No active Servo DOM bytes route or query failed"))
}

#[cfg(feature = "aot")]
pub fn dom_query_available() -> bool {
    DOM_QUERY.with(|slot| slot.borrow().is_some())
}

#[cfg(feature = "aot")]
struct QueryScope;
#[cfg(feature = "aot")]
impl Drop for QueryScope {
    fn drop(&mut self) {
        DOM_QUERY.with(|slot| {
            slot.borrow_mut().take();
        });
    }
}

impl Delegate {
    fn host_exchange(
        &self,
        payload: &[u8],
        query: servo::WeberDomQuery,
        binary: bool,
    ) -> Option<Vec<u8>> {
        let _native_scope = crate::native::Scope::enter(&self.control, self.id);
        if payload.len() > crate::files::MAX_PAYLOAD {
            return None;
        }
        let mut message: serde_json::Value = if binary {
            #[cfg(feature = "aot")]
            {
                crate::wire::decode(payload).ok()?
            }
            #[cfg(not(feature = "aot"))]
            {
                return None;
            }
        } else {
            serde_json::from_slice(payload).ok()?
        };
        if payload.len() > 65536
            && !(message["action"] == "native"
                && matches!(
                    message["request"]["op"].as_str(),
                    Some("files.start" | "clipboard.start" | "storage.start")
                ))
        {
            return None;
        }
        if message["action"] == "native" {
            if binary
                || crate::native::capability() != message["capability"].as_str()
                || message["capability"].as_str().is_none()
            {
                return Some(br#"{"ok":false,"error":{"name":"NativeAccessError","message":"Native capability rejected"}}"#.to_vec());
            }
            let reply =
                crate::native::exchange_value(&self.control, self.id, message["request"].take());
            return Some(reply.into_bytes());
        }
        if message["action"] == "backend" {
            if binary || !crate::backend::authorized(message["capability"].as_str().unwrap_or("")) {
                return Some(br#"{"ok":false,"error":{"name":"BackendAccessError","message":"Backend capability rejected"}}"#.to_vec());
            }
            return Some(crate::backend::exchange(&message["request"].to_string()).into_bytes());
        }
        if message["action"] == "telemetry" {
            if binary {
                return None;
            }
            if let Some(data) = message["data"].as_object_mut() {
                data.insert(
                    "hermesInitialized".to_owned(),
                    serde_json::Value::Bool(self.hermes_initialized()),
                );
                message["data"]["windowId"] = self.id.into();
                self.telemetry.report(message["data"].clone());
                return Some(b"{}".to_vec());
            }
            return None;
        }
        #[cfg(not(feature = "aot"))]
        {
            let _ = query;
            None
        }
        #[cfg(feature = "aot")]
        {
            let _scope = crate::native::Scope::enter(&self.control, self.id);
            self.aot_exchange(payload, query, message, binary)
        }
    }
    fn hermes_initialized(&self) -> bool {
        #[cfg(feature = "aot")]
        {
            self.runtime
                .try_borrow()
                .is_ok_and(|runtime| !runtime.is_null())
        }
        #[cfg(not(feature = "aot"))]
        {
            false
        }
    }
    #[cfg(feature = "aot")]
    fn aot_exchange(
        &self,
        payload: &[u8],
        query: servo::WeberDomQuery,
        message: serde_json::Value,
        binary: bool,
    ) -> Option<Vec<u8>> {
        if DOM_QUERY.with(|slot| slot.borrow().is_some()) {
            return None;
        }
        DOM_QUERY.with(|slot| {
            slot.replace(Some(query));
        });
        let _scope = QueryScope;
        // The script thread is waiting: only call Hermes and return data here.
        let result = self
            .runtime
            .try_borrow_mut()
            .map_err(|error| anyhow!("reentrant Hermes call: {error}"))
            .and_then(|mut runtime| {
                if runtime.is_null() {
                    *runtime = crate::aot::ffi::create_runtime()?;
                    if let Some(application) = crate::assets::application() {
                        runtime.pin_mut().load_application(
                            application
                                .unit_path
                                .as_ref()
                                .ok_or_else(|| anyhow!("Application has no native AOT unit"))?
                                .to_str()
                                .ok_or_else(|| anyhow!("Application path is not UTF-8"))?,
                            payload,
                            binary,
                        )?;
                    }
                }
                crate::dom::sync_exchange(&mut runtime, payload, message, binary)
            });
        match result {
            Ok((reply, active)) => {
                self.active.set(active);
                Some(reply)
            }
            Err(error) => {
                log::warn!("synchronous DOM call rejected: {error}");
                None
            }
        }
    }
}

impl WebViewDelegate for Delegate {
    fn show_console_message(&self, _: WebView, level: servo::ConsoleLogLevel, message: String) {
        eprintln!("[Weber console {level:?}] {message}");
    }

    fn weber_host_call(
        &self,
        _: WebView,
        payload: String,
        query: servo::WeberDomQuery,
    ) -> Option<String> {
        String::from_utf8(self.host_exchange(payload.as_bytes(), query, false)?).ok()
    }
    fn weber_host_bytes(
        &self,
        _: WebView,
        payload: Vec<u8>,
        query: servo::WeberDomQuery,
    ) -> Option<Vec<u8>> {
        self.host_exchange(&payload, query, true)
    }
    fn notify_new_frame_ready(&self, _: WebView) {
        self.telemetry.frame();
        self.window.request_redraw();
    }
    fn notify_page_title_changed(&self, _: WebView, title: Option<String>) {
        log::info!("page title: {}", title.as_deref().unwrap_or("Weber"));
        self.window.set_title(crate::native::bounded_title(
            title.as_deref().unwrap_or("Weber"),
        ));
        self.control
            .borrow_mut()
            .update(self.id, window_info(self.id, &self.window));
        self.control.borrow_mut().wake();
    }
    fn request_navigation(&self, webview: WebView, request: servo::NavigationRequest) {
        #[cfg(not(feature = "aot"))]
        let _ = &webview;
        let _native_scope = crate::native::Scope::enter(&self.control, self.id);
        if request.url.scheme() != "weber" {
            crate::backend::close_window(self.id);
            crate::storage::close_window(self.id);
            crate::clipboard::close_window(self.id);
            crate::files::close_window(self.id);
            self.control.borrow_mut().detach(self.id);
            #[cfg(feature = "aot")]
            if self.active.replace(false)
                && let Err(error) = self.runtime.borrow_mut().pin_mut().dom_dispose()
            {
                log::error!("DOM navigation cleanup: {error}");
            }
            return;
        }
        let action = request.url.host_str().unwrap_or("").to_owned();
        let url = request.url.clone();
        request.deny();
        if action == "telemetry" {
            if let Some((_, data)) = url.query_pairs().find(|(key, _)| key == "data")
                && data.len() <= 65536
                && let Ok(data) = serde_json::from_str(&data)
            {
                self.telemetry.report(data);
            }
            return;
        }
        #[cfg(feature = "aot")]
        if matches!(
            action.as_str(),
            "dom-start" | "dom-browser" | "dom-solid" | "increment"
        ) && self.runtime.borrow().is_null()
        {
            match crate::aot::ffi::create_runtime() {
                Ok(runtime) => *self.runtime.borrow_mut() = runtime,
                Err(error) => {
                    log::error!("Runtime initialization: {error}");
                    return;
                }
            }
        }
        match action.as_str() {
            #[cfg(feature = "aot")]
            "dom-profile" => {
                webview.evaluate_javascript(
                    format!(
                        "{}\nwindow.dispatchEvent(new Event('weber:profile-ready'))",
                        [include_str!("wire.js"), include_str!("dom_adapter.js")].join("\n")
                    ),
                    |result| {
                        if let Err(error) = result {
                            log::error!("Profile bootstrap failed: {error:?}");
                        }
                    },
                );
            }
            #[cfg(feature = "aot")]
            "dom-start" | "dom-browser" | "dom-solid" | "dom-event" | "dom-dispose" => {
                if action == "dom-start" || action == "dom-browser" || action == "dom-solid" {
                    self.active.set(true);
                }
                if action == "dom-dispose" {
                    self.active.set(false);
                }
                crate::dom::dispatch(&mut self.runtime.borrow_mut(), &webview, &url)
            }
            #[cfg(feature = "aot")]
            "increment" => match self.runtime.borrow_mut().pin_mut().increment(1) {
                Ok(value) => webview.evaluate_javascript(
                    format!(
                        "window.dispatchEvent(new CustomEvent('weber:aot', {{detail:{value}}}))"
                    ),
                    |result| {
                        if let Err(error) = result {
                            log::error!("DOM delivery failed: {error:?}");
                        }
                    },
                ),
                Err(error) => log::error!("AOT call failed: {error}"),
            },
            "close" => {
                if let Ok(path) = std::env::var("WEBER_SMOKE_CAPTURE") {
                    let proxy = self.proxy.clone();
                    let id = self.id;
                    webview.take_screenshot(None, move |result| {
                        match result {
                            Ok(image) => {
                                if let Err(error) = image.save(path) {
                                    log::error!("capture save: {error}");
                                }
                            }
                            Err(error) => log::error!("capture: {error:?}"),
                        }
                        if let Err(error) = proxy.send_event(Wake::Exit(id)) {
                            log::error!("close: {error}");
                        }
                    });
                    return;
                }
                if let Err(error) = self.proxy.send_event(Wake::Exit(self.id)) {
                    log::error!("close: {error}");
                }
            }
            _ => log::warn!("unsupported Weber action: {action}"),
        }
    }
    fn show_embedder_control(&self, _: WebView, control: servo::EmbedderControl) {
        if let servo::EmbedderControl::InputMethod(input) = control {
            self.ime.set(true);
            let rect = input.position();
            self.window.set_ime_cursor_area(
                winit::dpi::LogicalPosition::new(rect.min.x, rect.min.y),
                LogicalSize::new(rect.width(), rect.height()),
            );
            self.window.set_ime_allowed(true);
        }
    }
    fn hide_embedder_control(&self, _: WebView, _: servo::EmbedderControlId) {
        self.ime.set(false);
        self.window.set_ime_allowed(false);
    }
}

struct Running {
    webview: WebView,
    context: Rc<WindowRenderingContext>,
    // Drop the foreign export before the winit-owned surface.
    _portal_parent: Option<crate::portal_parent::Parent>,
    window: Arc<Window>,
    input: Input,
    telemetry: Rc<crate::telemetry::Telemetry>,
}

impl Running {
    fn create(
        event_loop: &ActiveEventLoop,
        url: Url,
        proxy: EventLoopProxy<Wake>,
        telemetry: Rc<crate::telemetry::Telemetry>,
        servo: &Servo,
        control: crate::native::Shared,
        spec: (
            u64,
            crate::native::Options,
            Option<&mut crate::portal_parent::Exporter>,
        ),
    ) -> Result<Self> {
        let (id, options, exporter) = spec;
        let window = Arc::new(
            event_loop.create_window(
                Window::default_attributes()
                    .with_title(&options.title)
                    .with_inner_size(LogicalSize::new(options.width, options.height)),
            )?,
        );
        let parent_started = std::time::Instant::now();
        let parent = exporter.and_then(|exporter| match exporter.export(&window) {
            Ok(parent) => parent,
            Err(error) => {
                log::warn!("Portal parent export unavailable: {error}");
                None
            }
        });
        telemetry.emit(serde_json::json!({"stage":"portal-parent", "windowId":id, "available":parent.is_some(), "elapsedMs":parent_started.elapsed().as_secs_f64()*1000.0}));
        let context = Rc::new(
            WindowRenderingContext::new(
                event_loop.display_handle()?,
                window.window_handle()?,
                window.inner_size(),
            )
            .map_err(|e| anyhow!("rendering context: {e:?}"))?,
        );
        context
            .make_current()
            .map_err(|e| anyhow!("make current: {e:?}"))?;
        control.borrow_mut().update(id, window_info(id, &window));
        if let Some(parent) = &parent {
            control
                .borrow_mut()
                .portal_parents
                .insert(id, parent.identifier.clone());
        }
        let ime_visible = Rc::new(Cell::new(false));
        let development_origin = (url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && std::env::var_os("WEBER_NATIVE_CAPABILITY").is_some())
        .then(|| url.origin().ascii_serialization());
        let webview = WebViewBuilder::new(servo, context.clone())
            .url(url)
            .clipboard_delegate(Rc::new(Clipboard {
                window: Arc::clone(&window),
                id,
                development_origin,
            }))
            .delegate(Rc::new(Delegate {
                window: Arc::clone(&window),
                id,
                control,
                #[cfg(feature = "aot")]
                runtime: RefCell::new(cxx::UniquePtr::null()),
                proxy,
                #[cfg(feature = "aot")]
                active: Cell::new(false),
                telemetry: telemetry.clone(),
                ime: ime_visible.clone(),
            }))
            .hidpi_scale_factor(scale(&window))
            .build();
        webview.resize(window.inner_size());
        webview.set_focused(window.has_focus());
        servo.spin_event_loop();
        Ok(Self {
            webview,
            context,
            _portal_parent: parent,
            window,
            input: Input::new(ime_visible),
            telemetry,
        })
    }

    fn handle(&mut self, event: WindowEvent) {
        match &event {
            WindowEvent::KeyboardInput { event, .. }
                if event.state == winit::event::ElementState::Pressed =>
            {
                self.telemetry.input("keyboard")
            }
            WindowEvent::MouseInput {
                state: winit::event::ElementState::Released,
                ..
            } => self.telemetry.input("mouse-release"),
            WindowEvent::Ime(_) => self.telemetry.input("ime"),
            _ => {}
        }
        match event {
            WindowEvent::RedrawRequested => {
                self.telemetry.measure("make-current", || {
                    let _ = self.context.make_current();
                });
                self.telemetry.measure("paint", || self.webview.paint());
                self.window.pre_present_notify();
                self.telemetry.measure("present", || self.context.present());
                self.telemetry.present();
            }
            WindowEvent::Resized(size) if size.width > 0 && size.height > 0 => {
                self.webview.resize(size);
                self.window.request_redraw();
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                self.webview.set_hidpi_scale_factor(scale(&self.window));
                self.webview.resize(self.window.inner_size());
            }
            WindowEvent::Focused(focused) => {
                self.telemetry
                    .emit(serde_json::json!({ "stage": "window-focus", "focused": focused }));
                self.webview.set_focused(focused);
            }
            other => self.input.forward(&self.webview, other),
        }
    }
}

fn scale(window: &Window) -> Scale<f32, servo::DeviceIndependentPixel, servo::DevicePixel> {
    // Winit's coordinate conversion explicitly handles the f64-to-f32 conversion.
    let size = winit::dpi::PhysicalSize::new(window.scale_factor(), 1.0).cast::<f32>();
    Scale::new(size.width)
}

fn window_info(id: u64, window: &Window) -> serde_json::Value {
    serde_json::json!({ "id": id, "state": "ready", "title": window.title(),
        "width": window.inner_size().width, "height": window.inner_size().height,
        "scaleFactor": window.scale_factor(), "focused": window.has_focus(),
        "maximized": window.is_maximized(), "fullscreen": window.fullscreen().is_some(),
        "resizable": window.is_resizable() })
}

pub struct App {
    // run_app consumes EventLoop. Keep its Wayland display alive until the
    // clipboard worker and its foreign proxies are joined/dropped in App::drop.
    _display: Option<winit::event_loop::OwnedDisplayHandle>,
    exporter: Option<crate::portal_parent::Exporter>,
    url: Url,
    proxy: EventLoopProxy<Wake>,
    servo: Option<Servo>,
    running: std::collections::HashMap<WindowId, (u64, Running)>,
    control: crate::native::Shared,
    failure: Option<anyhow::Error>,
    telemetry: Rc<crate::telemetry::Telemetry>,
    reclaimer: crate::memory::Reclaimer,
}
impl App {
    pub fn new(
        url: Url,
        proxy: EventLoopProxy<Wake>,
        started: std::time::Instant,
        control: crate::native::Shared,
    ) -> Self {
        control.borrow_mut().wake = Some(proxy.clone());
        crate::backend::set_waker(proxy.clone());
        Self {
            _display: None,
            exporter: None,
            url,
            proxy,
            servo: None,
            running: Default::default(),
            control,
            failure: None,
            telemetry: Rc::new(crate::telemetry::Telemetry::new(started)),
            reclaimer: crate::memory::Reclaimer::new(started),
        }
    }
    pub fn result(mut self) -> Result<()> {
        match self.failure.take() {
            Some(error) => Err(error),
            None => match self.telemetry.application_failure() {
                Some(error) => Err(anyhow!(error)),
                None => Ok(()),
            },
        }
    }
    fn open(
        &mut self,
        event_loop: &ActiveEventLoop,
        id: u64,
        options: crate::native::Options,
    ) -> Result<()> {
        let servo = self
            .servo
            .as_ref()
            .ok_or_else(|| anyhow!("Servo not initialized"))?;
        let running = Running::create(
            event_loop,
            self.url.clone(),
            self.proxy.clone(),
            self.telemetry.clone(),
            servo,
            self.control.clone(),
            (id, options, self.exporter.as_mut()),
        )?;
        self.control
            .borrow_mut()
            .update(id, window_info(id, &running.window));
        self.telemetry
            .emit(serde_json::json!({ "stage": "window-opened", "id": id }));
        self.running.insert(running.window.id(), (id, running));
        Ok(())
    }
    fn close(&mut self, id: u64, event_loop: &ActiveEventLoop) {
        if let Some(key) = self
            .running
            .iter()
            .find_map(|(key, (candidate, _))| (*candidate == id).then_some(*key))
        {
            crate::files::close_window(id);
            if let Some((_, running)) = self.running.remove(&key) {
                drop(running);
            }
            crate::backend::close_window(id);
            crate::storage::close_window(id);
            crate::clipboard::close_window(id);
            self.control.borrow_mut().remove(id);
            self.telemetry
                .emit(serde_json::json!({ "stage": "window-closed", "id": id }));
        }
        if self.running.is_empty() {
            self.telemetry.finish();
            self.servo.take();
            event_loop.exit();
        } else {
            self.reclaimer.schedule();
        }
    }
    fn request_close(&mut self, id: u64, event_loop: &ActiveEventLoop) {
        let decision = self.control.borrow_mut().request_close(id);
        if let Some(event) = decision {
            if event != serde_json::Value::Null
                && let Some((_, running)) = self
                    .running
                    .values()
                    .find(|(candidate, _)| *candidate == id)
            {
                running.webview.evaluate_javascript(
                    format!("globalThis.weberCloseRequested?.({event})"),
                    |result| {
                        if let Err(error) = result {
                            log::warn!(
                                "Close handler delivery failed; preserving window: {error:?}"
                            );
                        }
                    },
                );
            }
        } else {
            self.close(id, event_loop);
        }
    }
    fn commands(&mut self, event_loop: &ActiveEventLoop) {
        let commands = std::mem::take(&mut self.control.borrow_mut().commands);
        for command in commands {
            match command {
                crate::native::Command::Open {
                    id,
                    source,
                    options,
                } => {
                    let result = if self
                        .running
                        .values()
                        .any(|(candidate, _)| *candidate == source)
                    {
                        self.open(event_loop, id, options)
                    } else {
                        Err(anyhow!("Opening window already closed"))
                    };
                    if let Err(error) = result {
                        self.control.borrow_mut().update(id, serde_json::json!({ "id": id, "state": "failed", "error": error.to_string() }));
                    }
                }
                crate::native::Command::Close(id) => self.request_close(id, event_loop),
                crate::native::Command::CloseConfirmed(id) => self.close(id, event_loop),
                command => {
                    let id = match &command {
                        crate::native::Command::Title(id, _)
                        | crate::native::Command::Resize(id, _, _)
                        | crate::native::Command::Maximize(id, _)
                        | crate::native::Command::Fullscreen(id, _)
                        | crate::native::Command::Resizable(id, _) => *id,
                        _ => continue,
                    };
                    if let Some((_, running)) = self
                        .running
                        .values()
                        .find(|(candidate, _)| *candidate == id)
                    {
                        match command {
                            crate::native::Command::Title(_, title) => {
                                running.window.set_title(&title)
                            }
                            crate::native::Command::Resize(_, width, height) => {
                                if let Some(size) = running
                                    .window
                                    .request_inner_size(LogicalSize::new(width, height))
                                {
                                    running.webview.resize(size);
                                    running.window.request_redraw();
                                }
                            }
                            crate::native::Command::Maximize(_, value) => {
                                running.window.set_maximized(value)
                            }
                            crate::native::Command::Fullscreen(_, value) => running
                                .window
                                .set_fullscreen(value.then_some(Fullscreen::Borderless(None))),
                            crate::native::Command::Resizable(_, value) => {
                                running.window.set_resizable(value)
                            }
                            _ => {}
                        }
                        self.control
                            .borrow_mut()
                            .update(id, window_info(id, &running.window));
                    }
                }
            }
        }
    }
    fn deliver_window_state(&self) {
        let deliveries = self.control.borrow_mut().deliveries();
        for (owner, generation, snapshot) in deliveries {
            if let Some((_, running)) = self.running.values().find(|(id, _)| *id == owner) {
                let control = self.control.clone();
                running.webview.evaluate_javascript(format!("window.dispatchEvent(new CustomEvent('weber:window-state', {{detail:{snapshot}}}))"), move |result| {
                    control.borrow_mut().acknowledge(owner, generation, result.is_ok());
                });
            }
        }
    }
}
impl Drop for App {
    fn drop(&mut self) {
        crate::files::shutdown();
        self.running.clear();
        crate::storage::shutdown();
        crate::clipboard::shutdown();
        self.exporter.take();
        self.servo.take();
    }
}
impl ApplicationHandler<Wake> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.servo.is_some() {
            return;
        }
        self._display = Some(event_loop.owned_display_handle());
        if let Err(error) = event_loop
            .display_handle()
            .map_err(anyhow::Error::from)
            .and_then(|display| crate::clipboard::attach(display, self.proxy.clone()))
        {
            self.failure = Some(error);
            event_loop.exit();
            return;
        }
        let waker = Waker(self.proxy.clone());
        let servo = (|| -> Result<Servo> {
            Ok(ServoBuilder::default()
                .opts(servo::Opts {
                    time_profiling: std::env::var("WEBER_TIME_PROFILE")
                        .ok()
                        .map(servo::OutputOptions::FileName),
                    ..servo::Opts::default()
                })
                .preferences(servo::Preferences {
                    dom_composition_event_enabled: true,
                    layout_threads: std::env::var("WEBER_LAYOUT_THREADS")
                        .ok()
                        .and_then(|value| value.parse::<i64>().ok())
                        .filter(|count| (1..=16).contains(count))
                        .unwrap_or(3),
                    ..servo::Preferences::default()
                })
                .event_loop_waker(Box::new(waker.clone()))
                .protocol_registry({
                    let mut registry = servo::protocol_handler::ProtocolRegistry::default();
                    registry
                        .register(
                            "weber-app",
                            crate::assets::DesktopAssets {
                                benchmark: std::env::var("WEBER_BENCH").as_deref() == Ok("1"),
                            },
                        )
                        .map_err(|error| anyhow!("Desktop protocol: {error:?}"))?;
                    registry
                })
                .build())
        })();
        let servo = match servo {
            Ok(servo) => servo,
            Err(error) => {
                self.failure = Some(error);
                event_loop.exit();
                return;
            }
        };
        servo.setup_logging();
        // Register after the clipboard queue has initialized and Servo logging
        // is installed; an early failure must not silently disable all parents.
        let parent_started = std::time::Instant::now();
        self.exporter = event_loop.display_handle().ok().and_then(|display| {
            match crate::portal_parent::Exporter::new(display) {
                Ok(exporter) => Some(exporter),
                Err(error) => {
                    self.telemetry.emit(serde_json::json!({"stage":"portal-parent-initialization", "error":error.to_string()}));
                    log::warn!("Portal parenting unavailable: {error}");
                    None
                }
            }
        });
        self.telemetry.emit(serde_json::json!({"stage":"portal-parent-initialized", "available":self.exporter.is_some(), "elapsedMs":parent_started.elapsed().as_secs_f64()*1000.0}));
        self.servo = Some(servo);
        if let Err(error) = self.open(event_loop, 1, crate::native::Options::default()) {
            self.failure = Some(error);
            event_loop.exit();
        }
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Wake) {
        match event {
            Wake::Exit(id) => self.close(id, event_loop),
            Wake::Native => {
                self.control.borrow_mut().received_wake();
                self.commands(event_loop);
            }
            Wake::Backend => {
                for (owner, event) in crate::backend::take_events() {
                    if let Some((_, running)) = self.running.values().find(|(id, _)| *id == owner) {
                        running.webview.evaluate_javascript(format!("window.dispatchEvent(new CustomEvent('weber:backend-events', {{detail:[{}]}}))", event), move |result| { crate::backend::acknowledge(owner); if let Err(error) = result { log::warn!("Backend event delivery: {error:?}"); } });
                    }
                }
            }
            Wake::Clipboard => crate::clipboard::deliver_browser(),
            _ => {}
        }
        if let Some(servo) = &self.servo {
            self.telemetry.measure("spin", || servo.spin_event_loop());
        }
        self.commands(event_loop);
        self.deliver_window_state();
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, window: WindowId, event: WindowEvent) {
        if let Some((id, running)) = self.running.get_mut(&window) {
            let id = *id;
            if matches!(event, WindowEvent::CloseRequested) {
                self.request_close(id, event_loop);
            } else {
                let changed = matches!(
                    event,
                    WindowEvent::Resized(_)
                        | WindowEvent::ScaleFactorChanged { .. }
                        | WindowEvent::Focused(_)
                );
                running.handle(event);
                if changed {
                    self.control
                        .borrow_mut()
                        .update(id, window_info(id, &running.window));
                }
            }
        }
        if let Some(servo) = &self.servo {
            self.telemetry.measure("spin", || servo.spin_event_loop());
        }
        self.commands(event_loop);
        self.deliver_window_state();
    }
}
