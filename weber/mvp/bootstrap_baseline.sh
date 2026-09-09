#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}" "${GITHUB_SHA:?}"
build_root="$RUNNER_TEMP/weber-full-build"
depot_root="$RUNNER_TEMP/weber-depot-tools"
mkdir -p "$build_root/src"
git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$depot_root"
export PATH="$depot_root:$PATH"
export DEPOT_TOOLS_UPDATE=0
# Keep the audited Electron checkout at the exact workflow commit.
git worktree add --detach "$build_root/src/electron" "$GITHUB_SHA"
cat > "$build_root/.gclient" <<'GCLIENT'
solutions = [{
    'name': 'src/electron',
    'url': 'https://github.com/Hunter2030ZeRo/Weber.git',
    'managed': False,
    'deps_file': 'DEPS',
    'custom_deps': {},
    'custom_vars': {},
}]
GCLIENT
cd "$build_root"
gclient sync --no-history --nohooks -j 4
cd src
gclient runhooks
gn gen out/WeberBaseline --args='import("//electron/build/args/testing.gn") use_remoteexec=false use_siso=false symbol_level=0 blink_symbol_level=0'
gn desc out/WeberBaseline //electron:electron deps --all > "$GITHUB_WORKSPACE/electron-baseline-dependencies.txt"
printf '%s\n' 'Full Electron dependency sync and GN generation completed. This is not an Electron build or an Obscura MVP result.' >> "$GITHUB_STEP_SUMMARY"
