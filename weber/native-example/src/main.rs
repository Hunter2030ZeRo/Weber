//! Native Rust main process using Weber's reusable GUI API, without Node/Bun.
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use weber_native_runtime::{Runtime, WindowOptions};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let project = std::env::var_os("WEBER_PROJECT_DIR").map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let runtime = Runtime::from_env()?;
    let window = runtime.create_window(WindowOptions {
        width: 640, height: 400, title: "Weber native Rust backend".into(), ..Default::default()
    })?;
    window.load_file(project.join("index.html"))?;
    let evaluated = window.evaluate(
        "document.getElementById('result').textContent = 'Native Rust backend connected'; ({title: document.title, text: document.getElementById('result').textContent, answer: 6 * 7})"
    )?;
    if evaluated != json!({"title": "Weber native example", "text": "Native Rust backend connected", "answer": 42}) {
        return Err(format!("Unexpected Obscura DOM result: {evaluated}").into());
    }
    window.wait_for_frame(Duration::from_secs(10))?;
    window.close()?;
    runtime.quit()?;
    println!("{}", json!({"ok": true, "backend": "native", "rendererPid": window.renderer_pid(),
        "framePresented": true, "dom": evaluated}));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Weber native example: {error}");
        std::process::exit(1);
    }
}
