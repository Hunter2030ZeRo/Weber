#[cfg(feature = "aot")]
#[expect(
    unsafe_code,
    reason = "CXX requires an unsafe declaration for the checked C++ boundary"
)]
mod aot;
mod assets;
mod backend;
mod clipboard;
#[cfg(feature = "aot")]
mod dom;
mod files;
mod host;
mod input;
mod json;
#[cfg(feature = "layer-shell")]
mod layer;
mod memory;
mod native;
mod portal_parent;
mod storage;
mod system;
mod telemetry;
#[cfg(feature = "aot")]
mod wire;

use anyhow::{Result, anyhow};
use host::{App, Wake};
use url::Url;
use winit::event_loop::{ControlFlow, EventLoop};
use winit::platform::wayland::EventLoopBuilderExtWayland;

fn main() -> Result<()> {
    let started = std::time::Instant::now();
    if std::env::args().nth(1).as_deref() == Some("--build-info") {
        let mut info: serde_json::Value = serde_json::from_str(env!("WEBER_BUILD_INFO"))?;
        info["profile"] = env!("WEBER_COMPILE_PROFILE").into();
        info["platformNativeOptimization"] = env!("WEBER_NATIVE_OPT").into();
        info["nativeUnitAbi"] = if cfg!(feature = "aot") {
            env!("WEBER_AOT_ABI").into()
        } else {
            serde_json::Value::Null
        };
        info["frameworkVersion"] = env!("CARGO_PKG_VERSION").into();
        info["sdkWorkflowVersion"] = env!("CARGO_PKG_VERSION").into();
        info["bunBackendProtocol"] = 1.into();
        info["aotAvailable"] = cfg!(feature = "aot").into();
        info["layerShellProbe"] = cfg!(feature = "layer-shell").into();
        info["windowProtocol"] = 2.into();
        info["activationProtocol"] = 1.into();
        info["appIntegrationProtocol"] = 1.into();
        info["storageProtocol"] = 1.into();
        info["clipboardProtocol"] = 1.into();
        info["browserClipboardProtocol"] = 1.into();
        info["fileDialogProtocol"] = 1.into();
        info["fileDialogParentProtocol"] = 1.into();
        info["clipboardMaxTextBytes"] = 262_144.into();
        info["storageMaxValueBytes"] = 1_048_576.into();
        info["storageAreaQuotaBytes"] = 16_777_216.into();
        info["storageQueuedBytes"] = 4_194_304.into();
        info["safeCutProtocol"] = 1.into();
        info["imeSurroundingProtocol"] = 1.into();
        info["nativeEditableProtocol"] = 1.into();
        info["imeCaretGeometryProtocol"] = 1.into();
        info["closeRequestProtocol"] = 1.into();
        info["diagnosticsProtocol"] = 1.into();
        info["layoutPolicy"] = "serial-small-dom-v1".into();
        info["memoryReclaimPolicy"] = if cfg!(all(target_os = "linux", target_env = "gnu")) {
            "glibc-window-close"
        } else {
            "none"
        }
        .into();
        info["uiEngine"] = "spidermonkey".into();
        println!("{info}");
        return Ok(());
    }
    if std::env::args()
        .nth(1)
        .is_some_and(|arg| arg.ends_with("-self-test") || arg == "--wpt-case")
    {
        #[cfg(feature = "aot")]
        return aot_self_test();
        #[cfg(not(feature = "aot"))]
        anyhow::bail!("This JIT-only host has no AOT runtime; build with --features aot");
    }
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow!("TLS provider already installed"))?;
    #[cfg(feature = "layer-shell")]
    if std::env::args().nth(1).as_deref() == Some("--layer-probe") {
        return layer::run(
            std::env::args()
                .nth(2)
                .ok_or_else(|| anyhow!("--layer-probe requires an application URL"))?,
        );
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let application = args.first().is_some_and(|arg| arg == "--app");
    if application {
        let path = args
            .get(1)
            .ok_or_else(|| anyhow!("--app requires a compiled application directory"))?;
        anyhow::ensure!(
            args.len() == 2 || (args.len() == 3 && args[2] == "--web"),
            "Unknown application option"
        );
        assets::configure_application(std::path::Path::new(path))?;
    }
    let argument = if application {
        if args.get(2).is_some_and(|arg| arg == "--web")
            || assets::application().is_some_and(|app| app.unit_path.is_none())
        {
            "weber-app://application/web.html"
        } else {
            "weber-app://application/aot.html"
        }
        .to_owned()
    } else {
        std::env::args().nth(1).unwrap_or_else(|| {
            if cfg!(feature = "aot") {
                "weber-app://desktop/aot.html"
            } else {
                "weber-app://desktop/web.html"
            }
            .to_owned()
        })
    };
    let url = Url::parse(if argument == "--web" {
        "weber-app://desktop/web.html"
    } else {
        &argument
    })?;
    // Capture once for the initial window. Never mutate the process environment
    // after threads start; child backends explicitly exclude these one-shot IDs.
    let activation = std::env::var("XDG_ACTIVATION_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
        .map(winit::window::ActivationToken::from_raw);
    let _backend = if application {
        assets::application()
            .and_then(|app| app.backend_path.as_ref())
            .map(|path| {
                let directory = path
                    .parent()
                    .ok_or_else(|| anyhow!("Backend directory missing"))?;
                backend::start(path, directory, None)
            })
            .transpose()?
    } else if let Some(path) = std::env::var_os("WEBER_BACKEND_EXECUTABLE") {
        anyhow::ensure!(
            url.scheme() == "http" && url.host_str() == Some("127.0.0.1"),
            "Development backend requires a loopback application URL"
        );
        let path = assets::checked_backend(
            std::path::Path::new(&path),
            &std::env::var("WEBER_BACKEND_SHA256")?,
        )?;
        Some(backend::start(
            &path,
            &std::env::current_dir()?,
            Some(std::env::var("WEBER_BACKEND_CAPABILITY")?),
        )?)
    } else {
        None
    };
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https" | "file" | "weber-app"),
        "unsupported URL scheme"
    );
    let event_loop = EventLoop::<Wake>::with_user_event()
        .with_wayland()
        .build()?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let control = native::initialize(std::env::var("WEBER_NATIVE_CAPABILITY").ok())?;
    let mut app = App::new(url, event_loop.create_proxy(), started, control, activation);
    event_loop.run_app(&mut app)?;
    app.result()
}

#[cfg(feature = "aot")]
fn aot_self_test() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--lifetime-self-test") {
        let mut runtime = aot::ffi::create_runtime()?;
        println!("{}", runtime.pin_mut().lifetime_contracts()?);
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--wpt-case") {
        let index: u32 = std::env::args()
            .nth(2)
            .ok_or_else(|| anyhow!("WPT index required"))?
            .parse()?;
        let mut runtime = aot::ffi::create_runtime()?;
        println!("{}", runtime.pin_mut().wpt_start(index)?);
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--scheduler-self-test") {
        let mut runtime = aot::ffi::create_runtime()?;
        println!("{}", runtime.pin_mut().scheduler_contracts()?);
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--solid-self-test") {
        let mut runtime = aot::ffi::create_runtime()?;
        println!("{}", runtime.pin_mut().solid_contracts()?);
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--browser-contract-self-test") {
        let mut runtime = aot::ffi::create_runtime()?;
        let result = runtime.pin_mut().browser_contracts()?;
        println!("{result}");
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--aot-self-test") {
        let mut runtime = aot::ffi::create_runtime()?;
        anyhow::ensure!(runtime.pin_mut().increment(1)? == 1, "first AOT call");
        anyhow::ensure!(runtime.pin_mut().increment(2)? == 3, "persistent AOT state");
        for expected in 4..=1000 {
            anyhow::ensure!(
                runtime.pin_mut().increment(1)? == expected,
                "repeated AOT state"
            );
        }
        let mut independent = aot::ffi::create_runtime()?;
        anyhow::ensure!(
            independent.pin_mut().increment(1)? == 1,
            "independent runtime"
        );
        println!("Static Hermes native AOT: 1000 stateful increments; independent runtime passed");
        return Ok(());
    }
    anyhow::bail!("Unknown AOT self-test")
}

#[cfg(test)]
#[path = "../native/stylo_cache_pool.rs"]
mod stylo_cache_pool;
