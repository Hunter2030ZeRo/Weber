use anyhow::{Result, ensure};
use serde::Deserialize;
use servo::protocol_handler::{
    DoneChannel, FetchContext, ProtocolHandler, Request, ResourceFetchTiming, Response,
    ResponseBody,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use std::{future::Future, pin::Pin};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FileAsset {
    file: String,
    sha256: String,
    mime: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeUnit {
    file: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Engine {
    hermes_revision: String,
    abi: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Backend {
    runtime: String,
    bun_version: String,
    file: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ApplicationManifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    engine: Option<Engine>,
    native_unit: Option<NativeUnit>,
    backend: Option<Backend>,
    assets: BTreeMap<String, FileAsset>,
}
pub struct Application {
    pub unit_path: Option<PathBuf>,
    pub backend_path: Option<PathBuf>,
    manifest: ApplicationManifest,
    assets: BTreeMap<String, (String, Vec<u8>)>,
}
impl Application {
    pub fn id(&self) -> &str {
        &self.manifest.id
    }
}
pub fn checked_backend(path: &Path, hash: &str) -> Result<PathBuf> {
    use std::io::Read;
    let path = path.canonicalize()?;
    ensure!(
        path.metadata()?.len() <= 256 * 1024 * 1024,
        "Backend executable too large"
    );
    let mut input = std::fs::File::open(&path)?;
    let mut sha = Sha256::new();
    #[cfg(target_os = "linux")]
    {
        let mut header = [0; 4];
        input.read_exact(&mut header)?;
        ensure!(&header == b"\x7fELF", "Backend executable is not ELF");
        sha.update(header);
    }
    let mut bytes = [0; 65536];
    loop {
        let size = input.read(&mut bytes)?;
        if size == 0 {
            break;
        }
        sha.update(&bytes[..size]);
    }
    ensure!(
        format!("{:x}", sha.finalize()) == hash,
        "Backend executable hash mismatch"
    );
    Ok(path)
}
static APPLICATION: OnceLock<Application> = OnceLock::new();
pub fn application() -> Option<&'static Application> {
    APPLICATION.get()
}
fn checked_file(root: &Path, file: &str, hash: &str) -> Result<(PathBuf, Vec<u8>)> {
    ensure!(
        !file.is_empty()
            && Path::new(file)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
        "Invalid application file path"
    );
    let path = root.join(file).canonicalize()?;
    ensure!(path.starts_with(root), "Application file escapes package");
    ensure!(
        path.metadata()?.len() <= 16 * 1024 * 1024,
        "Application file too large"
    );
    let bytes = std::fs::read(&path)?;
    ensure!(
        format!("{:x}", Sha256::digest(&bytes)) == hash,
        "Application file hash mismatch: {file}"
    );
    Ok((path, bytes))
}
pub fn configure_application(root: &Path) -> Result<()> {
    let root = root.canonicalize()?;
    ensure!(
        root.join("app.json").metadata()?.len() <= 1_048_576,
        "Application manifest too large"
    );
    let manifest: ApplicationManifest =
        serde_json::from_slice(&std::fs::read(root.join("app.json"))?)?;
    ensure!(
        manifest.schema_version == 1,
        "Unsupported application format"
    );
    ensure!(
        !manifest.id.is_empty()
            && manifest.id.len() <= 200
            && manifest
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)),
        "Invalid application id"
    );
    ensure!(
        !manifest.name.is_empty() && manifest.name.len() <= 1024 && manifest.version.len() <= 100,
        "Invalid application metadata"
    );
    let unit_path = match (&manifest.engine, &manifest.native_unit) {
        (Some(engine), Some(unit)) => {
            ensure!(
                cfg!(feature = "aot"),
                "This JIT-only host cannot load native AOT applications; select an AOT-enabled host"
            );
            let build: serde_json::Value = serde_json::from_str(env!("WEBER_BUILD_INFO"))?;
            ensure!(
                engine.abi == env!("WEBER_AOT_ABI")
                    && engine.hermes_revision
                        == build["revisions"]["hermes"].as_str().unwrap_or(""),
                "Native application ABI mismatch; rebuild with this engine"
            );
            ensure!(unit.file == "app.so", "Unsupported native unit path");
            Some(checked_file(&root, &unit.file, &unit.sha256)?.0)
        }
        (None, None) => None,
        _ => anyhow::bail!("Native unit and engine metadata must be provided together"),
    };
    let backend_path = manifest
        .backend
        .as_ref()
        .map(|backend| -> Result<PathBuf> {
            ensure!(
                backend.runtime == "bun"
                    && !backend.bun_version.is_empty()
                    && backend.bun_version.len() <= 100
                    && backend.file == "backend",
                "Invalid backend executable metadata"
            );
            let path = root.join(&backend.file).canonicalize()?;
            ensure!(
                path.starts_with(&root),
                "Backend executable escapes package"
            );
            checked_backend(&path, &backend.sha256)
        })
        .transpose()?;
    ensure!(manifest.assets.len() <= 1024, "Too many application assets");
    let mut assets = BTreeMap::new();
    let mut total = 0;
    for (route, file) in &manifest.assets {
        ensure!(
            route.starts_with('/') && !route.contains(['?', '#']) && file.mime.len() <= 200,
            "Invalid asset route"
        );
        let (_, bytes) = checked_file(&root, &file.file, &file.sha256)?;
        total += bytes.len();
        ensure!(total <= 64 * 1024 * 1024, "Application assets too large");
        http::HeaderValue::from_str(&file.mime)?;
        assets.insert(route.clone(), (file.mime.clone(), bytes));
    }
    ensure!(
        assets.contains_key("/web.js"),
        "Application web comparison bundle missing"
    );
    APPLICATION
        .set(Application {
            unit_path,
            backend_path,
            manifest,
            assets,
        })
        .map_err(|_| anyhow::anyhow!("An application is already configured"))
}

fn application_asset(path: &str) -> Option<(String, Vec<u8>)> {
    let app = application()?;
    let javascript = "text/javascript; charset=utf-8".to_owned();
    match path {
        "/aot.html" | "/web.html" => {
            let web = path == "/web.html";
            let title = app.manifest.name.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
            let styles = app.assets.iter().filter(|(_, (mime, _))| mime.starts_with("text/css")).map(|(route, _)| format!("<link rel=\"stylesheet\" href=\"{}\">", route.replace('"', "%22"))).collect::<String>();
            let entry = if web { "<script src=\"/web.js\"></script>" } else { "<script src=\"/adapter.js\"></script>" };
            let native = crate::native::capability().map(|token| format!("<meta name=\"weber-native\" content=\"{token}\">" )).unwrap_or_default();
            let capability = crate::backend::capability().map(|token| format!("<meta name=\"weber-backend\" content=\"{token}\">" )).unwrap_or_default();
            Some(("text/html; charset=utf-8".to_owned(), format!("<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">{native}{capability}<title>{title}</title>{styles}<div id=\"aot-dom-root\"></div><script src=\"/config.js\"></script><script src=\"/diagnostics.js\"></script>{entry}<script src=\"/bootstrap.js\"></script>").into_bytes()))
        }
        "/adapter.js" => Some((javascript, [include_bytes!("wire.js").as_slice(), include_bytes!("dom_adapter.js").as_slice()].concat())),
        "/bootstrap.js" => Some((javascript, include_bytes!("application_bootstrap.js").to_vec())),
        "/diagnostics.js" => Some((javascript, include_bytes!("../sdk/diagnostics.mjs").to_vec())),
        "/config.js" => Some((javascript, format!("window.__weberApplication = {};", serde_json::json!({ "id": app.manifest.id, "test": std::env::var("WEBER_APP_TEST").as_deref() == Ok("1") })).into_bytes())),
        _ => app.assets.get(path).cloned(),
    }
}

pub struct DesktopAssets {
    pub benchmark: bool,
}

impl ProtocolHandler for DesktopAssets {
    fn privileged_paths(&self) -> &'static [&'static str] {
        if self.benchmark {
            &["//desktop/bench-aot.html", "//desktop/bench-web.html"]
        } else {
            &[]
        }
    }
    fn load<'a>(
        &'a self,
        request: &'a mut Request,
        _: &mut DoneChannel,
        _: &FetchContext,
    ) -> Pin<Box<dyn Future<Output = Response> + Send + 'a>> {
        let url = request.current_url();
        let mut response =
            Response::new(url.clone(), ResourceFetchTiming::new(request.timing_type()));
        let asset = if url.host_str() == Some("application") {
            application_asset(url.path())
        } else {
            (url.host_str() == Some("desktop"))
                .then(|| match url.path() {
                    "/aot.html" => Some(("text/html; charset=utf-8", html(false))),
                    "/web.html" => Some(("text/html; charset=utf-8", html(true))),
                    "/bench-aot.html" if self.benchmark => {
                        Some(("text/html; charset=utf-8", html(false)))
                    }
                    "/bench-web.html" if self.benchmark => {
                        Some(("text/html; charset=utf-8", html(true)))
                    }
                    "/config.js" => Some((
                        "text/javascript; charset=utf-8",
                        format!(
                            "window.__weberDesktopConfig = {};",
                            std::env::var("WEBER_DESKTOP_CONFIG")
                                .ok()
                                .and_then(
                                    |text| serde_json::from_str::<serde_json::Value>(&text).ok()
                                )
                                .unwrap_or(serde_json::Value::Null)
                        )
                        .into_bytes(),
                    )),
                    "/driver.js" => Some((
                        "text/javascript; charset=utf-8",
                        include_bytes!("desktop_driver.js").to_vec(),
                    )),
                    "/binding-contracts.js" => Some((
                        "text/javascript; charset=utf-8",
                        [
                            include_bytes!("wire.js").as_slice(),
                            include_bytes!("../aot/binding-contracts.js").as_slice(),
                        ]
                        .concat(),
                    )),
                    "/style-contracts.js" => Some((
                        "text/javascript; charset=utf-8",
                        include_bytes!("../aot/style-contracts.js").to_vec(),
                    )),
                    "/style.css" => Some((
                        "text/css; charset=utf-8",
                        include_bytes!("../app/src/style.css").to_vec(),
                    )),
                    "/adapter.js" => Some((
                        "text/javascript; charset=utf-8",
                        [
                            include_bytes!("wire.js").as_slice(),
                            include_bytes!("dom_adapter.js").as_slice(),
                        ]
                        .concat(),
                    )),
                    "/bootstrap.js" => Some((
                        "text/javascript; charset=utf-8",
                        include_bytes!("desktop_bootstrap.js").to_vec(),
                    )),
                    "/web.js" => Some((
                        "text/javascript; charset=utf-8",
                        include_bytes!("../target/desktop/web.js").to_vec(),
                    )),
                    _ => None,
                })
                .flatten()
                .map(|(mime, bytes)| (mime.to_owned(), bytes))
        };
        if let Some((mime, bytes)) = asset {
            response.headers.insert(
                http::header::CONTENT_TYPE,
                http::HeaderValue::from_str(&mime)
                    .unwrap_or_else(|_| http::HeaderValue::from_static("application/octet-stream")),
            );
            *response.body.lock() = ResponseBody::Done(bytes);
        } else {
            response.status = http::StatusCode::NOT_FOUND.into();
            *response.body.lock() = ResponseBody::Done(b"Desktop asset not found".to_vec());
        }
        Box::pin(std::future::ready(response))
    }
    fn is_fetchable(&self) -> bool {
        true
    }
    fn is_secure(&self) -> bool {
        true
    }
}

fn html(web: bool) -> Vec<u8> {
    let native = crate::native::capability()
        .map(|token| format!("<meta name=\"weber-native\" content=\"{token}\">"))
        .unwrap_or_default();
    let scripts = if web {
        "<script src=\"/web.js\"></script>"
    } else {
        "<script src=\"/adapter.js\"></script><script src=\"/bootstrap.js\"></script>"
    };
    let contracts = if std::env::var("WEBER_DESKTOP_CONFIG")
        .is_ok_and(|text| text.contains("binding-contracts"))
    {
        "<script src=\"/binding-contracts.js\"></script>"
    } else if std::env::var("WEBER_DESKTOP_CONFIG")
        .is_ok_and(|text| text.contains("style-contracts"))
    {
        "<script src=\"/style-contracts.js\"></script>"
    } else {
        ""
    };
    format!("<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">{native}<title>Weber</title><link rel=\"stylesheet\" href=\"/style.css\"></head><body><script src=\"/config.js\"></script><div id=\"aot-dom-root\"></div>{scripts}{contracts}<script src=\"/driver.js\"></script></body></html>").into_bytes()
}
