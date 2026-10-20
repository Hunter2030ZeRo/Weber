// CXX checks the signatures and owns the C++ object; no raw pointers cross this API.
#[cxx::bridge(namespace = "weber")]
pub mod ffi {
    extern "Rust" {
        fn dom_query(payload: &str) -> Result<String>;
        fn dom_query_available() -> bool;
        fn dom_query_bytes(payload: &[u8]) -> Result<Vec<u8>>;
        fn copy_wire_bytes(payload: &[u8]) -> Vec<u8>;
        fn backend_exchange(payload: &str) -> String;
        fn native_exchange(payload: &str) -> String;
    }
    unsafe extern "C++" {
        include!("native/hermes.hpp");
        type Runtime;
        fn create_runtime() -> Result<UniquePtr<Runtime>>;
        fn load_application(
            self: Pin<&mut Runtime>,
            path: &str,
            request: &[u8],
            binary: bool,
        ) -> Result<()>;
        fn increment(self: Pin<&mut Runtime>, delta: i32) -> Result<i32>;
        fn dom_start(self: Pin<&mut Runtime>) -> Result<String>;
        fn dom_browser(self: Pin<&mut Runtime>) -> Result<String>;
        fn browser_contracts(self: Pin<&mut Runtime>) -> Result<String>;
        fn solid_contracts(self: Pin<&mut Runtime>) -> Result<String>;
        fn scheduler_contracts(self: Pin<&mut Runtime>) -> Result<String>;
        fn wpt_start(self: Pin<&mut Runtime>, index: u32) -> Result<String>;
        fn host_call(
            self: Pin<&mut Runtime>,
            request: &str,
            checkpoint: bool,
            collect: bool,
            report: bool,
        ) -> Result<String>;
        fn host_call_bytes(
            self: Pin<&mut Runtime>,
            request: &[u8],
            checkpoint: bool,
            collect: bool,
            report: bool,
        ) -> Result<Vec<u8>>;
        fn lifetime_contracts(self: Pin<&mut Runtime>) -> Result<String>;
        fn dom_event(self: Pin<&mut Runtime>, event: &str) -> Result<String>;
        fn dom_dispose(self: Pin<&mut Runtime>) -> Result<String>;
    }
}

fn dom_query(payload: &str) -> anyhow::Result<String> {
    crate::host::dom_query(payload)
}

fn dom_query_available() -> bool {
    crate::host::dom_query_available()
}

fn dom_query_bytes(payload: &[u8]) -> anyhow::Result<Vec<u8>> {
    crate::host::dom_query_bytes(payload)
}

fn copy_wire_bytes(payload: &[u8]) -> Vec<u8> {
    payload.to_vec()
}
fn backend_exchange(payload: &str) -> String {
    crate::backend::exchange(payload)
}

fn native_exchange(payload: &str) -> String {
    crate::native::exchange_active(payload)
}
