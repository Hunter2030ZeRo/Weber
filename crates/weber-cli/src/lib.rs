//! Backend selection is a project property, not a different frontend project.
use std::{path::{Path, PathBuf}, process::Command};
use serde::Deserialize;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Backend { Node, Bun, Native }
impl Backend {
    pub fn parse(value: &str) -> Result<Self> {
        match value { "node" => Ok(Self::Node), "bun" => Ok(Self::Bun), "native" => Ok(Self::Native),
            _ => Err("backend must be node, bun, or native".into()) }
    }
    pub fn name(self) -> &'static str {
        match self { Self::Node => "node", Self::Bun => "bun", Self::Native => "native" }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub backend: Backend,
    pub app: App,
    pub node: Option<JavaScript>,
    pub bun: Option<JavaScript>,
    pub native: Option<Native>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct App { pub frontend: PathBuf, #[serde(default)] pub channels: Vec<String> }
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JavaScript {
    pub entry: PathBuf,
    /// Optional absolute runtime path or executable name looked up on PATH.
    pub runtime: Option<PathBuf>,
    #[serde(default)] pub args: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Native { pub binary: PathBuf, #[serde(default)] pub args: Vec<String> }

#[derive(Debug)]
pub struct LaunchPlan {
    pub backend: Backend,
    pub project: PathBuf,
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub frontend: PathBuf,
    pub channels: Vec<String>,
}

fn project_file(root: &Path, path: &Path, label: &str) -> Result<PathBuf> {
    let resolved = root.join(path).canonicalize().map_err(|e| format!("{label}: {}: {e}", root.join(path).display()))?;
    if !resolved.starts_with(root) || !resolved.is_file() {
        return Err(format!("{label} must be a file inside the project directory"));
    }
    Ok(resolved)
}

pub fn parse_manifest(source: &str) -> Result<Manifest> {
    let manifest: Manifest = toml::from_str(source).map_err(|e| format!("Invalid weber.toml: {e}"))?;
    if manifest.schema != 1 { return Err(format!("Unsupported manifest schema: {}", manifest.schema)); }
    if manifest.app.channels.len() > 128 || manifest.app.channels.iter().any(|c| c.is_empty() || c.len() > 128) {
        return Err("app.channels must contain at most 128 nonempty channel names of at most 128 bytes".into());
    }
    Ok(manifest)
}

/// Resolve paths relative to weber.toml, independent of the launcher's cwd.
/// An explicit override changes this run only; it never rewrites the manifest.
pub fn load_plan(project: &Path, backend_override: Option<Backend>) -> Result<LaunchPlan> {
    let root = project.canonicalize().map_err(|e| format!("Project directory: {e}"))?;
    let source = std::fs::read_to_string(root.join("weber.toml")).map_err(|e| format!("weber.toml: {e}"))?;
    let manifest = parse_manifest(&source)?;
    let backend = backend_override.unwrap_or(manifest.backend);
    let frontend = project_file(&root, &manifest.app.frontend, "app.frontend")?;
    let (executable, arguments) = match backend {
        Backend::Node | Backend::Bun => {
            let config = if backend == Backend::Node { manifest.node } else { manifest.bun }
                .ok_or_else(|| format!("Missing [{}] configuration", backend.name()))?;
            let entry = project_file(&root, &config.entry, "backend entry")?;
            let runtime = config.runtime.unwrap_or_else(|| PathBuf::from(backend.name()));
            if runtime.as_os_str().is_empty() { return Err("runtime cannot be empty".into()); }
            // A bare name uses PATH. A relative path with directories is rooted
            // at the project, never at a caller's unrelated working directory.
            let runtime = if runtime.is_relative() && runtime.components().count() > 1 { root.join(runtime) } else { runtime };
            let mut arguments = vec![entry.to_string_lossy().into_owned()];
            arguments.extend(config.args);
            (runtime, arguments)
        }
        Backend::Native => {
            let config = manifest.native.ok_or("Missing [native] configuration")?;
            let mut binary = config.binary;
            if cfg!(windows) && binary.extension().is_none() { binary.set_extension("exe"); }
            (project_file(&root, &binary, "native.binary (build the native backend first)")?, config.args)
        }
    };
    Ok(LaunchPlan { backend, project: root, executable, arguments, frontend, channels: manifest.app.channels })
}

impl LaunchPlan {
    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(&self.arguments).current_dir(&self.project)
            .env("WEBER_PROJECT_DIR", &self.project)
            .env("WEBER_FRONTEND", &self.frontend)
            .env("WEBER_BACKEND", self.backend.name())
            .env("WEBER_ALLOWED_CHANNELS", serde_json::to_string(&self.channels).expect("string array is JSON"));
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    const CONFIG: &str = r#"
schema = 1
backend = "node"
[app]
frontend = "index.html"
channels = ["system.info"]
[node]
entry = "main.mjs"
args = ["space in one argument", "$(literal)"]
[bun]
entry = "main.mjs"
[native]
binary = "native-app"
"#;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("weber-cli-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir_all(&root).unwrap();
            for path in ["index.html", "main.mjs", "native-app", "native-app.exe"] { std::fs::write(root.join(path), "fixture").unwrap(); }
            std::fs::write(root.join("weber.toml"), CONFIG).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    #[test]
    fn switches_all_backends_without_modifying_project_or_frontend() {
        let fixture = Fixture::new();
        for backend in [Backend::Node, Backend::Bun, Backend::Native] {
            let plan = load_plan(&fixture.0, Some(backend)).unwrap();
            assert_eq!(plan.backend, backend);
            assert_eq!(plan.frontend, fixture.0.join("index.html").canonicalize().unwrap());
            assert_eq!(plan.channels, ["system.info"]);
        }
        assert_eq!(std::fs::read_to_string(fixture.0.join("weber.toml")).unwrap(), CONFIG);
    }
    #[test]
    fn selects_manifest_default_and_passes_arguments_without_a_shell() {
        let fixture = Fixture::new();
        let plan = load_plan(&fixture.0, None).unwrap();
        assert_eq!(plan.backend, Backend::Node);
        assert_eq!(&plan.arguments[1..], ["space in one argument", "$(literal)"]);
        let command = plan.command();
        assert_eq!(command.get_program(), "node");
        assert_eq!(command.get_current_dir(), Some(plan.project.as_path()));
        assert!(command.get_envs().any(|(k,v)| k == "WEBER_BACKEND" && v == Some(std::ffi::OsStr::new("node"))));
    }
    #[test]
    fn rejects_schema_backend_and_unknown_keys() {
        assert!(parse_manifest(&CONFIG.replace("schema = 1", "schema = 2")).is_err());
        assert!(parse_manifest(&CONFIG.replace("backend = \"node\"", "backend = \"python\"")).is_err());
        assert!(parse_manifest(&format!("typo = true\n{CONFIG}")).is_err());
    }
    #[test]
    fn missing_selected_backend_does_not_fall_back() {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("weber.toml"), CONFIG.split("[bun]").next().unwrap()).unwrap();
        assert!(load_plan(&fixture.0, Some(Backend::Bun)).unwrap_err().contains("Missing [bun]"));
    }
    #[test]
    fn unbuilt_native_backend_has_a_concrete_error() {
        let fixture = Fixture::new();
        std::fs::remove_file(fixture.0.join("native-app")).unwrap();
        std::fs::remove_file(fixture.0.join("native-app.exe")).unwrap();
        assert!(load_plan(&fixture.0, Some(Backend::Native)).unwrap_err().contains("build the native backend first"));
    }
    #[test]
    fn parses_full_toml_including_literal_paths() {
        let source = CONFIG.replace("entry = \"main.mjs\"", "entry = 'main.mjs' # ordinary TOML");
        assert_eq!(parse_manifest(&source).unwrap().node.unwrap().entry, PathBuf::from("main.mjs"));
    }
}
