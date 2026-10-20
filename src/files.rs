//! User-selected UTF-8 files, via the desktop portal. No application paths.
use anyhow::{Result, anyhow, ensure};
use futures_lite::{StreamExt, future};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    thread::JoinHandle,
    time::Duration,
};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as DbusValue};

pub const MAX_TEXT: usize = 262_144;
pub const MAX_PAYLOAD: usize = MAX_TEXT * 6 + 4096;
const MAX_PENDING: usize = 4;
const PORTAL: &str = "org.freedesktop.portal.Desktop";
struct Task {
    id: u64,
    request: Value,
    parent: String,
    cancel: async_channel::Receiver<()>,
}
struct Pending {
    owner: u64,
    cancel: async_channel::Sender<()>,
    result: Option<Result<Value, String>>,
}
struct Reply {
    id: u64,
    result: Result<Value, String>,
}
struct Worker {
    send: mpsc::SyncSender<Task>,
    receive: mpsc::Receiver<Reply>,
    thread: JoinHandle<()>,
    pending: BTreeMap<u64, Pending>,
    next: u64,
}
static WORKER: Mutex<Option<Worker>> = Mutex::new(None);
impl Worker {
    fn new() -> Result<Self> {
        let (send, tasks) = mpsc::sync_channel::<Task>(MAX_PENDING);
        let (replies, receive) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("WeberFiles".into())
            .spawn(move || {
                for task in tasks {
                    let result =
                        async_io::block_on(operate(&task)).map_err(|error| error.to_string());
                    if replies
                        .send(Reply {
                            id: task.id,
                            result,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })?;
        Ok(Self {
            send,
            receive,
            thread,
            pending: BTreeMap::new(),
            next: 1,
        })
    }
    fn drain(&mut self) {
        loop {
            match self.receive.try_recv() {
                Ok(reply) => {
                    if let Some(pending) = self.pending.get_mut(&reply.id) {
                        pending.result = Some(reply.result);
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    for pending in self.pending.values_mut().filter(|p| p.result.is_none()) {
                        pending.result = Some(Err("File worker stopped".into()));
                    }
                    break;
                }
            }
        }
    }
}
fn validate(request: &Value) -> Result<()> {
    match request["action"].as_str() {
        Some("open") => {}
        Some("save") => {
            ensure!(
                request["text"]
                    .as_str()
                    .is_some_and(|text| text.len() <= MAX_TEXT),
                "File text must be a string of at most 262144 UTF-8 bytes"
            );
            let name = request["name"]
                .as_str()
                .ok_or_else(|| anyhow!("Suggested file name required"))?;
            ensure!(
                !name.is_empty()
                    && name.len() <= 255
                    && !name.contains(['/', '\\', '\0'])
                    && !matches!(name, "." | ".."),
                "Invalid suggested file name"
            );
        }
        _ => return Err(anyhow!("Unknown file action")),
    }
    Ok(())
}
pub fn submit(owner: u64, request: &Value, parent: String) -> Result<Value> {
    validate(request)?;
    let mut slot = WORKER
        .lock()
        .map_err(|_| anyhow!("File worker lock failed"))?;
    if slot.is_none() {
        *slot = Some(Worker::new()?);
    }
    let worker = slot
        .as_mut()
        .ok_or_else(|| anyhow!("File worker unavailable"))?;
    worker.drain();
    ensure!(
        worker.pending.len() < MAX_PENDING,
        "File request limit reached"
    );
    let id = worker.next;
    worker.next += 1;
    let (cancel, receiver) = async_channel::bounded(1);
    worker
        .send
        .try_send(Task {
            id,
            request: request.clone(),
            parent,
            cancel: receiver,
        })
        .map_err(|_| anyhow!("File queue full or stopped"))?;
    worker.pending.insert(
        id,
        Pending {
            owner,
            cancel,
            result: None,
        },
    );
    Ok(json!({"id":id}))
}
fn request_id(request: &Value) -> Result<u64> {
    request["requestId"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(|| anyhow!("File request id required"))
}
pub fn poll(owner: u64, request: &Value) -> Result<Value> {
    let id = request_id(request)?;
    let mut slot = WORKER
        .lock()
        .map_err(|_| anyhow!("File worker lock failed"))?;
    let worker = slot
        .as_mut()
        .ok_or_else(|| anyhow!("File worker unavailable"))?;
    worker.drain();
    let pending = worker
        .pending
        .get(&id)
        .filter(|p| p.owner == owner)
        .ok_or_else(|| anyhow!("Unknown file request"))?;
    if pending.result.is_none() {
        return Ok(json!({"pending":true}));
    }
    let pending = worker
        .pending
        .remove(&id)
        .ok_or_else(|| anyhow!("File request disappeared"))?;
    match pending.result {
        Some(Ok(value)) => Ok(json!({"pending":false,"value":value})),
        Some(Err(error)) => Err(anyhow!(error)),
        None => Err(anyhow!("File result unavailable")),
    }
}
pub fn cancel(owner: u64, request: &Value) -> Result<()> {
    let id = request_id(request)?;
    let mut slot = WORKER
        .lock()
        .map_err(|_| anyhow!("File worker lock failed"))?;
    let worker = slot
        .as_mut()
        .ok_or_else(|| anyhow!("File worker unavailable"))?;
    ensure!(
        worker.pending.get(&id).is_some_and(|p| p.owner == owner),
        "Unknown file request"
    );
    if let Some(pending) = worker.pending.remove(&id) {
        let _ = pending.cancel.try_send(());
    }
    Ok(())
}
pub fn close_window(owner: u64) {
    if let Ok(mut slot) = WORKER.lock()
        && let Some(worker) = slot.as_mut()
    {
        worker.pending.retain(|_, pending| {
            if pending.owner == owner {
                let _ = pending.cancel.try_send(());
                false
            } else {
                true
            }
        });
        worker.drain();
    }
}
pub fn shutdown() {
    let worker = WORKER.lock().ok().and_then(|mut slot| slot.take());
    if let Some(worker) = worker {
        for pending in worker.pending.values() {
            let _ = pending.cancel.try_send(());
        }
        drop(worker.send);
        drop(worker.receive);
        let _ = worker.thread.join();
    }
}
async fn interrupted(cancel: &async_channel::Receiver<()>) -> Result<Option<PathBuf>> {
    future::race(
        async {
            let _ = cancel.recv().await;
            Err(anyhow!("File request cancelled"))
        },
        async {
            async_io::Timer::after(Duration::from_secs(120)).await;
            Err(anyhow!("File chooser timed out"))
        },
    )
    .await
}
async fn operate(task: &Task) -> Result<Value> {
    ensure!(task.cancel.try_recv().is_err(), "File request cancelled");
    let connection = future::race(
        async {
            Ok(zbus::connection::Builder::session()?
                .method_timeout(Duration::from_secs(3))
                .build()
                .await?)
        },
        async {
            async_io::Timer::after(Duration::from_secs(5)).await;
            Err(anyhow!("Desktop portal connection timed out"))
        },
    )
    .await?;
    let token = format!("weber_{}_{}", std::process::id(), task.id);
    let sender = connection
        .unique_name()
        .ok_or_else(|| anyhow!("Portal bus identity unavailable"))?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let handle = zbus::Proxy::new(
        &connection,
        PORTAL,
        path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .await?;
    let mut signals = handle.receive_signal("Response").await?;
    let save = task.request["action"] == "save";
    let portal = zbus::Proxy::new(
        &connection,
        PORTAL,
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.FileChooser",
    )
    .await?;
    let mut options = HashMap::from([
        ("handle_token", DbusValue::from(token.as_str())),
        ("multiple", DbusValue::from(false)),
        ("modal", DbusValue::from(true)),
    ]);
    if save {
        options.insert(
            "current_name",
            DbusValue::from(
                task.request["name"]
                    .as_str()
                    .ok_or_else(|| anyhow!("File name unavailable"))?,
            ),
        );
    }
    let chosen = future::race(
        async {
            let actual: OwnedObjectPath = portal
                .call(
                    if save { "SaveFile" } else { "OpenFile" },
                    &(
                        task.parent.as_str(),
                        if save {
                            "Save text file"
                        } else {
                            "Open text file"
                        },
                        options,
                    ),
                )
                .await?;
            if actual.as_str() != path {
                if let Ok(other) = zbus::Proxy::new(
                    &connection,
                    PORTAL,
                    actual.as_str(),
                    "org.freedesktop.portal.Request",
                )
                .await
                {
                    let _ = other.call_method("Close", &()).await;
                }
                return Err(anyhow!("Desktop portal did not honor the request token"));
            }
            let response = signals
                .next()
                .await
                .ok_or_else(|| anyhow!("Desktop portal disconnected"))?;
            let (code, mut values): (u32, HashMap<String, OwnedValue>) =
                response.body().deserialize()?;
            if code == 1 {
                return Ok(None);
            }
            ensure!(code == 0, "Desktop file chooser failed ({code})");
            let uris = Vec::<String>::try_from(
                values
                    .remove("uris")
                    .ok_or_else(|| anyhow!("Portal file URI missing"))?,
            )?;
            ensure!(uris.len() == 1, "Exactly one file must be selected");
            let url = url::Url::parse(&uris[0])?;
            ensure!(
                url.scheme() == "file" && url.host_str().is_none_or(|host| host == "localhost"),
                "Only local file URIs are supported"
            );
            Ok(Some(
                url.to_file_path()
                    .map_err(|_| anyhow!("Invalid local file URI"))?,
            ))
        },
        interrupted(&task.cancel),
    )
    .await;
    if chosen.is_err() {
        let _ = handle.call_method("Close", &()).await;
    }
    let Some(path) = chosen? else {
        return Ok(Value::Null);
    };
    ensure!(task.cancel.try_recv().is_err(), "File request cancelled");
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("Selected file name missing"))?
        .to_string_lossy();
    if save {
        replace_text(
            &path,
            task.request["text"]
                .as_str()
                .ok_or_else(|| anyhow!("File text unavailable"))?,
            task.id,
        )?;
        Ok(json!({"name":name}))
    } else {
        Ok(json!({"name":name,"text":read_text(&path)?}))
    }
}
fn read_text(path: &Path) -> Result<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    ensure!(
        file.metadata()?.is_file(),
        "Selected path is not a regular file"
    );
    let mut bytes = Vec::new();
    file.take(MAX_TEXT as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_TEXT, "File exceeds 262144 UTF-8 bytes");
    String::from_utf8(bytes).map_err(|_| anyhow!("File is not valid UTF-8"))
}
fn replace_text(path: &Path, text: &str, id: u64) -> Result<()> {
    ensure!(text.len() <= MAX_TEXT, "File exceeds 262144 UTF-8 bytes");
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("Selected file directory missing"))?;
    let previous = match fs::symlink_metadata(path) {
        Ok(meta) => {
            ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "Selected destination is not a regular file"
            );
            Some(meta.permissions())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let temporary = parent.join(format!(".weber-{}-{id}.tmp", std::process::id()));
    // Only remove a temporary file that this operation actually created.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| -> Result<()> {
        file.write_all(text.as_bytes())?;
        if let Some(mode) = previous {
            file.set_permissions(mode)?;
        }
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_validation_bounds_utf8_and_rejects_paths() {
        assert!(
            validate(&json!({"action":"save","text":"한".repeat(87381),"name":"note.txt"})).is_ok()
        );
        assert!(
            validate(&json!({"action":"save","text":"한".repeat(87382),"name":"note.txt"}))
                .is_err()
        );
        for name in ["../outside", "a/b", "a\\b", "\0", ".", ".."] {
            assert!(validate(&json!({"action":"save","text":"content","name":name})).is_err());
        }
    }
    #[test]
    fn utf8_limits_and_atomic_replacement() -> Result<()> {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("weber-file-unit-{}-{unique}", std::process::id()));
        fs::create_dir(&directory)?;
        let result = (|| -> Result<()> {
            let path = directory.join("note.txt");
            replace_text(&path, "한글 😀\nSecond line", 1)?;
            assert_eq!(read_text(&path)?, "한글 😀\nSecond line");
            assert!(replace_text(&path, &"x".repeat(MAX_TEXT + 1), 2).is_err());
            assert_eq!(read_text(&path)?, "한글 😀\nSecond line");
            fs::write(&path, [0xff])?;
            assert!(read_text(&path).is_err());
            fs::write(&path, vec![b'x'; MAX_TEXT + 1])?;
            assert!(read_text(&path).is_err());
            let link = directory.join("link");
            std::os::unix::fs::symlink(&path, &link)?;
            assert!(read_text(&link).is_err());
            assert!(replace_text(&link, "bad", 3).is_err());
            let collision = directory.join(format!(".weber-{}-4.tmp", std::process::id()));
            fs::write(&collision, "keep")?;
            assert!(replace_text(&path, "bad", 4).is_err());
            assert_eq!(fs::read_to_string(collision)?, "keep");
            Ok(())
        })();
        fs::remove_dir_all(directory)?;
        result
    }
}
