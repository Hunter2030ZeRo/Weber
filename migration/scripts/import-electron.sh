#!/usr/bin/env bash
set -euo pipefail
# Run only in an authorized GitHub Actions checkout of Weber.
: "${GITHUB_SHA:?}" "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}"
upstream=c1aad3df47dcae19bad6d12157c7f06ad72ea409
branch=codex/electron-obscura
fork_dir="$RUNNER_TEMP/weber-electron-fork"
# Never overwrite an existing migration branch. This importer runs once.
existing=$(git ls-remote origin "refs/heads/$branch")
if [[ -n "$existing" ]]; then
  echo 'Migration branch already exists; refusing to overwrite it.' >&2
  exit 1
fi
git fetch --no-tags https://github.com/electron/electron.git "$upstream"
test "$(git rev-parse FETCH_HEAD)" = "$upstream"
git worktree add --detach "$fork_dir" "$upstream"
test ! -e "$fork_dir/weber"
mkdir "$fork_dir/weber"
git archive "$GITHUB_SHA" | tar -x -C "$fork_dir/weber"
# Preserve upstream CI as reference without activating Electron release workflows.
if [[ -d "$fork_dir/.github/workflows" ]]; then
  mv "$fork_dir/.github/workflows" "$fork_dir/weber/upstream-electron-workflows"
fi
mkdir -p "$fork_dir/shell/renderer/obscura"
cp -R "$fork_dir/weber/migration/shell/renderer/obscura/." "$fork_dir/shell/renderer/obscura/"
cp "$fork_dir/README.md" "$fork_dir/README.electron.md"
cp "$fork_dir/weber/migration/README.md" "$fork_dir/README.md"
cat >> "$fork_dir/.gitmodules" <<'MODULE'

[submodule "weber/vendor/obscura"]
    path = weber/vendor/obscura
    url = https://github.com/Hunter2030ZeRo/obscura-for-weber.git
MODULE
printf '%s\n' "electron=$upstream" "weber=$GITHUB_SHA" 'obscura=727cc46d56290995245fbe790caed52fc699452a' > "$fork_dir/weber/UPSTREAM_REVISIONS"
git -C "$fork_dir" add -A
git -C "$fork_dir" update-index --add --cacheinfo 160000,727cc46d56290995245fbe790caed52fc699452a,weber/vendor/obscura
git -C "$fork_dir" submodule update --init --depth 1 weber/vendor/obscura
# Compile and exercise the adapter from its final location in the Electron tree.
# Reuse the original checkout's Cargo cache without changing its lockfile.
export CARGO_TARGET_DIR="$GITHUB_WORKSPACE/target"
cargo build --release --manifest-path "$fork_dir/weber/Cargo.toml" -p weber-engine
cmake -S "$fork_dir/shell/renderer/obscura" -B "$RUNNER_TEMP/obscura-boundary" -DWEBER_ENGINE_LIBRARY="$CARGO_TARGET_DIR/release/libweber_engine.so"
cmake --build "$RUNNER_TEMP/obscura-boundary" --parallel 2
ctest --test-dir "$RUNNER_TEMP/obscura-boundary" --output-on-failure
# Both Electron ancestry and Weber development history remain reachable.
# Only staged source is committed; build outputs/lockfiles are not staged here.
tree=$(git -C "$fork_dir" write-tree)
git config user.name 'Weber development'
git config user.email '79967736+Hunter2030ZeRo@users.noreply.github.com'
commit=$(git commit-tree "$tree" -p "$upstream" -p "$GITHUB_SHA" -m 'Import Electron ancestry and add tested Obscura renderer boundary')
git merge-base --is-ancestor "$upstream" "$commit"
git merge-base --is-ancestor "$GITHUB_SHA" "$commit"
git push origin "$commit:refs/heads/$branch"
printf '%s\n' "Created $branch at $commit" >> "$GITHUB_STEP_SUMMARY"
