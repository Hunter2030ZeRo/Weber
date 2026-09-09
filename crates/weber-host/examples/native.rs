use serde_json::json;
fn main() {
    let path = std::env::var_os("WEBER_FRONTEND").or_else(|| std::env::args_os().nth(1)).map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("examples/javascript/index.html"));
    let channels: Vec<String> = match std::env::var("WEBER_ALLOWED_CHANNELS") {
        Ok(value) => match serde_json::from_str(&value) {
            Ok(channels) => channels,
            Err(error) => { eprintln!("Invalid WEBER_ALLOWED_CHANNELS: {error}"); std::process::exit(1); }
        },
        Err(_) => vec!["system.info".into()],
    };
    if let Err(error) = weber_host::run_native(path, channels, Box::new(|channel, _| {
        match channel {
            "system.info" => Ok(json!({"backend": "Rust native", "platform": std::env::consts::OS})),
            _ => Err("Unknown channel".into()),
        }
    })) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
