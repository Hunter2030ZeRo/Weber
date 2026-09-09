//! These tests use a fake host. Actual Obscura/GTK coverage is native-example.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use weber_native_runtime::{Error, Event, Runtime, WindowOptions};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { root: PathBuf, renderer: PathBuf }
impl Fixture {
    fn new(mode: &str) -> Self {
        let root = std::env::temp_dir().join(format!("weber-native-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let renderer = root.join(mode);
        std::fs::write(&renderer, "fake renderer argument").unwrap();
        std::fs::write(root.join("index.html"), "<h1>fixture</h1>").unwrap();
        Self { root, renderer }
    }
    fn runtime(&self) -> Runtime { Runtime::spawn(fake_host(), &self.renderer, Duration::from_secs(2)).unwrap() }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }

fn fake_host() -> &'static Path {
    static HOST: OnceLock<PathBuf> = OnceLock::new();
    HOST.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("weber-native-fake-host-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("host.rs");
        std::fs::write(&source, r#"
use std::io::{BufRead, Write};
fn emit(value: &str) { println!("{value}"); std::io::stdout().flush().unwrap(); }
fn number(line: &str, key: &str) -> u64 {
    line.split(&format!("\"{key}\":" )).nth(1).unwrap_or("0").chars()
        .take_while(|value| value.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)
}
fn main() {
    let renderer = std::path::PathBuf::from(std::env::args_os().nth(1).unwrap());
    let mode = renderer.file_name().unwrap().to_str().unwrap();
    let protocol = if mode == "bad-handshake" { 2 } else { 1 };
    emit(&format!("{{\"event\":\"ready\",\"protocol\":{protocol},\"engine\":\"obscura\"}}"));
    if mode == "blocked-input" { std::thread::sleep(std::time::Duration::from_secs(30)); return; }
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap(); let id = number(&line, "id"); let window = number(&line, "windowId");
        if mode == "wrong-id" { emit(&format!("{{\"id\":{},\"result\":null}}", id + 1)); continue; }
        if mode == "oversized" { print!("{}", "x".repeat(1024 * 1024 + 1)); std::io::stdout().flush().unwrap(); continue; }
        if mode == "truncated" { print!("{{\"id\":"); std::io::stdout().flush().unwrap(); return; }
        if line.contains("window.create") {
            emit(&format!("{{\"id\":{id},\"result\":{{\"windowId\":{window},\"rendererPid\":{}}}}}", 900 + window));
        } else if line.contains("loadFile") {
            emit(&format!("{{\"event\":\"frame-presented\",\"windowId\":{window},\"width\":640,\"height\":400}}"));
            emit(&format!("{{\"id\":{id},\"result\":null}}"));
        } else if line.contains("host-error") {
            emit(&format!("{{\"id\":{id},\"error\":\"expected evaluation failure\"}}"));
        } else if line.contains("evaluate") {
            emit(&format!("{{\"id\":{id},\"result\":42}}"));
        } else {
            emit(&format!("{{\"id\":{id},\"result\":null}}"));
            if line.contains("window.close") { emit(&format!("{{\"event\":\"closed\",\"windowId\":{window}}}")); }
            if line.contains("app.quit") { break; }
        }
    }
    std::fs::write(renderer.with_extension("closed"), "host exited").unwrap();
}
"#).unwrap();
        let binary = root.join(format!("host{}", std::env::consts::EXE_SUFFIX));
        let output = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .arg("--edition=2021").arg(&source).arg("-o").arg(&binary).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        binary
    }).as_path()
}

#[test]
fn window_api_routes_ids_retains_events_and_recovers_from_host_errors() {
    let fixture = Fixture::new("normal");
    let runtime = fixture.runtime();
    let first = runtime.create_window(WindowOptions::default()).unwrap();
    let second = runtime.create_window(WindowOptions::default()).unwrap();
    assert_ne!(first.id(), second.id());
    assert_ne!(first.renderer_pid(), second.renderer_pid());
    first.load_file(fixture.root.join("index.html")).unwrap();
    first.wait_for_frame(Duration::from_millis(200)).unwrap();
    assert!(matches!(runtime.next_event(Duration::ZERO).unwrap(), Some(Event::FramePresented { window_id: 1, width: 640, height: 400 })));
    assert!(matches!(first.evaluate("host-error"), Err(Error::Host(_))));
    assert_eq!(first.evaluate("6*7").unwrap(), 42);
    first.close().unwrap();
    assert!(first.is_closed());
    assert!(matches!(first.evaluate("1"), Err(Error::Closed)));
    assert_eq!(second.evaluate("6*7").unwrap(), 42);
    runtime.quit().unwrap();
    runtime.quit().unwrap();
    assert!(second.is_closed());
    assert!(fixture.renderer.with_extension("closed").exists());
}

#[test]
fn last_handle_drop_closes_owned_host_and_does_not_require_explicit_quit() {
    let fixture = Fixture::new("normal");
    let runtime = fixture.runtime();
    let window = runtime.create_window(WindowOptions::default()).unwrap();
    drop(runtime);
    assert_eq!(window.evaluate("6*7").unwrap(), 42);
    drop(window);
    assert!(fixture.renderer.with_extension("closed").exists());
}

#[test]
fn invalid_handshake_and_transport_failures_are_rejected() {
    let fixture = Fixture::new("bad-handshake");
    assert!(matches!(Runtime::spawn(fake_host(), &fixture.renderer, Duration::from_secs(2)), Err(Error::Transport(_))));
    for mode in ["wrong-id", "oversized", "truncated"] {
        let fixture = Fixture::new(mode);
        let runtime = fixture.runtime();
        assert!(matches!(runtime.create_window(WindowOptions::default()), Err(Error::Transport(_))), "mode {mode}");
        assert!(matches!(runtime.create_window(WindowOptions::default()), Err(Error::Closed)));
    }
}

#[test]
fn request_deadline_covers_a_child_that_does_not_read_stdin() {
    let fixture = Fixture::new("blocked-input");
    let runtime = Runtime::spawn(fake_host(), &fixture.renderer, Duration::from_millis(250)).unwrap();
    let start = Instant::now();
    let options = WindowOptions { title: "a".repeat(900 * 1024), ..Default::default() };
    assert!(matches!(runtime.create_window(options), Err(Error::Timeout)));
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[test]
fn oversized_local_requests_and_idle_event_timeouts_keep_connection_usable() {
    let fixture = Fixture::new("normal");
    let runtime = fixture.runtime();
    assert!(runtime.next_event(Duration::from_millis(20)).unwrap().is_none());
    let options = WindowOptions { title: "a".repeat(1024 * 1024), ..Default::default() };
    assert!(matches!(runtime.create_window(options), Err(Error::Configuration(_))));
    let window = runtime.create_window(WindowOptions::default()).unwrap();
    assert_eq!(window.evaluate("6*7").unwrap(), 42);
    assert!(matches!(window.wait_for_frame(Duration::from_millis(20)), Err(Error::Timeout)));
    assert_eq!(window.evaluate("6*7").unwrap(), 42);
    runtime.quit().unwrap();
}
