//! First layer-shell renderer slice. Deliberately separate from the window SDK.
//! No keyboard/IME, multi-output policy or AOT support is claimed by this probe.
use anyhow::{Result, anyhow, ensure};
use calloop::{EventLoop, channel};
use calloop_wayland_source::WaylandSource;
use servo::{
    RenderingContext, Servo, ServoBuilder, WebView, WebViewBuilder, WebViewDelegate,
    WindowRenderingContext,
};
use std::{
    cell::Cell,
    ptr::NonNull,
    rc::Rc,
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle, delegate_noop,
    globals::{GlobalListContents, registry_queue_init},
    protocol::{wl_callback, wl_compositor, wl_registry, wl_surface},
};
use wayland_protocols_wlr::layer_shell::v1::client::{
    zwlr_layer_shell_v1 as shell, zwlr_layer_surface_v1 as layer,
};
use winit::{
    dpi::PhysicalSize,
    raw_window_handle::{
        DisplayHandle, RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle,
        WaylandWindowHandle, WindowHandle,
    },
};

#[derive(Debug)]
enum Wake {
    Servo,
    Frame,
    Title(String),
    Captured(Result<(), String>),
}
#[derive(Clone)]
struct Waker(channel::Sender<Wake>);
impl servo::EventLoopWaker for Waker {
    fn clone_box(&self) -> Box<dyn servo::EventLoopWaker> {
        Box::new(self.clone())
    }
    fn wake(&self) {
        let _ = self.0.send(Wake::Servo);
    }
}
struct Delegate {
    sender: channel::Sender<Wake>,
    frame: Cell<bool>,
}
impl WebViewDelegate for Delegate {
    fn notify_new_frame_ready(&self, _: WebView) {
        self.frame.set(true);
        let _ = self.sender.send(Wake::Frame);
    }
    fn notify_page_title_changed(&self, _: WebView, title: Option<String>) {
        let _ = self.sender.send(Wake::Title(title.unwrap_or_default()));
    }
    fn show_console_message(&self, _: WebView, level: servo::ConsoleLogLevel, message: String) {
        eprintln!("[Layer {level:?}] {message}");
    }
}
struct State {
    view: Option<WebView>,
    servo: Option<Servo>,
    context: Option<Rc<WindowRenderingContext>>,
    delegate: Rc<Delegate>,
    layer: layer::ZwlrLayerSurfaceV1,
    surface: wl_surface::WlSurface,
    configured: Option<(u32, u32)>,
    frames: u64,
    passed: bool,
    capturing: bool,
    closed: bool,
    captured: Option<Result<(), String>>,
    queue: QueueHandle<Self>,
    url: url::Url,
    connection: Connection,
    sender: channel::Sender<Wake>,
}
impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<layer::ZwlrLayerSurfaceV1, ()> for State {
    fn event(
        state: &mut Self,
        layer: &layer::ZwlrLayerSurfaceV1,
        event: layer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            layer::Event::Configure {
                serial,
                width,
                height,
            } => {
                layer.ack_configure(serial);
                state.configured = Some((
                    if width == 0 { 960 } else { width },
                    if height == 0 { 48 } else { height },
                ));
            }
            layer::Event::Closed => state.closed = true,
            _ => {}
        }
    }
}
impl Dispatch<wl_callback::WlCallback, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        event: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if matches!(event, wl_callback::Event::Done { .. }) {
            state.frames += 1;
            println!(
                "{}",
                serde_json::json!({ "stage": "layer-frame", "frames": state.frames })
            );
        }
    }
}
delegate_noop!(State: ignore wl_compositor::WlCompositor);
delegate_noop!(State: ignore wl_surface::WlSurface);
delegate_noop!(State: ignore shell::ZwlrLayerShellV1);

// The connection and role-bearing surface stay alive until AFTER Servo's view
// and GPU context are destroyed. These handles describe that exact live surface.
#[expect(
    unsafe_code,
    reason = "Borrow live owned Wayland objects for Servo's checked raw-handle API"
)]
fn context(
    connection: &Connection,
    surface: &wl_surface::WlSurface,
    size: PhysicalSize<u32>,
) -> Result<Rc<WindowRenderingContext>> {
    let display = NonNull::new(connection.backend().display_ptr().cast())
        .ok_or_else(|| anyhow!("Wayland display pointer missing"))?;
    let surface = NonNull::new(surface.id().as_ptr().cast())
        .ok_or_else(|| anyhow!("Wayland surface pointer missing"))?;
    let raw_display = RawDisplayHandle::Wayland(WaylandDisplayHandle::new(display));
    let raw_window = RawWindowHandle::Wayland(WaylandWindowHandle::new(surface));
    let context = unsafe {
        WindowRenderingContext::new(
            DisplayHandle::borrow_raw(raw_display),
            WindowHandle::borrow_raw(raw_window),
            size,
        )
    }
    .map_err(|error| anyhow!("Layer rendering context: {error:?}"))?;
    Ok(Rc::new(context))
}
impl State {
    fn pump(&mut self) -> Result<()> {
        if let Some((width, height)) = self.configured.take() {
            let size = PhysicalSize::new(width, height);
            if let Some(view) = &self.view {
                view.resize(size);
            } else {
                let context = context(&self.connection, &self.surface, size)?;
                context
                    .make_current()
                    .map_err(|error| anyhow!("Layer make current: {error:?}"))?;
                let servo = ServoBuilder::default()
                    .event_loop_waker(Box::new(Waker(self.sender.clone())))
                    .build();
                servo.setup_logging();
                let view = WebViewBuilder::new(&servo, context.clone())
                    .url(self.url.clone())
                    .delegate(self.delegate.clone())
                    .build();
                view.resize(size);
                self.context = Some(context);
                self.view = Some(view);
                self.servo = Some(servo);
            }
            println!(
                "{}",
                serde_json::json!({ "stage": "layer-configured", "width": width, "height": height, "exclusiveZone": 48 })
            );
        }
        if let Some(servo) = &self.servo {
            servo.spin_event_loop();
        }
        if self.delegate.frame.replace(false)
            && let (Some(view), Some(context)) = (&self.view, &self.context)
        {
            context
                .make_current()
                .map_err(|error| anyhow!("Layer make current: {error:?}"))?;
            view.paint();
            let _ = self.surface.frame(&self.queue, ());
            context.present();
        }
        if self.passed
            && self.frames > 0
            && !self.capturing
            && let Some(view) = &self.view
        {
            self.capturing = true;
            let sender = self.sender.clone();
            let path = std::env::var("WEBER_LAYER_CAPTURE")
                .unwrap_or_else(|_| "artifacts/layer-probe.png".into());
            view.take_screenshot(None, move |result| {
                let result = result
                    .map_err(|error| format!("{error:?}"))
                    .and_then(|image| image.save(path).map_err(|error| error.to_string()));
                let _ = sender.send(Wake::Captured(result));
            });
        }
        self.connection.flush()?;
        Ok(())
    }
}
impl Drop for State {
    fn drop(&mut self) {
        self.view.take();
        self.servo.take();
        self.context.take();
        self.layer.destroy();
        self.surface.destroy();
        let _ = self.connection.flush();
    }
}
pub fn run(url: String) -> Result<()> {
    let url = url::Url::parse(&url)?;
    ensure!(
        matches!(url.scheme(), "file" | "http" | "https"),
        "Unsupported layer probe URL"
    );
    let connection = Connection::connect_to_env()?;
    let (globals, queue) = registry_queue_init::<State>(&connection)?;
    let qh = queue.handle();
    let compositor: wl_compositor::WlCompositor = globals.bind(&qh, 1..=4, ())?;
    let shell: shell::ZwlrLayerShellV1 = globals
        .bind(&qh, 1..=4, ())
        .map_err(|_| anyhow!("Compositor does not support wlr-layer-shell"))?;
    let surface = compositor.create_surface(&qh, ());
    let layer = shell.get_layer_surface(
        &surface,
        None,
        shell::Layer::Top,
        "weber-layer-probe".into(),
        &qh,
        (),
    );
    layer.set_anchor(layer::Anchor::Top | layer::Anchor::Left | layer::Anchor::Right);
    layer.set_size(0, 48);
    layer.set_exclusive_zone(48);
    layer.set_keyboard_interactivity(layer::KeyboardInteractivity::None);
    surface.commit();
    let mut event_loop: EventLoop<State> = EventLoop::try_new()?;
    WaylandSource::new(connection.clone(), queue)
        .insert(event_loop.handle())
        .map_err(|error| anyhow!("Layer event source: {error}"))?;
    let (sender, receiver) = channel::channel();
    event_loop
        .handle()
        .insert_source(receiver, |event, _, state| {
            if let channel::Event::Msg(event) = event {
                match event {
                    Wake::Title(title) => {
                        state.passed = title == "weber-layer-pass";
                        println!(
                            "{}",
                            serde_json::json!({ "stage": "layer-title", "title": title })
                        );
                    }
                    Wake::Captured(result) => state.captured = Some(result),
                    Wake::Frame | Wake::Servo => {}
                }
            }
        })
        .map_err(|error| anyhow!("Layer wake source: {error}"))?;
    let mut state = State {
        view: None,
        servo: None,
        context: None,
        delegate: Rc::new(Delegate {
            sender: sender.clone(),
            frame: Cell::new(false),
        }),
        layer,
        surface,
        configured: None,
        frames: 0,
        passed: false,
        capturing: false,
        closed: false,
        captured: None,
        queue: qh,
        url,
        connection,
        sender,
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let timeout = deadline.saturating_duration_since(Instant::now());
        ensure!(
            !timeout.is_zero(),
            "Layer probe timed out before DOM/frame/capture proof"
        );
        event_loop.dispatch(Some(timeout), &mut state)?;
        state.pump()?;
        if let Some(result) = state.captured.take() {
            result.map_err(anyhow::Error::msg)?;
            println!(
                "{}",
                serde_json::json!({ "stage": "layer-passed", "frames": state.frames })
            );
            return Ok(());
        }
        ensure!(
            !state.closed,
            "Compositor closed the probe before completion"
        );
    }
}
