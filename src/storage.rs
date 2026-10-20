//! Small app-owned JSON stores. All filesystem work is serialized off the UI thread.
use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    thread::JoinHandle,
};

const MAX_VALUE: usize = 8192;
const MAX_STORE: u64 = 1_048_576;
const MAX_PENDING: usize = 32;
#[derive(Clone)]
struct Paths {
    config: PathBuf,
    data: PathBuf,
    cache: PathBuf,
}
impl Paths {
    fn new() -> Result<Self> {
        let dirs = directories_next::BaseDirs::new()
            .ok_or_else(|| anyhow!("Application directories unavailable"))?;
        let id = crate::assets::application()
            .map(|app| app.id().to_owned())
            .or_else(|| std::env::var("WEBER_APP_ID").ok())
            .unwrap_or_else(|| "dev.weber.demo".into());
        ensure!(
            !id.is_empty() && id.len() <= 200,
            "Invalid storage application identity"
        );
        Ok(Self::scoped(
            dirs.config_dir(),
            dirs.data_local_dir(),
            dirs.cache_dir(),
            &id,
        ))
    }
    fn scoped(config: &Path, data: &Path, cache: &Path, id: &str) -> Self {
        let suffix = PathBuf::from("weber")
            .join("apps")
            .join(format!("{:x}", Sha256::digest(id.as_bytes())));
        // macOS and custom XDG configurations may share base directories.
        Self {
            config: config.join(&suffix).join("config"),
            data: data.join(&suffix).join("data"),
            cache: cache.join(&suffix).join("cache"),
        }
    }
    fn json(&self) -> Value {
        json!({ "config": self.config, "data": self.data, "cache": self.cache })
    }
    fn directory(&self, area: &str) -> Result<&Path> {
        match area {
            "config" => Ok(&self.config),
            "data" => Ok(&self.data),
            _ => Err(anyhow!("Storage area must be config or data")),
        }
    }
}
struct Task {
    id: u64,
    request: Value,
}
struct Reply {
    id: u64,
    result: Result<Value, String>,
}
struct Pending {
    owner: u64,
    result: Option<Result<Value, String>>,
}
struct Worker {
    send: mpsc::SyncSender<Task>,
    receive: mpsc::Receiver<Reply>,
    pending: BTreeMap<u64, Pending>,
    next: u64,
    thread: JoinHandle<()>,
}
static WORKER: Mutex<Option<Worker>> = Mutex::new(None);
impl Worker {
    fn new() -> Result<Self> {
        let paths = Paths::new()?;
        let (send, tasks) = mpsc::sync_channel::<Task>(MAX_PENDING);
        let (replies, receive) = mpsc::sync_channel::<Reply>(MAX_PENDING);
        let thread = std::thread::Builder::new()
            .name("WeberStorage".into())
            .spawn(move || {
                for task in tasks {
                    let result = operate(&paths, &task.request).map_err(|error| error.to_string());
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
            pending: BTreeMap::new(),
            next: 1,
            thread,
        })
    }
    fn drain(&mut self) {
        while let Ok(reply) = self.receive.try_recv() {
            if let Some(pending) = self.pending.get_mut(&reply.id) {
                pending.result = Some(reply.result);
            }
        }
    }
}
pub fn submit(owner: u64, request: &Value) -> Result<Value> {
    validate(request)?;
    let mut slot = WORKER.lock().map_err(|_| anyhow!("Storage lock failed"))?;
    if slot.is_none() {
        *slot = Some(Worker::new()?);
    }
    let worker = slot
        .as_mut()
        .ok_or_else(|| anyhow!("Storage worker unavailable"))?;
    worker.drain();
    ensure!(
        worker.pending.len() < MAX_PENDING,
        "Storage request limit reached"
    );
    let id = worker.next;
    worker
        .send
        .try_send(Task {
            id,
            request: request.clone(),
        })
        .map_err(|_| anyhow!("Storage queue full or stopped"))?;
    worker.next += 1;
    worker.pending.insert(
        id,
        Pending {
            owner,
            result: None,
        },
    );
    Ok(json!({ "id": id }))
}
fn request_id(request: &Value) -> Result<u64> {
    request["requestId"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(|| anyhow!("Storage request id required"))
}
pub fn poll(owner: u64, request: &Value) -> Result<Value> {
    let id = request_id(request)?;
    let mut slot = WORKER.lock().map_err(|_| anyhow!("Storage lock failed"))?;
    let worker = slot
        .as_mut()
        .ok_or_else(|| anyhow!("Storage worker unavailable"))?;
    worker.drain();
    let pending = worker
        .pending
        .get(&id)
        .filter(|pending| pending.owner == owner)
        .ok_or_else(|| anyhow!("Unknown storage request"))?;
    if pending.result.is_none() {
        return Ok(json!({ "pending": true }));
    }
    let pending = worker
        .pending
        .remove(&id)
        .ok_or_else(|| anyhow!("Storage request disappeared"))?;
    match pending.result {
        Some(Ok(value)) => Ok(json!({ "pending": false, "value": value })),
        Some(Err(error)) => Err(anyhow!(error)),
        None => Err(anyhow!("Storage result unavailable")),
    }
}
pub fn cancel(owner: u64, request: &Value) -> Result<()> {
    let id = request_id(request)?;
    if let Some(worker) = WORKER
        .lock()
        .map_err(|_| anyhow!("Storage lock failed"))?
        .as_mut()
    {
        ensure!(
            worker.pending.get(&id).is_some_and(|p| p.owner == owner),
            "Unknown storage request"
        );
        worker.pending.remove(&id);
    }
    Ok(())
}
pub fn close_window(owner: u64) {
    if let Ok(mut slot) = WORKER.lock()
        && let Some(worker) = slot.as_mut()
    {
        worker.pending.retain(|_, p| p.owner != owner);
        worker.drain();
    }
}
pub fn shutdown() {
    let worker = WORKER.lock().ok().and_then(|mut slot| slot.take());
    if let Some(Worker {
        send,
        receive,
        thread,
        ..
    }) = worker
    {
        drop(send);
        drop(receive);
        let _ = thread.join();
    }
}
fn validate(request: &Value) -> Result<()> {
    let action = request["action"]
        .as_str()
        .ok_or_else(|| anyhow!("Storage action required"))?;
    ensure!(
        ["paths", "get", "set", "remove", "keys"].contains(&action),
        "Unknown storage action"
    );
    if action == "paths" {
        return Ok(());
    }
    ensure!(
        matches!(request["area"].as_str(), Some("config" | "data")),
        "Storage area must be config or data"
    );
    if action != "keys" {
        let key = request["key"]
            .as_str()
            .ok_or_else(|| anyhow!("Storage key required"))?;
        ensure!(
            !key.is_empty()
                && key.len() <= 96
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
            "Invalid storage key"
        );
    }
    if action == "set" {
        ensure!(
            request.get("value").is_some()
                && serde_json::to_vec(&request["value"])?.len() <= MAX_VALUE,
            "Storage value exceeds 8192 bytes"
        );
    }
    Ok(())
}
fn read_store(path: &Path) -> Result<BTreeMap<String, Value>> {
    if let Ok(info) = fs::symlink_metadata(path) {
        ensure!(info.is_file(), "Storage file must be a regular file");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= MAX_STORE,
        "Invalid or oversized storage file"
    );
    let mut bytes = Vec::new();
    file.take(MAX_STORE + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_STORE,
        "Storage file exceeds limit"
    );
    let store: BTreeMap<String, Value> = serde_json::from_slice(&bytes)?;
    ensure!(
        store.len() <= 128
            && store
                .values()
                .all(|v| serde_json::to_vec(v).is_ok_and(|bytes| bytes.len() <= MAX_VALUE)),
        "Invalid storage contents"
    );
    Ok(store)
}
fn write_store(directory: &Path, store: &BTreeMap<String, Value>) -> Result<()> {
    ensure!(store.len() <= 128, "Storage key limit reached");
    let bytes = serde_json::to_vec(store)?;
    ensure!(bytes.len() as u64 <= MAX_STORE, "Storage quota exceeded");
    fs::create_dir_all(directory)?;
    ensure!(
        fs::symlink_metadata(directory)?.is_dir(),
        "Storage directory must be a directory"
    );
    let temp = directory.join(format!(
        ".store-{}.tmp",
        crate::backend::random_capability()?
    ));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, directory.join("store.json"))?;
        // Atomic replacement; directory sync is best effort on platforms supporting it.
        if let Ok(dir) = fs::File::open(directory) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn operate(paths: &Paths, request: &Value) -> Result<Value> {
    validate(request)?;
    if request["action"] == "paths" {
        return Ok(paths.json());
    }
    let directory = paths.directory(request["area"].as_str().unwrap_or(""))?;
    let mut store = read_store(&directory.join("store.json"))?;
    let key = request["key"].as_str().unwrap_or("");
    match request["action"].as_str() {
        Some("get") => Ok(store.get(key).cloned().unwrap_or(Value::Null)),
        Some("keys") => Ok(json!(store.keys().collect::<Vec<_>>())),
        Some("set") => {
            store.insert(key.into(), request["value"].clone());
            write_store(directory, &store)?;
            Ok(Value::Null)
        }
        Some("remove") => {
            let removed = store.remove(key).is_some();
            if removed {
                write_store(directory, &store)?;
            }
            Ok(json!(removed))
        }
        _ => Err(anyhow!("Unknown storage action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coincident_os_bases_keep_areas_and_apps_separate() {
        let root = Path::new("shared-os-base");
        let first = Paths::scoped(root, root, root, "dev.weber.one");
        let second = Paths::scoped(root, root, root, "dev.weber.two");
        assert_ne!(first.config, first.data);
        assert_ne!(first.data, first.cache);
        assert_ne!(first.config, second.config);
    }
    #[test]
    fn persistence_and_bounds() -> Result<()> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let root = std::env::temp_dir().join(format!(
            "weber-store-{}",
            crate::backend::random_capability()?
        ));
        let paths = Paths {
            config: root.join("config"),
            data: root.join("data"),
            cache: root.join("cache"),
        };
        let result = (|| -> Result<()> {
            assert_eq!(
                operate(
                    &paths,
                    &json!({"action":"get","area":"config","key":"missing"})
                )?,
                Value::Null
            );
            operate(
                &paths,
                &json!({"action":"set","area":"config","key":"note","value":{"text":"한글","count":2}}),
            )?;
            assert_eq!(
                operate(
                    &paths,
                    &json!({"action":"get","area":"config","key":"note"})
                )?["text"],
                "한글"
            );
            assert_eq!(
                operate(&paths, &json!({"action":"get","area":"data","key":"note"}))?,
                Value::Null
            );
            assert!(
                operate(
                    &paths,
                    &json!({"action":"set","area":"config","key":"../escape","value":0})
                )
                .is_err()
            );
            assert!(operate(&paths, &json!({"action":"set","area":"config","key":"large","value":"x".repeat(MAX_VALUE)})).is_err());
            let too_many = (0..129)
                .map(|index| (format!("key{index}"), Value::Null))
                .collect();
            assert!(write_store(&paths.config, &too_many).is_err());
            assert_eq!(read_store(&paths.config.join("store.json"))?.len(), 1);
            #[cfg(unix)]
            {
                let link = paths.data.join("store.json");
                fs::create_dir_all(&paths.data)?;
                std::os::unix::fs::symlink(paths.config.join("store.json"), &link)?;
                assert!(read_store(&link).is_err());
                fs::remove_file(link)?;
            }
            fs::write(paths.config.join("store.json"), "malformed")?;
            assert!(
                operate(
                    &paths,
                    &json!({"action":"set","area":"config","key":"note","value":0})
                )
                .is_err()
            );
            assert_eq!(
                fs::read_to_string(paths.config.join("store.json"))?,
                "malformed"
            );
            Ok(())
        })();
        let _ = fs::remove_dir_all(root);
        result
    }
}
