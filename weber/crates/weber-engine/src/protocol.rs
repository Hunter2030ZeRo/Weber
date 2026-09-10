//! Bounded private resource transport; application main owns each handler.
use std::{collections::HashMap, os::fd::FromRawFd, sync::Arc, time::Duration};
use obscura_net::{desktop_protocol::DesktopProtocolHandler, RequestInfo, Response, ObscuraNetError};
use serde_json::{json, Value};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::UnixStream, sync::Mutex};
use base64::Engine as _;

pub struct Protocols {
    channel: Mutex<Option<(UnixStream, u32)>>,
    rules: std::sync::RwLock<HashMap<String, Value>>,
}
impl Protocols {
    pub fn from_fd(fd: i32) -> Result<Option<Arc<Self>>, String> {
        if fd < 0 { return Ok(None); }
        // fd 4 exists only when the desktop owner deliberately supplied it.
        let mut kind = 0i32;
        let mut length = std::mem::size_of::<i32>() as libc::socklen_t;
        if unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_TYPE, &mut kind as *mut _ as *mut _, &mut length) } != 0 {
            return Err("Resource descriptor is not a socket".into());
        }
        if kind != libc::SOCK_STREAM { return Err("Invalid resource channel".into()); }
        let socket = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
        socket.set_nonblocking(true).map_err(|e| e.to_string())?;
        let socket = UnixStream::from_std(socket).map_err(|e| e.to_string())?;
        Ok(Some(Arc::new(Self { channel: Mutex::new(Some((socket, 0))), rules: Default::default() })))
    }
    pub fn configure(&self, rules: &Value) -> Result<(), String> {
        let rules = rules.as_array().filter(|v| v.len() <= 128).ok_or("Invalid protocol registry")?;
        let mut next = HashMap::new();
        for rule in rules {
            let name = rule["scheme"].as_str().ok_or("Protocol has no scheme")?;
            if name.len() > 64 || name.is_empty() || !name.bytes().enumerate().all(|(i, c)|
                c.is_ascii_lowercase() || (i > 0 && (c.is_ascii_digit() || b"+.-".contains(&c))))
                || ["http", "https", "javascript", "data", "about", "blob"].contains(&name) {
                return Err("Unsupported or invalid custom protocol".into());
            }
            if next.insert(name.to_string(), rule.clone()).is_some() { return Err("Duplicate protocol".into()); }
        }
        *self.rules.write().unwrap() = next;
        Ok(())
    }
    async fn receive(socket: &mut UnixStream, id: u32, maximum: usize) -> Result<(u32, Vec<u8>), String> {
        let mut header = [0u8; 16];
        socket.read_exact(&mut header).await.map_err(|e| e.to_string())?;
        let sequence = u32::from_be_bytes(header[4..8].try_into().unwrap());
        let kind = u32::from_be_bytes(header[8..12].try_into().unwrap());
        let size = u32::from_be_bytes(header[12..16].try_into().unwrap()) as usize;
        if &header[..4] != b"WBR1" || sequence != id || ![1, 2].contains(&kind) || size > maximum {
            return Err("Uncorrelated or oversized resource response".into());
        }
        let mut bytes = vec![0u8; size];
        socket.read_exact(&mut bytes).await.map_err(|e| e.to_string())?;
        Ok((kind, bytes))
    }
    async fn exchange(&self, value: Value, url: url::Url) -> Result<Response, String> {
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 { return Err("Protocol request exceeds 1 MiB".into()); }
        let transaction = async {
            let mut channel = self.channel.lock().await;
            // Taking ownership makes cancellation close this exact stream; a
            // timed-out response can never contaminate a later transaction.
            let (mut socket, sequence) = channel.take().ok_or("Resource channel closed")?;
            let id = sequence.checked_add(1).ok_or("Resource sequence exhausted")?;
            let mut header = Vec::from(&b"WBR1"[..]);
            header.extend(id.to_be_bytes()); header.extend(0u32.to_be_bytes());
            header.extend((bytes.len() as u32).to_be_bytes());
            socket.write_all(&header).await.map_err(|e| e.to_string())?;
            socket.write_all(&bytes).await.map_err(|e| e.to_string())?;
            let (kind, head) = Self::receive(&mut socket, id, 1024 * 1024).await?;
            if kind == 2 {
                *channel = Some((socket, id));
                return Err(String::from_utf8_lossy(&head).into_owned());
            }
            let metadata: Value = serde_json::from_slice(&head).map_err(|e| e.to_string())?;
            let (kind, body) = Self::receive(&mut socket, id, 64 * 1024 * 1024).await?;
            if kind != 1 || metadata["bodyLength"].as_u64() != Some(body.len() as u64) {
                return Err("Invalid resource body framing".into());
            }
            let status = metadata["statusCode"].as_u64().filter(|n| (100..=599).contains(n)).ok_or("Invalid protocol status")?;
            let headers: HashMap<String, String> = serde_json::from_value(metadata["headers"].clone()).map_err(|e| e.to_string())?;
            *channel = Some((socket, id));
            Ok(Response { url, status: status as u16, headers, body, redirected_from: vec![] })
        };
        tokio::time::timeout(Duration::from_secs(25), transaction).await.map_err(|_| "Protocol request timed out".to_string())?
    }
}
#[async_trait::async_trait]
impl DesktopProtocolHandler for Protocols {
    fn accepts(&self, scheme: &str) -> bool { self.rules.read().unwrap().contains_key(scheme) }
    fn standard(&self, scheme: &str) -> bool { self.rules.read().unwrap().get(scheme).is_some_and(|v| v["standard"] == true) }
    fn fetch_enabled(&self, scheme: &str) -> bool { self.rules.read().unwrap().get(scheme).is_some_and(|v| v["supportFetchAPI"] == true) }
    async fn request(&self, request: &RequestInfo, body: &[u8], initiator: &str) -> Result<Response, ObscuraNetError> {
        self.exchange(json!({"url": request.url.as_str(), "method": request.method,
            "headers": request.headers, "resourceType": format!("{:?}", request.resource_type),
            "initiatorOrigin": initiator, "body": base64::engine::general_purpose::STANDARD.encode(body)}), request.url.clone())
            .await.map_err(ObscuraNetError::Blocked)
    }
}
