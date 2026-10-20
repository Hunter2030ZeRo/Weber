//! Export native toplevels for out-of-process portal dialogs.
//! No permanent thread or idle timer. A bounded handshake runs at window creation.
use anyhow::{Result, anyhow, ensure};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, delegate_noop,
    protocol::{wl_callback, wl_registry, wl_surface},
};
use wayland_protocols::xdg::foreign::{
    zv1::client::{zxdg_exported_v1, zxdg_exporter_v1},
    zv2::client::{zxdg_exported_v2, zxdg_exporter_v2},
};
use winit::raw_window_handle::{DisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};

type Handle = Arc<Mutex<Option<String>>>;
#[derive(Default)]
struct State {
    initialized: bool,
    v1: Option<(u32, zxdg_exporter_v1::ZxdgExporterV1)>,
    v2: Option<(u32, zxdg_exporter_v2::ZxdgExporterV2)>,
}
pub struct Exporter {
    connection: Connection,
    queue: EventQueue<State>,
    state: State,
}
impl Drop for Exporter {
    fn drop(&mut self) {
        // Send destructors while this queue's foreign backend still exists.
        if let Some((_, proxy)) = self.state.v1.take() {
            proxy.destroy();
        }
        if let Some((_, proxy)) = self.state.v2.take() {
            proxy.destroy();
        }
        let _ = self.connection.flush();
    }
}
enum Export {
    V1(zxdg_exported_v1::ZxdgExportedV1),
    V2(zxdg_exported_v2::ZxdgExportedV2),
}
pub struct Parent {
    export: Export,
    connection: Connection,
    pub identifier: String,
}
impl Drop for Parent {
    fn drop(&mut self) {
        match &self.export {
            Export::V1(proxy) => proxy.destroy(),
            Export::V2(proxy) => proxy.destroy(),
        }
        let _ = self.connection.flush();
    }
}
impl Drop for State {
    fn drop(&mut self) {
        if let Some((_, proxy)) = self.v1.take() {
            proxy.destroy();
        }
        if let Some((_, proxy)) = self.v2.take() {
            proxy.destroy();
        }
    }
}
impl Exporter {
    /// App's OwnedDisplayHandle outlives this exporter and every Parent.
    #[expect(
        unsafe_code,
        reason = "App owns the foreign display until all exports and queues are dropped"
    )]
    pub fn new(display: DisplayHandle<'_>) -> Result<Self> {
        let RawDisplayHandle::Wayland(display) = display.as_raw() else {
            return Err(anyhow!("Wayland display required for portal parenting"));
        };
        // SAFETY: App drops running windows/exports and this exporter before its
        // OwnedDisplayHandle, including when run_app consumes the event loop.
        let backend = unsafe {
            wayland_client::backend::Backend::from_foreign_display(display.display.as_ptr().cast())
        };
        let connection = Connection::from_backend(backend);
        let queue = connection.new_event_queue();
        let qh = queue.handle();
        let _registry = connection.display().get_registry(&qh, ());
        connection.display().sync(&qh, ());
        let mut result = Self {
            connection,
            queue,
            state: State::default(),
        };
        result.pump(Duration::from_secs(3), |state| state.initialized)?;
        Ok(result)
    }
    fn pump(&mut self, timeout: Duration, ready: impl Fn(&State) -> bool) -> Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            self.queue.dispatch_pending(&mut self.state)?;
            self.connection.flush()?;
            if ready(&self.state) {
                return Ok(());
            }
            ensure!(Instant::now() < deadline, "Wayland parent export timed out");
            let Some(guard) = self.queue.prepare_read() else {
                continue;
            };
            let timeout = Timespec::try_from(deadline.saturating_duration_since(Instant::now()))?;
            let mut fds = [PollFd::new(&self.connection, PollFlags::IN)];
            match poll(&mut fds, Some(&timeout)) {
                Err(rustix::io::Errno::INTR) => continue,
                Err(error) => return Err(error.into()),
                Ok(0) => return Err(anyhow!("Wayland parent export timed out")),
                Ok(_) => {}
            }
            match guard.read() {
                Ok(_) => {}
                Err(wayland_client::backend::WaylandError::Io(error))
                    if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    /// The borrowed surface must remain alive until Parent is dropped. Running
    /// stores Parent before its Window field and drops the export first.
    #[expect(
        unsafe_code,
        reason = "The borrowed winit surface is valid and is never destroyed by this module"
    )]
    pub fn export(&mut self, window: &winit::window::Window) -> Result<Option<Parent>> {
        self.queue.dispatch_pending(&mut self.state)?;
        if self.state.v1.is_none() && self.state.v2.is_none() {
            return Ok(None);
        }
        let RawWindowHandle::Wayland(raw) = window.window_handle()?.as_raw() else {
            return Ok(None);
        };
        // SAFETY: raw comes directly from the live winit Window, on the same
        // display used by this exporter. Only export_toplevel borrows it; the
        // resulting proxy's destructor never destroys the winit-owned surface.
        let id = unsafe {
            wayland_client::backend::ObjectId::from_ptr(
                wl_surface::WlSurface::interface(),
                raw.surface.as_ptr().cast(),
            )
        }?;
        let surface = wl_surface::WlSurface::from_id(&self.connection, id)?;
        let handle = Handle::default();
        let export = if let Some((_, proxy)) = &self.state.v2 {
            Export::V2(proxy.export_toplevel(&surface, &self.queue.handle(), handle.clone()))
        } else if let Some((_, proxy)) = &self.state.v1 {
            Export::V1(proxy.export(&surface, &self.queue.handle(), handle.clone()))
        } else {
            return Ok(None);
        };
        let mut parent = Parent {
            export,
            connection: self.connection.clone(),
            identifier: String::new(),
        };
        self.pump(Duration::from_millis(400), |_| {
            handle.lock().is_ok_and(|value| value.is_some())
        })?;
        let token = handle
            .lock()
            .map_err(|_| anyhow!("Parent handle lock failed"))?
            .take()
            .ok_or_else(|| anyhow!("Parent handle missing"))?;
        ensure!(
            !token.is_empty() && token.len() <= 4096 && !token.contains('\0'),
            "Invalid Wayland parent handle"
        );
        parent.identifier = format!("wayland:{token}");
        Ok(Some(parent))
    }
}
impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name, interface, ..
            } if interface == "zxdg_exporter_v2" && state.v2.is_none() => {
                state.v2 = Some((name, registry.bind(name, 1, qh, ())))
            }
            wl_registry::Event::Global {
                name, interface, ..
            } if interface == "zxdg_exporter_v1" && state.v1.is_none() => {
                state.v1 = Some((name, registry.bind(name, 1, qh, ())))
            }
            wl_registry::Event::GlobalRemove { name } => {
                if state.v1.as_ref().is_some_and(|(id, _)| *id == name)
                    && let Some((_, proxy)) = state.v1.take()
                {
                    proxy.destroy();
                }
                if state.v2.as_ref().is_some_and(|(id, _)| *id == name)
                    && let Some((_, proxy)) = state.v2.take()
                {
                    proxy.destroy();
                }
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_callback::WlCallback, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.initialized = true;
    }
}
macro_rules! exported {
    ($module:ident, $proxy:ident) => {
        impl Dispatch<$module::$proxy, Handle> for State {
            fn event(
                _: &mut Self,
                _: &$module::$proxy,
                event: $module::Event,
                handle: &Handle,
                _: &Connection,
                _: &QueueHandle<Self>,
            ) {
                if let $module::Event::Handle { handle: token } = event
                    && let Ok(mut handle) = handle.lock()
                {
                    *handle = Some(token);
                }
            }
        }
    };
}
exported!(zxdg_exported_v1, ZxdgExportedV1);
exported!(zxdg_exported_v2, ZxdgExportedV2);
delegate_noop!(State: ignore zxdg_exporter_v1::ZxdgExporterV1);
delegate_noop!(State: ignore zxdg_exporter_v2::ZxdgExporterV2);
