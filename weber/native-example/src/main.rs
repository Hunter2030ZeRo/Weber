//! A small native main process using the same GUI host as Node/Bun backends.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, String>;
const MAX_MESSAGE: u64 = 1024 * 1024;

struct Host {
    child: Child,
    input: Option<ChildStdin>,
    replies: Receiver<Result<Value>>,
    reader: Option<JoinHandle<()>>,
    next_id: u64,
    presented: HashSet<u64>,
}

impl Host {
    fn start() -> Result<Self> {
        let host = required_path("WEBER_DESKTOP_HOST")?;
        let renderer = required_path("WEBER_OBSCURA_RENDERER")?;
        let mut child = Command::new(host).arg(renderer)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
            .spawn().map_err(|error| format!("Cannot start Weber desktop host: {error}"))?;
        let input = child.stdin.take().expect("piped stdin");
        let output = child.stdout.take().expect("piped stdout");
        let (sender, replies) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let read = output.by_ref().take(MAX_MESSAGE + 1).read_until(b'\n', &mut line);
                let message = match read {
                    Ok(0) => break,
                    Ok(_) if line.len() as u64 > MAX_MESSAGE => Err("Host response exceeds 1 MiB".into()),
                    Ok(_) if !line.ends_with(b"\n") => Err("Host response ended before its newline".into()),
                    Ok(_) => serde_json::from_slice(&line).map_err(|error| format!("Invalid host JSON: {error}")),
                    Err(error) => Err(format!("Reading host response: {error}")),
                };
                let failed = message.is_err();
                if sender.send(message).is_err() || failed { break; }
            }
        });
        Ok(Self { child, input: Some(input), replies, reader: Some(reader), next_id: 0, presented: HashSet::new() })
    }

    fn record_event(&mut self, message: &Value) {
        if message["event"] == "frame-presented" {
            if let Some(window) = message["windowId"].as_u64() { self.presented.insert(window); }
        }
    }

    fn wait_for_frame(&mut self, window: u64) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.presented.contains(&window) {
            let remaining = deadline.checked_duration_since(Instant::now())
                .ok_or("No Obscura frame was presented in the native window")?;
            let event = self.replies.recv_timeout(remaining)
                .map_err(|error| format!("Waiting for the native window frame: {error}"))??;
            if event.get("event").is_none() { return Err(format!("Unexpected host response: {event}")); }
            self.record_event(&event);
        }
        Ok(())
    }

    fn request(&mut self, mut message: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        message["id"] = json!(id);
        let mut line = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        line.push(b'\n');
        if line.len() as u64 > MAX_MESSAGE { return Err("Request exceeds 1 MiB".into()); }
        let input = self.input.as_mut().ok_or("Desktop host is closed")?;
        input.write_all(&line).and_then(|_| input.flush())
            .map_err(|error| format!("Writing host request: {error}"))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let remaining = deadline.checked_duration_since(Instant::now())
                .ok_or_else(|| format!("Desktop request {id} timed out"))?;
            let response = self.replies.recv_timeout(remaining)
                .map_err(|error| format!("Waiting for desktop request {id}: {error}"))??;
            if response.get("event").is_some() { self.record_event(&response); continue; }
            if response["id"].as_u64() != Some(id) {
                return Err(format!("Unexpected host request id: {}", response["id"]));
            }
            if let Some(error) = response.get("error") { return Err(format!("Host error: {error}")); }
            return response.get("result").cloned().ok_or("Host response has no result".into());
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // Closing the channel requests host shutdown and renderer cleanup.
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                _ if Instant::now() >= deadline => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
                _ => thread::sleep(Duration::from_millis(10)),
            }
        }
        if let Some(reader) = self.reader.take() { let _ = reader.join(); }
    }
}

fn required_path(name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(std::env::var_os(name).ok_or_else(|| format!("{name} is required"))?);
    if !path.is_absolute() || !path.is_file() {
        return Err(format!("{name} must name an existing absolute file path"));
    }
    Ok(path)
}

fn run() -> Result<()> {
    let project = std::env::var_os("WEBER_PROJECT_DIR").map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
    let page = project.join("index.html").canonicalize()
        .map_err(|error| format!("Native example page: {error}"))?;
    let page = page.to_str().ok_or("The JSON host protocol requires a UTF-8 page path")?;
    let mut host = Host::start()?;
    let window = host.request(json!({"method": "window.create", "windowId": 1,
        "options": {"width": 640, "height": 400, "title": "Weber native Rust backend", "show": true}}))?;
    if window["windowId"] != 1 || window["rendererPid"].as_u64().unwrap_or(0) == 0 {
        return Err(format!("Invalid window creation result: {window}"));
    }
    host.request(json!({"method": "page.command", "windowId": 1,
        "command": {"method": "loadFile", "path": page}}))?;
    let evaluated = host.request(json!({"method": "page.command", "windowId": 1,
        "command": {"method": "evaluate", "source": "document.getElementById('result').textContent = 'Native Rust backend connected'; ({title: document.title, text: document.getElementById('result').textContent, answer: 6 * 7})"}}))?;
    if evaluated != json!({"title": "Weber native example", "text": "Native Rust backend connected", "answer": 42}) {
        return Err(format!("Unexpected Obscura DOM result: {evaluated}"));
    }
    host.wait_for_frame(1)?;
    host.request(json!({"method": "window.close", "windowId": 1}))?;
    host.request(json!({"method": "app.quit"}))?;
    println!("{}", json!({"ok": true, "backend": "native", "rendererPid": window["rendererPid"], "framePresented": true, "dom": evaluated}));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Weber native example: {error}");
        std::process::exit(1);
    }
}
