fn main() {
    if let Err(error) = weber_host::run_host() {
        eprintln!("Weber: {error}");
        std::process::exit(1);
    }
}
