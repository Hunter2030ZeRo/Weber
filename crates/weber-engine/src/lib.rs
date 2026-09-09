//! Renderer-side C ABI. Never load alongside Electron's separate V8 build.
//! The caller owns valid input/callback pointers; all calls use the creating thread.
use std::{cell::RefCell, ffi::c_void, panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, atomic::{AtomicU64, Ordering}}, time::Duration};
use obscura_browser::{BrowserContext, Page};
use serde_json::{json, Value};

const MAX_REQUEST: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 64 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
thread_local! { static ENGINE: RefCell<Option<(u64, Engine)>> = const { RefCell::new(None) }; }
struct Engine {
    // Page/V8 must be destroyed before the Tokio runtime.
    page: Page,
    runtime: tokio::runtime::Runtime,
    loaded: bool,
    width: u32,
    height: u32,
    poisoned: bool,
}
type Reply = extern "C" fn(*const u8, usize, *mut c_void);

impl Engine {
    fn new() -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all()
            .build().map_err(|e| e.to_string())?;
        let page = {
            let _guard = runtime.enter();
            let mut page = Page::new("weber-renderer".into(), Arc::new(BrowserContext::new("weber-renderer".into())));
            page.set_navigation_timeout(Duration::from_secs(15));
            page.set_viewport((800., 600.));
            page
        };
        Ok(Self { page, runtime, loaded: false, width: 800, height: 600, poisoned: false })
    }
    fn command(&mut self, value: Value) -> Result<Vec<u8>, String> {
        if self.poisoned { return Err("Engine is poisoned; destroy the renderer".into()); }
        let _guard = self.runtime.enter();
        match value.get("method").and_then(Value::as_str).ok_or("Missing method")? {
            "loadFile" => {
                let path = value.get("path").and_then(Value::as_str).ok_or("Missing path")?;
                let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
                if !path.is_file() { return Err("Expected a file".into()); }
                let url = url::Url::from_file_path(path).map_err(|_| "Invalid path")?;
                self.loaded = false;
                self.runtime.block_on(self.page.navigate(url.as_str())).map_err(|e| e.to_string())?;
                self.runtime.block_on(self.page.prepare_screenshot_resources(100));
                self.loaded = true;
                Ok(json!({"url": self.page.url_string()}).to_string().into_bytes())
            }
            "viewport" => {
                let width = value.get("width").and_then(Value::as_u64).ok_or("Missing width")?;
                let height = value.get("height").and_then(Value::as_u64).ok_or("Missing height")?;
                if width == 0 || height == 0 || width > 8192 || height > 8192 || width * height > 16_777_216 {
                    return Err("Viewport exceeds bounds".into());
                }
                self.width = width as u32; self.height = height as u32;
                self.page.set_viewport((width as f32, height as f32));
                Ok(b"null".to_vec())
            }
            "evaluate" => {
                if !self.loaded { return Err("No document loaded".into()); }
                let source = value.get("source").and_then(Value::as_str).ok_or("Missing source")?;
                let source = serde_json::to_string(source).map_err(|e| e.to_string())?;
                let wrapped = format!("(() => {{ try {{ const value = (0, eval)({source}); if (value && typeof value.then === 'function') throw new Error('Promise results unsupported'); return {{ok:true,value:value === undefined ? null : value}}; }} catch(e) {{ return {{ok:false,error:String(e)}}; }} }})()");
                let result = self.page.evaluate_with_timeout(&wrapped, Duration::from_secs(2));
                if result.get("ok").and_then(Value::as_bool) != Some(true) {
                    return Err(result.get("error").and_then(Value::as_str)
                        .unwrap_or("JavaScript execution failed or timed out").into());
                }
                Ok(result["value"].to_string().into_bytes())
            }
            "capturePng" => {
                if !self.loaded { return Err("No document loaded".into()); }
                // Diagnostic bring-up only. Raw frames are a separate engine API task.
                self.page.screenshot((self.width as f32, self.height as f32)).ok_or("Rendering failed".into())
            }
            _ => Err("Unsupported engine method".into()),
        }
    }
}

#[no_mangle]
pub extern "C" fn weber_engine_abi_version() -> u32 { 1 }

/// One engine per owner thread. Zero means startup failed or an engine already exists.
#[no_mangle]
pub extern "C" fn weber_engine_create() -> u64 {
    catch_unwind(AssertUnwindSafe(|| ENGINE.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else { return 0; };
        if slot.is_some() { return 0; }
        let Ok(engine) = Engine::new() else { return 0; };
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        if id == 0 { return 0; }
        *slot = Some((id, engine)); id
    }))).unwrap_or(0)
}

/// Status 0: success bytes (JSON, or PNG for capturePng); 1: UTF-8 error bytes.
/// Callback bytes are borrowed only for the duration of the callback.
/// Callback must not throw, retain the pointer, or reenter the engine.
/// Invalid pointers are caller errors; this is not a sandbox boundary.
#[no_mangle]
pub unsafe extern "C" fn weber_engine_command(id: u64, input: *const u8, len: usize,
    reply: Option<Reply>, user: *mut c_void) -> i32 {
    let Some(reply) = reply else { return 1; };
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<Vec<u8>, String> {
        if input.is_null() || len == 0 || len > MAX_REQUEST { return Err("Invalid request size/pointer".into()); }
        let value = serde_json::from_slice(std::slice::from_raw_parts(input, len)).map_err(|e| e.to_string())?;
        ENGINE.with(|slot| {
            let mut slot = slot.try_borrow_mut().map_err(|_| "Reentrant engine call")?;
            let (owner, engine) = slot.as_mut().ok_or("Unknown engine or wrong thread")?;
            if *owner != id { return Err("Unknown engine or wrong thread".into()); }
            engine.command(value)
        })
    }));
    let result = match result {
        Ok(result) => result,
        Err(_) => {
            ENGINE.with(|slot| { if let Ok(mut slot) = slot.try_borrow_mut() {
                if let Some((owner, engine)) = slot.as_mut() { if *owner == id { engine.poisoned = true; } }
            }});
            Err("Engine panicked; renderer restart required".into())
        }
    };
    let (status, bytes) = match result {
        Ok(bytes) if bytes.len() <= MAX_RESPONSE => (0, bytes),
        Ok(_) => (1, b"Response exceeds 64 MiB".to_vec()),
        Err(error) => (1, error.into_bytes()),
    };
    reply(bytes.as_ptr(), bytes.len(), user);
    status
}

#[no_mangle]
pub extern "C" fn weber_engine_destroy(id: u64) -> i32 {
    catch_unwind(AssertUnwindSafe(|| ENGINE.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else { return 1; };
        if slot.as_ref().map(|(owner, _)| *owner) != Some(id) { return 1; }
        drop(slot.take()); 0
    }))).unwrap_or(1)
}
