//! Parse a project's backend selection without requiring Node.js or Bun.
//!
//! The GUI launch path starts the Electron-derived bootstrap for Node/Bun, or a
//! native program directly, and supplies the shared desktop host/renderer paths.

use serde::Deserialize;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Node,
    Bun,
    Native,
}

impl BackendKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Bun => "bun",
            Self::Native => "native",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    #[serde(default = "schema_version")]
    pub schema: u32,
    pub backend: BackendConfig,
}

const fn schema_version() -> u32 {
    1
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackendConfig {
    pub kind: BackendKind,
    /// JavaScript entry, or a shorthand for a native executable.
    pub entry: Option<PathBuf>,
    /// Node/Bun runtime, or the native application binary.
    pub executable: Option<PathBuf>,
    /// Arguments before a Node/Bun entry point; invalid for native backends.
    #[serde(default)]
    pub runtime_args: Vec<String>,
    /// Application arguments, followed by arguments supplied to the launcher.
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug)]
pub struct LaunchPlan {
    pub backend: BackendKind,
    pub project: PathBuf,
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub entry: Option<PathBuf>,
    pub environment: Vec<(OsString, OsString)>,
    runtime_argument_count: usize,
}

pub fn parse_manifest(source: &str) -> Result<Manifest> {
    let manifest: Manifest = toml::from_str(source)
        .map_err(|error| Error(format!("Invalid weber.toml: {error}")))?;
    if manifest.schema != 1 {
        return Err(Error(format!(
            "Unsupported weber.toml schema {}; expected 1",
            manifest.schema
        )));
    }
    for (label, value) in [
        ("backend.entry", &manifest.backend.entry),
        ("backend.executable", &manifest.backend.executable),
    ] {
        if value.as_ref().is_some_and(|path| path.as_os_str().is_empty()) {
            return Err(Error(format!("{label} cannot be empty")));
        }
    }
    let config = &manifest.backend;
    match config.kind {
        BackendKind::Node | BackendKind::Bun if config.entry.is_none() => {
            return Err(Error(format!(
                "backend.entry is required for the {} backend",
                config.kind.name()
            )));
        }
        BackendKind::Native => {
            if config.entry.is_some() == config.executable.is_some() {
                return Err(Error(
                    "native backend requires exactly one of backend.executable or backend.entry"
                        .into(),
                ));
            }
            if !config.runtime_args.is_empty() {
                return Err(Error(
                    "backend.runtime_args is only supported for node and bun; use backend.args for native"
                        .into(),
                ));
            }
        }
        _ => {}
    }
    Ok(manifest)
}

fn existing_file(project: &Path, path: &Path, label: &str) -> Result<PathBuf> {
    let path = project.join(path);
    let resolved = path
        .canonicalize()
        .map_err(|error| Error(format!("{label} ({}): {error}", path.display())))?;
    if !resolved.is_file() {
        return Err(Error(format!("{label} must be a file: {}", path.display())));
    }
    Ok(resolved)
}

/// Resolve all project paths from the directory containing `weber.toml`.
/// Bare Node/Bun executable names use PATH; native binaries are project paths.
/// No command string, shell expansion, backend fallback, or lossy argument
/// conversion is used. Absolute paths are supported as deliberate overrides.
pub fn load_plan(project: &Path, forwarded: &[OsString]) -> Result<LaunchPlan> {
    let project = project
        .canonicalize()
        .map_err(|error| Error(format!("Project directory ({}): {error}", project.display())))?;
    if !project.is_dir() {
        return Err(Error(format!("Project is not a directory: {}", project.display())));
    }
    let manifest_path = project.join("weber.toml");
    let source = std::fs::read_to_string(&manifest_path)
        .map_err(|error| Error(format!("{}: {error}", manifest_path.display())))?;
    let manifest = parse_manifest(&source)?;
    let config = manifest.backend;
    let mut arguments = Vec::<OsString>::new();
    let mut entry_path = None;
    let runtime_argument_count = config.runtime_args.len();
    let executable = match config.kind {
        BackendKind::Node | BackendKind::Bun => {
            let entry = existing_file(
                &project,
                config.entry.as_deref().expect("validated JavaScript entry"),
                "backend.entry",
            )?;
            let runtime = config
                .executable
                .unwrap_or_else(|| PathBuf::from(config.kind.name()));
            // Path components distinguish ./node and bin/node from a PATH name.
            let runtime = if runtime.is_absolute() || runtime.components().count() > 1 {
                existing_file(&project, &runtime, "backend.executable")?
            } else {
                runtime
            };
            arguments.extend(config.runtime_args.into_iter().map(OsString::from));
            entry_path = Some(entry.clone());
            arguments.push(entry.into_os_string());
            runtime
        }
        BackendKind::Native => existing_file(
            &project,
            config.executable.as_deref().or(config.entry.as_deref())
                .expect("validated native executable"),
            "native backend executable (build it first)",
        )?,
    };
    arguments.extend(config.args.into_iter().map(OsString::from));
    arguments.extend_from_slice(forwarded);
    Ok(LaunchPlan {
        backend: config.kind,
        project,
        executable,
        arguments,
        entry: entry_path,
        environment: Vec::new(),
        runtime_argument_count,
    })
}

fn runtime_directory(requested: Option<&Path>) -> Result<Option<PathBuf>> {
    let path = requested.map(PathBuf::from)
        .or_else(|| std::env::var_os("WEBER_RUNTIME_ROOT").map(PathBuf::from));
    if let Some(path) = path {
        let path = path.canonicalize().map_err(|error| Error(format!(
            "Weber runtime directory ({}): {error}", path.display()
        )))?;
        if !path.is_dir() { return Err(Error("Weber runtime root must be a directory".into())); }
        return Ok(Some(path));
    }
    // An installed launcher may place its electron-runtime bundle alongside it.
    Ok(std::env::current_exe().ok().and_then(|path| path.parent().map(|parent| parent.join("electron-runtime")))
        .filter(|path| path.is_dir()))
}

fn runtime_binary(root: Option<&Path>, variable: &str, filename: &str, development: &str) -> Result<PathBuf> {
    if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
        if !path.is_absolute() { return Err(Error(format!("{variable} must be an absolute path"))); }
        return existing_file(Path::new("."), &path, variable);
    }
    if let Some(root) = root {
        let bundled = root.join("bin").join(format!("{filename}{}", std::env::consts::EXE_SUFFIX));
        if bundled.is_file() { return existing_file(root, &bundled, variable); }
        // Source checkout: <repo>/weber/electron-runtime, with CMake output in
        // <repo>/out/runtime. Installed bundles should use bin/ or env overrides.
        if let Some(repo) = root.parent().and_then(Path::parent) {
            let source_build = repo.join(development);
            if source_build.is_file() { return existing_file(root, &source_build, variable); }
        }
    }
    Err(Error(format!("{variable} is required; build Weber and set its absolute executable path")))
}

/// Prepare an actual Weber GUI application launch. Node/Bun execute
/// bootstrap.cjs PROJECT with WEBER_ENTRY; native applications receive the same
/// desktop host/renderer paths but execute directly without a JavaScript VM.
pub fn load_runtime_plan(project: &Path, forwarded: &[OsString], requested_runtime: Option<&Path>) -> Result<LaunchPlan> {
    let mut plan = load_plan(project, forwarded)?;
    let runtime = runtime_directory(requested_runtime)?;
    let host = runtime_binary(runtime.as_deref(), "WEBER_DESKTOP_HOST", "weber-desktop-host",
        "out/runtime/weber-desktop-host")?;
    let renderer = runtime_binary(runtime.as_deref(), "WEBER_OBSCURA_RENDERER", "weber-obscura-renderer",
        "out/runtime/obscura/weber-obscura-renderer")?;
    plan.environment.extend([
        ("WEBER_DESKTOP_HOST".into(), host.into_os_string()),
        ("WEBER_OBSCURA_RENDERER".into(), renderer.into_os_string()),
    ]);
    if let Some(entry) = &plan.entry {
        let runtime = runtime.ok_or_else(|| Error(
            "Node/Bun require --runtime-root, WEBER_RUNTIME_ROOT, or an adjacent electron-runtime bundle".into()
        ))?;
        let bootstrap = existing_file(&runtime, Path::new("bootstrap.cjs"), "Weber bootstrap (build electron-runtime first)")?;
        let index = plan.runtime_argument_count;
        plan.arguments.splice(index..index + 1, [bootstrap.into_os_string(), plan.project.clone().into_os_string()]);
        plan.environment.push(("WEBER_ENTRY".into(), entry.clone().into_os_string()));
        plan.environment.push(("WEBER_RUNTIME_ROOT".into(), runtime.into_os_string()));
    }
    Ok(plan)
}

impl LaunchPlan {
    /// Build a reusable process command. The GUI runtime can add its inherited
    /// IPC descriptors and bootstrap environment before spawning or executing.
    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(&self.arguments)
            .current_dir(&self.project)
            .env("WEBER_PROJECT_DIR", &self.project)
            .env("WEBER_BACKEND", self.backend.name())
            .envs(self.environment.iter().map(|(key, value)| (key, value)));
        command
    }

    pub fn launch_error(&self, error: std::io::Error) -> Error {
        Error(format!(
            "Cannot launch {} backend ({}): {error}",
            self.backend.name(),
            self.executable.display()
        ))
    }
}

/// Parse launcher options using OS strings so application paths and arguments
/// survive unchanged even when they are not valid UTF-8 on Unix.
#[derive(Debug)]
pub enum Invocation {
    Help,
    Run { project: PathBuf, runtime_root: Option<PathBuf>, forwarded: Vec<OsString> },
    Check { project: PathBuf, runtime_root: Option<PathBuf>, forwarded: Vec<OsString> },
}

pub fn parse_invocation(arguments: impl IntoIterator<Item = OsString>) -> Result<Invocation> {
    let mut arguments = arguments.into_iter();
    let operation = arguments.next().unwrap_or_else(|| OsString::from("--help"));
    if operation == "--help" || operation == "-h" {
        return Ok(Invocation::Help);
    }
    if operation != "run" && operation != "check" {
        return Err(Error("Expected run or check; see weber-backend --help".into()));
    }
    let mut project = PathBuf::from(".");
    let mut runtime_root = None;
    let mut forwarded = Vec::new();
    while let Some(argument) = arguments.next() {
        if argument == OsStr::new("--") {
            forwarded.extend(arguments);
            break;
        } else if argument == OsStr::new("--project") {
            project = arguments.next().map(PathBuf::from)
                .ok_or_else(|| Error("--project needs a directory".into()))?;
        } else if argument == OsStr::new("--runtime-root") {
            runtime_root = Some(arguments.next().map(PathBuf::from)
                .ok_or_else(|| Error("--runtime-root needs a directory".into()))?);
        } else {
            return Err(Error(format!(
                "Unknown launcher argument {argument:?}; put application arguments after --"
            )));
        }
    }
    if operation == "run" {
        Ok(Invocation::Run { project, runtime_root, forwarded })
    } else {
        Ok(Invocation::Check { project, runtime_root, forwarded })
    }
}
