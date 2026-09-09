use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use weber_runtime_config::{load_plan, load_runtime_plan, parse_invocation, parse_manifest, BackendKind, Invocation};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "weber-config-test-{}-{}",
            std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(path.join("tools")).unwrap();
        let path = path.canonicalize().unwrap();
        std::fs::write(path.join("main script.js"), "// entry point fixture").unwrap();
        Self(path)
    }

    fn write(&self, manifest: &str) {
        std::fs::write(self.0.join("weber.toml"), manifest).unwrap();
    }

    fn install_probe(&self) -> String {
        let relative = format!("tools/probe{}", std::env::consts::EXE_SUFFIX);
        std::fs::copy(probe_binary(), self.0.join(&relative)).unwrap();
        relative
    }

    fn install_runtime(&self) -> PathBuf {
        let runtime = self.0.join("electron-runtime");
        std::fs::create_dir_all(runtime.join("bin")).unwrap();
        std::fs::write(runtime.join("bootstrap.cjs"), "// bootstrap argument fixture").unwrap();
        for name in ["weber-desktop-host", "weber-obscura-renderer"] {
            std::fs::copy(probe_binary(), runtime.join("bin").join(format!("{name}{}", std::env::consts::EXE_SUFFIX))).unwrap();
        }
        runtime
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// A compiled executable avoids depending on Node, Bun, Python or a command shell
// to verify the launcher. It deliberately does not claim Electron integration.
fn probe_binary() -> &'static Path {
    static PROBE: OnceLock<PathBuf> = OnceLock::new();
    PROBE.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("weber-launch-probe-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("probe.rs");
        std::fs::write(&source, r#"
fn main() {
    println!("args={:?}", std::env::args_os().skip(1).collect::<Vec<_>>());
    println!("cwd={:?}", std::env::current_dir().unwrap());
    println!("backend={}", std::env::var("WEBER_BACKEND").unwrap());
    println!("project={:?}", std::env::var_os("WEBER_PROJECT_DIR").unwrap());
    if let Some(marker) = std::env::var_os("WEBER_TEST_MARKER") {
        std::fs::write(marker, "started").unwrap();
    }
    #[cfg(unix)]
    if std::env::var_os("WEBER_TEST_SIGNAL").is_some() {
        extern "C" { fn raise(signal: i32) -> i32; }
        unsafe { raise(15); }
    }
    std::process::exit(std::env::var("WEBER_TEST_EXIT").unwrap_or_else(|_| "0".into()).parse().unwrap());
}
"#).unwrap();
        let binary = root.join(format!("probe{}", std::env::consts::EXE_SUFFIX));
        let output = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .arg("--edition=2021").arg(&source).arg("-o").arg(&binary)
            .output().unwrap();
        assert!(output.status.success(), "probe compilation: {}", String::from_utf8_lossy(&output.stderr));
        binary
    }).as_path()
}

#[test]
fn ordinary_toml_and_one_option_switch_between_node_and_bun() {
    let project = Project::new();
    let source = "[backend]\nkind = 'node' # switch to bun here\nentry = 'main script.js'\nargs = ['space in one argument', '$(literal)', '']\n";
    project.write(source);
    for (kind, expected) in [("node", BackendKind::Node), ("bun", BackendKind::Bun)] {
        project.write(&source.replace("kind = 'node'", &format!("kind = '{kind}'")));
        let plan = load_plan(&project.0, &[]).unwrap();
        assert_eq!(plan.backend, expected);
        assert_eq!(plan.executable, PathBuf::from(kind));
        assert_eq!(plan.arguments[0], project.0.join("main script.js").as_os_str());
        assert_eq!(&plan.arguments[1..], ["space in one argument", "$(literal)", ""]);
    }
}

#[test]
fn rejects_invalid_or_ambiguous_configuration() {
    for source in [
        "[backend]\nkind='python'\nentry='main.js'",
        "[backend]\nkind='node'",
        "[backend]\nkind='bun'\nentry=''",
        "[backend]\nkind='node'\nentry='main.js'\nexecutable=''",
        "[backend]\nkind='node'\nentry='main.js'\narg=['typo']",
        "[backend]\nkind='native'",
        "[backend]\nkind='native'\nentry='a'\nexecutable='b'",
        "[backend]\nkind='native'\nexecutable='a'\nruntime_args=['--flag']",
        "schema=2\n[backend]\nkind='native'\nexecutable='a'",
        "schema=1\n[backend]\nkind='native'\nkind='node'\nexecutable='a'",
    ] {
        assert!(parse_manifest(source).is_err(), "accepted {source}");
    }
}

#[test]
fn native_entry_shorthand_and_missing_files_have_specific_errors() {
    let project = Project::new();
    project.write("[backend]\nkind='native'\nentry='missing-program'");
    assert!(load_plan(&project.0, &[]).unwrap_err().to_string().contains("build it first"));
    project.write("[backend]\nkind='node'\nentry='missing.js'");
    assert!(load_plan(&project.0, &[]).unwrap_err().to_string().contains("backend.entry"));
    project.write("[backend]\nkind='node'\nentry='tools'");
    assert!(load_plan(&project.0, &[]).unwrap_err().to_string().contains("must be a file"));
    let probe = project.install_probe();
    project.write(&format!("[backend]\nkind='native'\nentry='{probe}'"));
    assert_eq!(load_plan(&project.0, &[]).unwrap().executable, project.0.join(probe));
}

#[test]
fn launching_all_backends_preserves_argv_cwd_environment_and_exit_status() {
    let project = Project::new();
    let executable = project.install_probe();
    for backend in ["node", "bun", "native"] {
        let javascript = backend != "native";
        let entry = if javascript { "entry='main script.js'\nruntime_args=['--runtime-option']\n" } else { "" };
        project.write(&format!("[backend]\nkind='{backend}'\nexecutable='{executable}'\n{entry}args=['space in one argument', '$(do-not-execute)', '']"));
        let forwarded = [OsString::from("--literal-flag"), OsString::from("a;b")];
        let plan = load_plan(&project.0, &forwarded).unwrap();
        let output = plan.command().env("WEBER_TEST_EXIT", "37").output().unwrap();
        assert_eq!(output.status.code(), Some(37));
        let mut expected: Vec<OsString> = Vec::new();
        if javascript {
            expected.push("--runtime-option".into());
            expected.push(project.0.join("main script.js").into_os_string());
        }
        expected.extend(["space in one argument", "$(do-not-execute)", "", "--literal-flag", "a;b"].map(OsString::from));
        assert_eq!(String::from_utf8(output.stdout).unwrap(), format!(
            "args={expected:?}\ncwd={:?}\nbackend={backend}\nproject={:?}\n", project.0, project.0.as_os_str()
        ));
    }
}

#[test]
fn cli_check_does_not_launch_and_run_returns_backend_exit_code() {
    let project = Project::new();
    let executable = project.install_probe();
    let runtime = project.install_runtime();
    project.write(&format!("[backend]\nkind='native'\nexecutable='{executable}'"));
    let marker = project.0.join("started");
    let cli = env!("CARGO_BIN_EXE_weber-backend");
    let check = Command::new(cli).args(["check", "--project"]).arg(&project.0)
        .arg("--runtime-root").arg(&runtime)
        .env("WEBER_TEST_MARKER", &marker).output().unwrap();
    assert!(check.status.success());
    assert!(!marker.exists());
    let run = Command::new(cli).args(["run", "--project"]).arg(&project.0)
        .arg("--runtime-root").arg(&runtime)
        .args(["--", "--application-option", "space in one argument", ""])
        .env("WEBER_TEST_MARKER", &marker).env("WEBER_TEST_EXIT", "41")
        .output().unwrap();
    assert_eq!(run.status.code(), Some(41));
    assert!(marker.is_file());
    assert!(String::from_utf8(run.stdout).unwrap().contains("args=[\"--application-option\", \"space in one argument\", \"\"]"));
}

#[test]
fn cli_reports_missing_runtime_without_fallback() {
    let project = Project::new();
    let runtime = project.install_runtime();
    project.write("[backend]\nkind='bun'\nentry='main script.js'\nexecutable='weber-test-runtime-that-does-not-exist'");
    let output = Command::new(env!("CARGO_BIN_EXE_weber-backend"))
        .args(["run", "--project"]).arg(&project.0)
        .arg("--runtime-root").arg(runtime).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8(output.stderr).unwrap().contains("Cannot launch bun backend"));
}

#[test]
fn launcher_requires_separator_before_application_options() {
    assert!(parse_invocation(["run", "--foo"].map(OsString::from)).is_err());
    assert!(parse_invocation(["run", "--project"].map(OsString::from)).is_err());
    let invocation = parse_invocation(["run", "--project", "space in path", "--", "--project", "application value"].map(OsString::from)).unwrap();
    match invocation {
        Invocation::Run { project, runtime_root, forwarded } => {
            assert_eq!(project, PathBuf::from("space in path"));
            assert_eq!(runtime_root, None);
            assert_eq!(forwarded, ["--project", "application value"]);
        }
        _ => panic!("expected run"),
    }
}

#[cfg(unix)]
#[test]
fn unix_cli_preserves_non_utf8_arguments_and_signal_status() {
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::process::ExitStatusExt;
    let project = Project::new();
    let executable = project.install_probe();
    let runtime = project.install_runtime();
    project.write(&format!("[backend]\nkind='native'\nexecutable='{executable}'"));
    let argument = OsString::from_vec(vec![b'a', 0xff, b'b']);
    let output = Command::new(env!("CARGO_BIN_EXE_weber-backend"))
        .args(["run", "--project"]).arg(&project.0)
        .arg("--runtime-root").arg(&runtime).arg("--").arg(&argument)
        .output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout).unwrap().starts_with(&format!("args={:?}\n", [argument])));
    let signaled = Command::new(env!("CARGO_BIN_EXE_weber-backend"))
        .args(["run", "--project"]).arg(&project.0)
        .arg("--runtime-root").arg(&runtime)
        .env("WEBER_TEST_SIGNAL", "1").output().unwrap();
    assert_eq!(signaled.status.signal(), Some(15));
}

#[test]
fn gui_plan_injects_bootstrap_for_node_and_bun_and_keeps_native_direct() {
    let project = Project::new();
    let executable = project.install_probe();
    let runtime = project.install_runtime();
    for kind in ["node", "bun"] {
        project.write(&format!("[backend]\nkind='{kind}'\nentry='main script.js'\nexecutable='{executable}'\nruntime_args=['--runtime-option']\nargs=['config argument']"));
        let forwarded = [OsString::from("user argument")];
        let plan = load_runtime_plan(&project.0, &forwarded, Some(&runtime)).unwrap();
        assert_eq!(plan.arguments, vec![
            OsString::from("--runtime-option"), runtime.join("bootstrap.cjs").into_os_string(),
            project.0.clone().into_os_string(), "config argument".into(), "user argument".into(),
        ]);
        let command = plan.command();
        assert!(command.get_envs().any(|(key, value)| key == "WEBER_ENTRY"
            && value == Some(project.0.join("main script.js").as_os_str())));
        for variable in ["WEBER_DESKTOP_HOST", "WEBER_OBSCURA_RENDERER"] {
            assert!(command.get_envs().any(|(key, value)| key == variable
                && value.is_some_and(|path| Path::new(path).is_absolute())));
        }
        let output = Command::new(env!("CARGO_BIN_EXE_weber-backend"))
            .args(["run", "--project"]).arg(&project.0)
            .arg("--runtime-root").arg(&runtime).arg("--").arg("user argument")
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8(output.stdout).unwrap().starts_with(&format!("args={:?}\n", plan.arguments)));
    }
    project.write(&format!("[backend]\nkind='native'\nexecutable='{executable}'\nargs=['native argument']"));
    let plan = load_runtime_plan(&project.0, &[], Some(&runtime)).unwrap();
    assert_eq!(plan.arguments, ["native argument"]);
    assert!(plan.environment.iter().all(|(key, _)| key != "WEBER_ENTRY"));
}
