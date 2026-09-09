use std::path::PathBuf;
use weber_cli::{Backend, load_plan};
fn run() -> Result<i32, String> {
    let mut args = std::env::args().skip(1);
    let operation = args.next().unwrap_or_else(|| "--help".into());
    if operation == "--help" || operation == "-h" {
        println!("weber run [--project DIRECTORY] [--backend node|bun|native]\nweber check [--project DIRECTORY] [--backend node|bun|native]");
        return Ok(0);
    }
    if operation != "run" && operation != "check" { return Err("Expected run or check; see weber --help".into()); }
    let mut project = PathBuf::from(".");
    let mut backend = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--project" => project = PathBuf::from(args.next().ok_or("--project needs a directory")?),
            "--backend" => backend = Some(Backend::parse(&args.next().ok_or("--backend needs a value")?)?),
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }
    let plan = load_plan(&project, backend)?;
    if operation == "check" {
        println!("{}", serde_json::json!({"backend": plan.backend.name(), "executable": plan.executable,
            "arguments": plan.arguments, "project": plan.project, "frontend": plan.frontend, "channels": plan.channels}));
        return Ok(0);
    }
    let mut command = plan.command();
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        Err(format!("Cannot launch {} backend ({}): {}", plan.backend.name(), plan.executable.display(), command.exec()))
    }
    #[cfg(not(unix))] {
        command.status().map(|s| s.code().unwrap_or(1)).map_err(|e| format!("Cannot launch {} backend ({}): {e}", plan.backend.name(), plan.executable.display()))
    }
}
fn main() {
    match run() { Ok(code) => std::process::exit(code), Err(error) => { eprintln!("Weber: {error}"); std::process::exit(1); } }
}
