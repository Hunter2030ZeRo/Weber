//! A separate queue on winit's Wayland connection. No X11 or data-control access.
use super::{MAX_TEXT, Operation, Reply, ReplySender, Task};
use anyhow::{Result, anyhow, ensure};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::File,
    io::{Read, Write},
    os::{fd::AsFd, unix::net::UnixStream},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle, WEnum, delegate_noop, event_created_child,
    protocol::{
        wl_callback, wl_data_device, wl_data_device_manager, wl_data_offer, wl_data_source,
        wl_keyboard, wl_registry, wl_seat,
    },
};

const TIMEOUT: Duration = Duration::from_secs(3);
const MIME: [&str; 3] = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain"];
struct Seat {
    seat: wl_seat::WlSeat,
    keyboard: Option<wl_keyboard::WlKeyboard>,
    device: Option<wl_data_device::WlDataDevice>,
    selection: Option<wl_data_offer::WlDataOffer>,
    focused: bool,
    serial: u32,
}
impl Seat {
    fn release(self) {
        if let Some(keyboard) = self.keyboard
            && keyboard.version() >= 3
        {
            keyboard.release();
        }
        if let Some(device) = self.device
            && device.version() >= 2
        {
            device.release();
        }
        if self.seat.version() >= 5 {
            self.seat.release();
        }
    }
}
struct Offer {
    proxy: wl_data_offer::WlDataOffer,
    mime: Vec<String>,
}
enum TransferData {
    Read {
        id: u64,
        bytes: Vec<u8>,
    },
    Write {
        bytes: Arc<Vec<u8>>,
        position: usize,
    },
}
struct Transfer {
    file: File,
    data: TransferData,
    deadline: Instant,
}
struct State {
    initialized: bool,
    focus_ready: bool,
    focus_generation: u64,
    ready: Option<mpsc::SyncSender<()>>,
    manager: Option<wl_data_device_manager::WlDataDeviceManager>,
    seats: BTreeMap<u32, Seat>,
    active: Option<u32>,
    offers: BTreeMap<u32, Offer>,
    source: Option<wl_data_source::WlDataSource>,
    transfers: Vec<Transfer>,
    tasks: VecDeque<(Task, Instant)>,
    replies: ReplySender,
}
impl State {
    fn reply(&self, id: u64, result: Result<serde_json::Value>) {
        self.replies.send(Reply {
            id,
            result: result.map_err(|error| error.to_string()),
        });
    }
    fn ready(&self) -> bool {
        self.initialized
            && self.focus_ready
            && self
                .active
                .and_then(|id| self.seats.get(&id))
                .is_some_and(|s| s.focused && s.device.is_some() && s.serial != 0)
    }
    fn devices(&mut self, qh: &QueueHandle<Self>) {
        if let Some(manager) = &self.manager {
            for (id, seat) in &mut self.seats {
                if seat.device.is_none() {
                    seat.device = Some(manager.get_data_device(&seat.seat, qh, *id));
                }
            }
        }
    }
    fn operate(
        &mut self,
        task: &Task,
        qh: &QueueHandle<Self>,
    ) -> Result<Option<serde_json::Value>> {
        let seat = self
            .active
            .and_then(|id| self.seats.get(&id))
            .ok_or_else(|| anyhow!("Clipboard seat unavailable"))?;
        ensure!(seat.focused, "Clipboard requires keyboard focus");
        if matches!(task.operation, Operation::Clear) {
            // Clear selection ownership, rather than offering an empty source.
            // Servo sends Clear then Set for custom copy data. Some compositors
            // reject two non-null sources using the same input serial.
            seat.device
                .as_ref()
                .ok_or_else(|| anyhow!("Clipboard device unavailable"))?
                .set_selection(None, seat.serial);
            if let Some(old) = self.source.take() {
                old.destroy();
            }
            return Ok(Some(serde_json::Value::Null));
        }
        if let Operation::Write(text) = &task.operation {
            let manager = self
                .manager
                .as_ref()
                .ok_or_else(|| anyhow!("Wayland clipboard unavailable"))?;
            let source = manager.create_data_source(qh, Arc::new(text.as_bytes().to_vec()));
            for mime in MIME {
                source.offer(mime.into());
            }
            seat.device
                .as_ref()
                .ok_or_else(|| anyhow!("Clipboard device unavailable"))?
                .set_selection(Some(&source), seat.serial);
            if let Some(old) = self.source.replace(source) {
                old.destroy();
            }
            // Completion means the request has been sent to the compositor, not
            // that a future paste succeeded. Wayland has no selection-set ack.
            Ok(Some(serde_json::Value::Null))
        } else {
            let Some(selection) = &seat.selection else {
                return Ok(Some(serde_json::json!("")));
            };
            let offer = self
                .offers
                .get(&selection.id().protocol_id())
                .ok_or_else(|| anyhow!("Clipboard offer unavailable"))?;
            let mime = MIME
                .into_iter()
                .find(|mime| offer.mime.iter().any(|value| value == mime))
                .ok_or_else(|| anyhow!("Clipboard has no supported text format"))?;
            ensure!(
                self.transfers.len() < 32,
                "Clipboard transfer limit reached"
            );
            let (read, write) = rustix::pipe::pipe_with(
                rustix::pipe::PipeFlags::CLOEXEC | rustix::pipe::PipeFlags::NONBLOCK,
            )?;
            selection.receive(mime.into(), write.as_fd());
            drop(write);
            self.transfers.push(Transfer {
                file: File::from(read),
                data: TransferData::Read {
                    id: task.id,
                    bytes: Vec::new(),
                },
                deadline: Instant::now() + TIMEOUT,
            });
            Ok(None)
        }
    }
    fn io(&mut self) {
        let mut waiting = Vec::new();
        for mut transfer in std::mem::take(&mut self.transfers) {
            let result = advance(&mut transfer);
            match result {
                Ok(None) => waiting.push(transfer),
                result => {
                    if let TransferData::Read { id, .. } = transfer.data {
                        self.reply(
                            id,
                            result.and_then(|value| {
                                value.ok_or_else(|| anyhow!("Clipboard result missing"))
                            }),
                        );
                    }
                }
            }
        }
        self.transfers = waiting;
    }
}
fn advance(transfer: &mut Transfer) -> Result<Option<serde_json::Value>> {
    ensure!(
        Instant::now() < transfer.deadline,
        "Clipboard transfer timed out"
    );
    match &mut transfer.data {
        TransferData::Read { bytes, .. } => loop {
            let mut buffer = [0; 4096];
            match transfer.file.read(&mut buffer) {
                Ok(0) => {
                    return Ok(Some(serde_json::json!(String::from_utf8(std::mem::take(
                        bytes
                    ))?)));
                }
                Ok(size) => {
                    ensure!(
                        bytes.len() + size <= MAX_TEXT,
                        "Clipboard text exceeds 8192 UTF-8 bytes"
                    );
                    bytes.extend_from_slice(&buffer[..size]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        },
        TransferData::Write { bytes, position } => loop {
            if *position == bytes.len() {
                return Ok(Some(serde_json::Value::Null));
            }
            match transfer.file.write(&bytes[*position..]) {
                Ok(0) => return Err(anyhow!("Clipboard pipe closed")),
                Ok(size) => *position += size,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        },
    }
}
pub(super) fn run(
    connection: Connection,
    mut wake: UnixStream,
    tasks: mpsc::Receiver<Task>,
    replies: ReplySender,
    ready: mpsc::SyncSender<()>,
) -> Result<()> {
    let mut queue = connection.new_event_queue();
    let qh = queue.handle();
    connection.display().get_registry(&qh, ());
    connection.display().sync(&qh, (0_u8, 0_u64));
    let mut state = State {
        initialized: false,
        focus_ready: false,
        focus_generation: 0,
        ready: Some(ready),
        manager: None,
        seats: BTreeMap::new(),
        active: None,
        offers: BTreeMap::new(),
        source: None,
        transfers: Vec::new(),
        tasks: VecDeque::new(),
        replies,
    };
    loop {
        queue.dispatch_pending(&mut state)?;
        let mut saturated = true;
        for _ in 0..16 {
            match tasks.try_recv() {
                Ok(task) => {
                    if state.tasks.len() >= 16 {
                        state.reply(task.id, Err(anyhow!("Clipboard initialization queue full")));
                    } else {
                        state.tasks.push_back((task, Instant::now() + TIMEOUT));
                    }
                }
                Err(mpsc::TryRecvError::Empty) => {
                    saturated = false;
                    break;
                }
                Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
            }
        }
        while state
            .tasks
            .front()
            .is_some_and(|(_, deadline)| state.ready() || Instant::now() >= *deadline)
        {
            let Some((task, deadline)) = state.tasks.pop_front() else {
                break;
            };
            let result = if Instant::now() >= deadline {
                Err(anyhow!("Clipboard initialization or focus timed out"))
            } else {
                state.operate(&task, &qh)
            };
            match result {
                Ok(None) => {}
                Ok(Some(value)) => state.reply(task.id, Ok(value)),
                Err(error) => state.reply(task.id, Err(error)),
            }
        }
        state.io();
        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        connection.flush()?;
        let timeout = if saturated {
            Some(Timespec::default())
        } else {
            state
                .transfers
                .iter()
                .map(|t| t.deadline)
                .chain(state.tasks.iter().map(|(_, d)| *d))
                .min()
                .map(|deadline| {
                    Timespec::try_from(deadline.saturating_duration_since(Instant::now()))
                })
                .transpose()?
        };
        let mut fds = vec![
            PollFd::new(&connection, PollFlags::IN),
            PollFd::new(&wake, PollFlags::IN),
        ];
        fds.extend(state.transfers.iter().map(|t| {
            PollFd::new(
                &t.file,
                match t.data {
                    TransferData::Read { .. } => PollFlags::IN,
                    TransferData::Write { .. } => PollFlags::OUT,
                },
            )
        }));
        match poll(&mut fds, timeout.as_ref()) {
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => {
                drop(guard);
                continue;
            }
            Err(error) => return Err(error.into()),
        }
        let wayland = fds[0]
            .revents()
            .intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR);
        drop(fds);
        if wayland {
            match guard.read() {
                Ok(_) => {}
                Err(wayland_client::backend::WaylandError::Io(error))
                    if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.into()),
            }
        } else {
            drop(guard);
        }
        let mut buffer = [0; 64];
        while wake.read(&mut buffer).is_ok_and(|size| size > 0) {}
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
                name,
                interface,
                version,
            } if interface == "wl_data_device_manager" => {
                state.manager = Some(registry.bind(name, version.min(3), qh, ()));
                state.devices(qh);
            }
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } if interface == "wl_seat" && state.seats.len() < 8 => {
                state.seats.insert(
                    name,
                    Seat {
                        seat: registry.bind(name, version.min(7), qh, name),
                        keyboard: None,
                        device: None,
                        selection: None,
                        focused: false,
                        serial: 0,
                    },
                );
                state.devices(qh);
            }
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(seat) = state.seats.remove(&name) {
                    if let Some(offer) = &seat.selection {
                        state.offers.remove(&offer.id().protocol_id());
                        offer.destroy();
                    }
                    seat.release();
                }
                if state.active == Some(name) {
                    state.active = None;
                }
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_seat::WlSeat, u32> for State {
    fn event(
        state: &mut Self,
        proxy: &wl_seat::WlSeat,
        event: wl_seat::Event,
        id: &u32,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities {
            capabilities: WEnum::Value(capabilities),
        } = event
            && let Some(seat) = state.seats.get_mut(id)
        {
            if capabilities.contains(wl_seat::Capability::Keyboard) && seat.keyboard.is_none() {
                seat.keyboard = Some(proxy.get_keyboard(qh, *id));
            }
            if !capabilities.contains(wl_seat::Capability::Keyboard) {
                seat.focused = false;
                if let Some(keyboard) = seat.keyboard.take()
                    && keyboard.version() >= 3
                {
                    keyboard.release();
                }
            }
        }
    }
}
impl Dispatch<wl_keyboard::WlKeyboard, u32> for State {
    fn event(
        state: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        id: &u32,
        connection: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let Some(seat) = state.seats.get_mut(id) {
            match event {
                wl_keyboard::Event::Enter { serial, .. } => {
                    seat.focused = true;
                    seat.serial = serial;
                    state.active = Some(*id);
                    state.focus_generation += 1;
                    state.focus_ready = false;
                    // The keyboard enter can precede the new selection offer.
                    // Wait for the compositor's focus update to finish so a
                    // read cannot consume the previous focus's stale offer.
                    connection
                        .display()
                        .sync(qh, (3_u8, state.focus_generation));
                }
                wl_keyboard::Event::Leave { .. } => {
                    seat.focused = false;
                    seat.serial = 0;
                    state.focus_generation += 1;
                    state.focus_ready = false;
                }
                wl_keyboard::Event::Key { serial, .. }
                | wl_keyboard::Event::Modifiers { serial, .. } => seat.serial = serial,
                _ => {}
            }
        }
    }
}
impl Dispatch<wl_data_device::WlDataDevice, u32> for State {
    fn event(
        state: &mut Self,
        _: &wl_data_device::WlDataDevice,
        event: wl_data_device::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_data_device::Event::DataOffer { id: offer } => {
                if state.offers.len() >= 32 {
                    offer.destroy();
                    return;
                }
                state.offers.insert(
                    offer.id().protocol_id(),
                    Offer {
                        proxy: offer,
                        mime: Vec::new(),
                    },
                );
            }
            wl_data_device::Event::Selection { id: offer } => {
                if let Some(seat) = state.seats.get_mut(id) {
                    if let Some(old) = seat.selection.take() {
                        state.offers.remove(&old.id().protocol_id());
                        old.destroy();
                    }
                    seat.selection = offer;
                }
            }
            wl_data_device::Event::Enter {
                id: Some(offer), ..
            } => {
                state.offers.remove(&offer.id().protocol_id());
                offer.destroy();
            }
            _ => {}
        }
    }
    event_created_child!(State, wl_data_device::WlDataDevice, [0 => (wl_data_offer::WlDataOffer, ())]);
}
impl Dispatch<wl_data_offer::WlDataOffer, ()> for State {
    fn event(
        state: &mut Self,
        proxy: &wl_data_offer::WlDataOffer,
        event: wl_data_offer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_data_offer::Event::Offer { mime_type } = event
            && MIME.contains(&mime_type.as_str())
            && let Some(offer) = state.offers.get_mut(&proxy.id().protocol_id())
            && !offer.mime.contains(&mime_type)
        {
            offer.mime.push(mime_type);
        }
    }
}
impl Dispatch<wl_data_source::WlDataSource, Arc<Vec<u8>>> for State {
    fn event(
        state: &mut Self,
        proxy: &wl_data_source::WlDataSource,
        event: wl_data_source::Event,
        bytes: &Arc<Vec<u8>>,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_data_source::Event::Send { mime_type, fd }
                if MIME.contains(&mime_type.as_str()) && state.transfers.len() < 32 =>
            {
                if rustix::fs::fcntl_setfl(&fd, rustix::fs::OFlags::NONBLOCK).is_ok() {
                    state.transfers.push(Transfer {
                        file: File::from(fd),
                        data: TransferData::Write {
                            bytes: bytes.clone(),
                            position: 0,
                        },
                        deadline: Instant::now() + TIMEOUT,
                    });
                }
            }
            wl_data_source::Event::Cancelled if state.source.as_ref() == Some(proxy) => {
                state.source = None;
                proxy.destroy();
            }
            _ => {}
        }
    }
}
delegate_noop!(State: ignore wl_data_device_manager::WlDataDeviceManager);
impl Dispatch<wl_callback::WlCallback, (u8, u64)> for State {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        barrier: &(u8, u64),
        connection: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if barrier.0 < 2 {
            connection.display().sync(qh, (barrier.0 + 1, 0_u64));
        } else if barrier.0 == 2 {
            state.initialized = true;
            if let Some(ready) = state.ready.take() {
                let _ = ready.try_send(());
            }
        } else if barrier.1 == state.focus_generation {
            state.focus_ready = true;
        }
    }
}
impl Drop for State {
    fn drop(&mut self) {
        if let Some(source) = self.source.take() {
            source.destroy();
        }
        for (_, offer) in std::mem::take(&mut self.offers) {
            if offer.proxy.is_alive() {
                offer.proxy.destroy();
            }
        }
        for (_, seat) in std::mem::take(&mut self.seats) {
            seat.release();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read_transfer() -> Result<(Transfer, File)> {
        let (read, write) = rustix::pipe::pipe_with(
            rustix::pipe::PipeFlags::CLOEXEC | rustix::pipe::PipeFlags::NONBLOCK,
        )?;
        Ok((
            Transfer {
                file: File::from(read),
                data: TransferData::Read {
                    id: 1,
                    bytes: Vec::new(),
                },
                deadline: Instant::now() + TIMEOUT,
            },
            File::from(write),
        ))
    }
    #[test]
    fn bounded_nonblocking_reads_recover_and_expire() -> Result<()> {
        let (mut transfer, mut writer) = read_transfer()?;
        assert!(advance(&mut transfer)?.is_none());
        writer.write_all("한글 😀\n".as_bytes())?;
        drop(writer);
        assert_eq!(
            advance(&mut transfer)?,
            Some(serde_json::json!("한글 😀\n"))
        );
        let (mut transfer, mut writer) = read_transfer()?;
        writer.write_all(&vec![b'x'; 8192])?;
        assert!(advance(&mut transfer)?.is_none());
        writer.write_all(b"x")?;
        assert!(advance(&mut transfer).is_err());
        let (mut transfer, _writer) = read_transfer()?;
        transfer.deadline = Instant::now();
        assert!(advance(&mut transfer).is_err());
        let (mut transfer, mut writer) = read_transfer()?;
        writer.write_all(&[255])?;
        drop(writer);
        assert!(advance(&mut transfer).is_err());
        Ok(())
    }
}
