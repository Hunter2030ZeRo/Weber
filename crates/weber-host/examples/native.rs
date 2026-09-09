use serde_json::json;
fn main() {
    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("examples/javascript/index.html"));
    if let Err(error) = weber_host::run_native(path, vec!["system.info".into()], Box::new(|channel, _| {
        match channel {
            "system.info" => Ok(json!({"backend": "Rust native", "platform": std::env::consts::OS})),
            _ => Err("Unknown channel".into()),
        }
    })) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
