//! Bounded desktop integration. Separate lazy URI/notification workers keep a
//! portal confirmation from blocking notifications. Neither polls while idle.
use anyhow::{Result, anyhow, ensure};
use futures_lite::{StreamExt, future};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::Duration,
};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as DbusValue};

const LIMIT: usize = 8;
const PORTAL: &str = "org.freedesktop.portal.Desktop";
struct Cancellation {
    send: async_channel::Sender<()>,
    receive: async_channel::Receiver<()>,
}
struct Task {
    id: u64,
    owner: u64,
    alive: Arc<AtomicBool>,
    cancel: Arc<Cancellation>,
    request: Value,
    parent: String,
}
enum Message {
    Task(Task),
    Changed,
}
struct Pending {
    owner: u64,
    cancel: Arc<Cancellation>,
    result: Option<Result<Value, String>>,
}
struct Notification {
    owner: u64,
    alive: Arc<AtomicBool>,
    cancel: Arc<Cancellation>,
    server: u32,
    expires: std::time::Instant,
}
struct Worker {
    send: mpsc::SyncSender<Message>,
    receive: mpsc::Receiver<(u64, Result<Value, String>)>,
    thread: JoinHandle<()>,
    pending: BTreeMap<u64, Pending>,
    owners: BTreeMap<u64, Arc<AtomicBool>>,
}
static WORKERS: Mutex<[Option<Worker>; 2]> = Mutex::new([None, None]);
static NEXT: AtomicU64 = AtomicU64::new(1);

fn validate(request: &Value) -> Result<usize> {
    match request["action"].as_str() {
        Some("open") => {
            ensure!(
                request.get("ask").is_none_or(|v| v.is_boolean()),
                "URL chooser ask must be boolean"
            );
            let text = request["url"]
                .as_str()
                .ok_or_else(|| anyhow!("URL required"))?;
            ensure!(
                text.len() <= 8192 && !text.chars().any(char::is_control),
                "Invalid URL"
            );
            let url = url::Url::parse(text)?;
            ensure!(
                matches!(url.scheme(), "http" | "https" | "mailto"),
                "Only http, https and mailto URLs are allowed"
            );
            ensure!(
                url.username().is_empty() && url.password().is_none(),
                "URL credentials are not allowed"
            );
            ensure!(
                url.scheme() == "mailto" || url.host_str().is_some(),
                "URL host required"
            );
            ensure!(
                url.scheme() != "mailto" || !url.path().is_empty(),
                "Mail recipient required"
            );
            Ok(0)
        }
        Some("notify") => {
            ensure!(
                request["title"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 256 && !s.contains('\0')),
                "Notification title must be 1..256 UTF-8 bytes"
            );
            ensure!(
                request["body"]
                    .as_str()
                    .is_some_and(|s| s.len() <= 4096 && !s.contains('\0')),
                "Notification body must be at most 4096 UTF-8 bytes"
            );
            Ok(1)
        }
        Some("dismiss") => {
            ensure!(
                request["notificationId"].as_u64().is_some_and(|id| id > 0),
                "Notification ID required"
            );
            Ok(1)
        }
        _ => Err(anyhow!("Unknown system action")),
    }
}
impl Worker {
    fn new() -> Result<Self> {
        let (send, tasks) = mpsc::sync_channel(LIMIT);
        let (replies, receive) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("WeberSystem".into())
            .spawn(move || {
                let connection = async_io::block_on(async {
                    future::race(
                        async {
                            Ok::<_, anyhow::Error>(
                                zbus::connection::Builder::session()?
                                    .method_timeout(Duration::from_secs(2))
                                    .build()
                                    .await?,
                            )
                        },
                        async {
                            async_io::Timer::after(Duration::from_secs(3)).await;
                            Err(anyhow!("System bus connection timed out"))
                        },
                    )
                    .await
                });
                let mut notifications = BTreeMap::new();
                for message in tasks {
                    if let Ok(connection) = &connection {
                        async_io::block_on(cleanup(connection, &mut notifications));
                    }
                    if let Message::Task(task) = message {
                        let result = match &connection {
                            Ok(connection) => {
                                async_io::block_on(operate(connection, &task, &mut notifications))
                            }
                            Err(error) => Err(anyhow!(error.to_string())),
                        };
                        let _ = replies.send((task.id, result.map_err(|error| error.to_string())));
                    }
                }
                if let Ok(connection) = &connection {
                    async_io::block_on(cleanup(connection, &mut notifications));
                }
            })?;
        Ok(Self {
            send,
            receive,
            thread,
            pending: BTreeMap::new(),
            owners: BTreeMap::new(),
        })
    }
    fn drain(&mut self) {
        while let Ok((id, result)) = self.receive.try_recv() {
            if let Some(pending) = self.pending.get_mut(&id) {
                pending.result = Some(result);
            }
        }
        if self.thread.is_finished() {
            for pending in self.pending.values_mut().filter(|p| p.result.is_none()) {
                pending.result = Some(Err("System worker stopped".into()));
            }
        }
    }
}
pub fn submit(owner: u64, request: Value, parent: String) -> Result<Value> {
    let kind = validate(&request)?;
    let mut slots = WORKERS
        .lock()
        .map_err(|_| anyhow!("System worker lock failed"))?;
    if slots[kind].is_none() {
        slots[kind] = Some(Worker::new()?);
    }
    let worker = slots[kind]
        .as_mut()
        .ok_or_else(|| anyhow!("System worker unavailable"))?;
    worker.drain();
    ensure!(worker.pending.len() < LIMIT, "System request limit reached");
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (send, receive) = async_channel::bounded(1);
    let cancel = Arc::new(Cancellation { send, receive });
    let alive = worker
        .owners
        .entry(owner)
        .or_insert_with(|| Arc::new(AtomicBool::new(true)))
        .clone();
    worker
        .send
        .try_send(Message::Task(Task {
            id,
            owner,
            alive,
            cancel: cancel.clone(),
            request,
            parent,
        }))
        .map_err(|_| anyhow!("System queue full or stopped"))?;
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
        .ok_or_else(|| anyhow!("System request ID required"))
}
pub fn poll(owner: u64, request: &Value) -> Result<Value> {
    let id = request_id(request)?;
    let mut slots = WORKERS
        .lock()
        .map_err(|_| anyhow!("System worker lock failed"))?;
    for worker in slots.iter_mut().flatten() {
        worker.drain();
        if let Some(pending) = worker.pending.get(&id).filter(|p| p.owner == owner) {
            if pending.result.is_none() {
                return Ok(json!({"pending":true}));
            }
            let pending = worker
                .pending
                .remove(&id)
                .ok_or_else(|| anyhow!("System request disappeared"))?;
            return match pending.result {
                Some(Ok(value)) => Ok(json!({"pending":false,"value":value})),
                Some(Err(error)) => Err(anyhow!(error)),
                None => Err(anyhow!("System result unavailable")),
            };
        }
    }
    Err(anyhow!("Unknown system request"))
}
pub fn cancel(owner: u64, request: &Value) -> Result<()> {
    let id = request_id(request)?;
    let mut slots = WORKERS
        .lock()
        .map_err(|_| anyhow!("System worker lock failed"))?;
    for worker in slots.iter_mut().flatten() {
        if worker.pending.get(&id).is_some_and(|p| p.owner == owner) {
            if let Some(pending) = worker.pending.remove(&id) {
                pending.cancel.send.close();
            }
            let _ = worker.send.try_send(Message::Changed);
            return Ok(());
        }
    }
    Err(anyhow!("Unknown system request"))
}
pub fn close_window(owner: u64) {
    if let Ok(mut slots) = WORKERS.lock() {
        for worker in slots.iter_mut().flatten() {
            if let Some(alive) = worker.owners.remove(&owner) {
                alive.store(false, Ordering::Release);
            }
            worker.pending.retain(|_, pending| {
                if pending.owner == owner {
                    pending.cancel.send.close();
                    false
                } else {
                    true
                }
            });
            let _ = worker.send.try_send(Message::Changed);
            worker.drain();
        }
    }
}
pub fn shutdown() {
    let workers = WORKERS
        .lock()
        .ok()
        .map(|mut slots| std::mem::take(&mut *slots));
    if let Some(workers) = workers {
        for worker in workers.into_iter().flatten() {
            for alive in worker.owners.values() {
                alive.store(false, Ordering::Release);
            }
            for pending in worker.pending.values() {
                pending.cancel.send.close();
            }
            drop(worker.send);
            let _ = worker.thread.join();
        }
    }
}
async fn notification_proxy(connection: &zbus::Connection) -> Result<zbus::Proxy<'_>> {
    Ok(zbus::Proxy::new(
        connection,
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
    )
    .await?)
}
async fn cleanup(connection: &zbus::Connection, notifications: &mut BTreeMap<u64, Notification>) {
    let retired: Vec<_> = notifications
        .iter()
        .filter_map(|(id, n)| {
            (!n.alive.load(Ordering::Acquire)
                || n.cancel.send.is_closed()
                || std::time::Instant::now() >= n.expires)
                .then_some(*id)
        })
        .collect();
    let mut work: std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> = Box::pin(async {});
    for id in retired {
        if let Some(notification) = notifications.remove(&id) {
            let connection = connection.clone();
            work = Box::pin(async move {
                future::zip(work, async move {
                    if let Ok(proxy) = notification_proxy(&connection).await {
                        let _ = proxy
                            .call_method("CloseNotification", &(notification.server,))
                            .await;
                    }
                })
                .await;
            });
        }
    }
    future::race(work, async {
        async_io::Timer::after(Duration::from_secs(2)).await;
    })
    .await;
}
async fn operate(
    connection: &zbus::Connection,
    task: &Task,
    notifications: &mut BTreeMap<u64, Notification>,
) -> Result<Value> {
    ensure!(
        task.alive.load(Ordering::Acquire) && !task.cancel.send.is_closed(),
        "System request cancelled"
    );
    if task.request["action"] == "open" {
        return open_uri(connection, task).await;
    }
    let proxy = notification_proxy(connection).await?;
    if task.request["action"] == "dismiss" {
        let id = task.request["notificationId"]
            .as_u64()
            .ok_or_else(|| anyhow!("Notification ID required"))?;
        let notification = notifications
            .get(&id)
            .filter(|n| n.owner == task.owner && Arc::ptr_eq(&n.alive, &task.alive))
            .ok_or_else(|| anyhow!("Unknown notification"))?;
        proxy
            .call_method("CloseNotification", &(notification.server,))
            .await?;
        notifications.remove(&id);
        return Ok(Value::Null);
    }
    ensure!(
        notifications.len() < 64
            && notifications
                .values()
                .filter(|n| n.owner == task.owner)
                .count()
                < 8,
        "Notification limit reached; dismiss an earlier notification"
    );
    let capabilities: Vec<String> = proxy.call("GetCapabilities", &()).await?;
    let plain = task.request["body"].as_str().unwrap_or("");
    let body = if capabilities.iter().any(|value| value == "body-markup") {
        plain
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    } else {
        plain.to_owned()
    };
    let hints = HashMap::from([(
        "desktop-entry",
        DbusValue::from(crate::assets::application().map_or("dev.weber.Preview", |app| app.id())),
    )]);
    let server: u32 = proxy
        .call(
            "Notify",
            &(
                crate::assets::application().map_or("Weber", |app| app.name()),
                0u32,
                "",
                task.request["title"].as_str().unwrap_or(""),
                body,
                Vec::<String>::new(),
                hints,
                10000i32,
            ),
        )
        .await?;
    ensure!(server != 0, "Desktop returned an invalid notification ID");
    notifications.insert(
        task.id,
        Notification {
            owner: task.owner,
            alive: task.alive.clone(),
            cancel: task.cancel.clone(),
            server,
            expires: std::time::Instant::now() + Duration::from_secs(30),
        },
    );
    cleanup(connection, notifications).await;
    ensure!(
        task.alive.load(Ordering::Acquire) && !task.cancel.send.is_closed(),
        "System request cancelled"
    );
    Ok(json!({"id":task.id}))
}
async fn open_uri(connection: &zbus::Connection, task: &Task) -> Result<Value> {
    let token = format!("weber_system_{}_{}", std::process::id(), task.id);
    let sender = connection
        .unique_name()
        .ok_or_else(|| anyhow!("Portal identity missing"))?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let handle = zbus::Proxy::new(
        connection,
        PORTAL,
        path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .await?;
    let mut signals = handle.receive_signal("Response").await?;
    let portal = zbus::Proxy::new(
        connection,
        PORTAL,
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.OpenURI",
    )
    .await?;
    let result = future::race(
        async {
            let options = HashMap::from([
                ("handle_token", DbusValue::from(token.as_str())),
                (
                    "ask",
                    DbusValue::from(task.request["ask"].as_bool().unwrap_or(false)),
                ),
            ]);
            let actual: OwnedObjectPath = portal
                .call(
                    "OpenURI",
                    &(
                        task.parent.as_str(),
                        task.request["url"]
                            .as_str()
                            .ok_or_else(|| anyhow!("URL required"))?,
                        options,
                    ),
                )
                .await?;
            if actual.as_str() != path {
                if let Ok(other) = zbus::Proxy::new(
                    connection,
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
            let (code, _): (u32, HashMap<String, OwnedValue>) = response.body().deserialize()?;
            match code {
                0 => Ok(json!(true)),
                1 => Ok(Value::Null),
                _ => Err(anyhow!("Desktop URL request failed ({code})")),
            }
        },
        async {
            future::race(
                async {
                    let _ = task.cancel.receive.recv().await;
                },
                async {
                    async_io::Timer::after(Duration::from_secs(30)).await;
                },
            )
            .await;
            Err(anyhow!("URL request cancelled or timed out"))
        },
    )
    .await;
    if result.is_err() {
        let _ = handle.call_method("Close", &()).await;
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_url_and_notification_boundaries() {
        for url in [
            "https://example.test/a?q=한글",
            "http://localhost:8000/",
            "mailto:a@example.test",
        ] {
            assert_eq!(validate(&json!({"action":"open","url":url})).ok(), Some(0));
        }
        for url in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "data:text/html,a",
            "https://user:password@example.test/",
            "https://example.test/\n",
            "mailto:",
        ] {
            assert!(validate(&json!({"action":"open","url":url})).is_err());
        }
        assert!(validate(&json!({"action":"notify","title":"알림","body":"<b>plain</b>"})).is_ok());
        assert!(validate(&json!({"action":"notify","title":"x","body":"x".repeat(4097)})).is_err());
        assert!(validate(&json!({"action":"dismiss","notificationId":0})).is_err());
    }
}
