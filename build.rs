fn main() -> Result<(), Box<dyn std::error::Error>> {
    for path in [
        "src",
        "vendor/stylo",
        "vendor/winit",
        "native",
        "aot",
        "patches",
        "compatibility",
        "scripts",
        "app/src",
        "sdk",
        "examples",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    let fingerprint = std::process::Command::new("node")
        .arg("scripts/source-fingerprint.mjs")
        .output()?;
    if !fingerprint.status.success() {
        return Err("Source fingerprint failed".into());
    }
    println!(
        "cargo:rustc-env=WEBER_BUILD_INFO={}",
        String::from_utf8(fingerprint.stdout)?.trim()
    );
    println!(
        "cargo:rustc-env=WEBER_COMPILE_PROFILE={}",
        std::env::var("PROFILE")?
    );
    if !std::process::Command::new("node")
        .args(["app/build-desktop.mjs", "--web-only"])
        .status()?
        .success()
    {
        return Err("Desktop web bundle failed".into());
    }
    #[cfg(feature = "aot")]
    {
        build_aot()
    }
    #[cfg(not(feature = "aot"))]
    {
        println!("cargo:rustc-env=WEBER_AOT_ABI=unavailable");
        println!("cargo:rustc-env=WEBER_NATIVE_OPT=none");
        Ok(())
    }
}

#[cfg(feature = "aot")]
fn build_aot() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=src/aot.rs");
    println!("cargo:rerun-if-changed=native/hermes.hpp");
    println!("cargo:rerun-if-changed=native/hermes.cpp");
    println!("cargo:rerun-if-changed=aot/logic.js");
    println!("cargo:rerun-if-changed=aot/dom.js");
    println!("cargo:rerun-if-changed=aot/browser-events.js");
    println!("cargo:rerun-if-changed=aot/browser-dom.js");
    println!("cargo:rerun-if-changed=aot/browser-contracts.js");
    for path in [
        "aot/browser-selectors.js",
        "aot/browser-observers.js",
        "aot/browser-tokens.js",
        "aot/browser-collections.js",
        "aot/browser-html.js",
        "aot/solid-contracts.js",
        "aot/browser-scheduler.js",
        "aot/scheduler-contracts.js",
        "aot/wpt-runner.js",
        "aot/browser-attributes.js",
        "aot/browser-live.js",
        "aot/browser-resize.js",
        "aot/browser-fetch.js",
        "aot/profile-contracts.js",
        "app/build-wpt.mjs",
        "compatibility/profile.json",
        "compatibility/profile.sha256",
        "app/platform.mjs",
        "app/build-platform.mjs",
        "app/build-solid.mjs",
        "app/src/aot-solid.tsx",
        "app/src/aot-web.ts",
        "app/src/compatibility-app.tsx",
        "app/pnpm-lock.yaml",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-changed=target/hermes/bin/shermes");
    println!("cargo:rerun-if-changed=vendor/hermes/include/hermes/VM/sh_runtime.h");
    let root = std::env::current_dir()?;
    let abi = std::process::Command::new("node")
        .arg("scripts/aot-abi.mjs")
        .output()?;
    if !abi.status.success() {
        return Err("AOT ABI fingerprint failed".into());
    }
    println!(
        "cargo:rustc-env=WEBER_AOT_ABI={}",
        String::from_utf8(abi.stdout)?.trim()
    );
    let platform = std::process::Command::new("node")
        .arg("app/build-platform.mjs")
        .status()?;
    if !platform.success() {
        return Err("Web platform library bundle failed".into());
    }
    if !std::process::Command::new("node")
        .arg("app/build-solid.mjs")
        .status()?
        .success()
    {
        return Err("Solid AOT application bundle failed".into());
    }
    if !std::process::Command::new("node")
        .arg("app/build-desktop.mjs")
        .status()?
        .success()
    {
        return Err("Desktop bundles failed".into());
    }
    let object = std::path::PathBuf::from(std::env::var_os("OUT_DIR").ok_or("OUT_DIR missing")?)
        .join("logic.o");
    let platform_object = object.with_file_name("platform.o");
    let platform_source = object.with_file_name("platform.js");
    // SHRuntime's layout is compiled into every native unit, so changing its
    // header invalidates the generated object even when JS is identical.
    let bundle = (std::fs::read_to_string("target/platform.js")?
        + "\n/* SHRuntime ABI\n"
        + &std::fs::read("vendor/hermes/include/hermes/VM/sh_runtime.h")?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
        + "\n*/\n")
        .into_bytes();
    std::fs::write(&platform_source, &bundle)?;
    let optimization = if std::env::var("PROFILE").as_deref() == Ok("release") {
        "O3"
    } else {
        "O0"
    };
    println!("cargo:rustc-env=WEBER_NATIVE_OPT={optimization}");
    println!(
        "cargo:rustc-env=WEBER_COMPILE_PROFILE={}",
        std::env::var("PROFILE")?
    );
    if !std::process::Command::new("node")
        .arg("app/compile-aot.mjs")
        .arg(&platform_source)
        .arg(&platform_object)
        .args(["weber_platform", optimization])
        .status()?
        .success()
    {
        return Err("Platform native compilation failed".into());
    }
    let source = object.with_extension("js");
    std::fs::write(
        &source,
        [
            "src/wire.js",
            "aot/dom.js",
            "aot/browser-events.js",
            "aot/browser-collections.js",
            "aot/browser-selectors.js",
            "aot/browser-observers.js",
            "aot/browser-tokens.js",
            "aot/browser-attributes.js",
            "aot/browser-live.js",
            "aot/browser-style.js",
            "aot/style-contracts.js",
            "aot/binding-contracts.js",
            "aot/browser-resize.js",
            "aot/browser-fetch.js",
            "aot/browser-node-registry.js",
            "aot/browser-dom.js",
            "aot/browser-html.js",
            "aot/browser-scheduler.js",
            "aot/browser-contracts.js",
            "aot/logic.js",
            "aot/solid-contracts.js",
            "aot/scheduler-contracts.js",
            "aot/wpt-runner.js",
            "aot/profile-contracts.js",
            "aot/lifetime-contracts.js",
            "target/solid/solid.js",
            "target/desktop/aot.js",
        ]
        .into_iter()
        .map(std::fs::read_to_string)
        .collect::<Result<Vec<_>, _>>()?
        .join("\n")
            + "\nglobalThis.WeberSolid = WeberSolid; globalThis.WeberDesktop = WeberDesktop;\n",
    )?;
    let status = std::process::Command::new("node")
        .arg("app/compile-aot.mjs")
        .arg(&source)
        .arg(&object)
        .args(["weber_logic", "O3"])
        .status()?;
    if !status.success() {
        return Err("Static Hermes native compilation failed".into());
    }
    let wpt_dir = object.with_file_name("wpt");
    if !std::process::Command::new("node")
        .arg("app/build-wpt.mjs")
        .arg(&wpt_dir)
        .status()?
        .success()
    {
        return Err("Locked WPT native compilation failed".into());
    }
    cxx_build::bridge("src/aot.rs")
        .file("native/hermes.cpp")
        .include(".")
        .include("vendor/hermes/include")
        .include("vendor/hermes/public")
        .include("vendor/hermes/API")
        .include("vendor/hermes/API/jsi")
        .include("target/hermes/lib/config")
        .include(&wpt_dir)
        .std("c++17")
        .compile("weber_aot");
    println!("cargo:rustc-link-arg={}", object.display());
    println!("cargo:rustc-link-arg={}", platform_object.display());
    for object in std::fs::read_to_string(wpt_dir.join("wpt-objects.txt"))?.lines() {
        println!("cargo:rustc-link-arg={object}");
    }
    println!(
        "cargo:rustc-link-search=native={}/target/hermes/lib",
        root.display()
    );
    println!(
        "cargo:rustc-link-search=native={}/target/hermes/jsi",
        root.display()
    );
    println!("cargo:rustc-link-lib=dylib=hermesvm");
    println!("cargo:rustc-link-lib=dylib=jsi");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/lib:$ORIGIN/../hermes/lib");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/lib:$ORIGIN/../hermes/jsi");
    Ok(())
}
