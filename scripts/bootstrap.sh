#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
revision=aac43a3f31a259f04a574f5ec4e959c943ad7cc7
if [[ ! -d vendor/servo/.git ]]; then
  git clone --depth 1 --branch v0.7.0 https://github.com/servo/servo.git vendor/servo
fi
actual=$(git -C vendor/servo rev-parse HEAD)
if [[ "$actual" != "$revision" ]]; then
  printf 'Servo revision mismatch: %s\n' "$actual" >&2
  exit 1
fi
for patch_name in servo-transient-observers servo-sync-host servo-time-origin servo-keyboard-click servo-binary-host servo-small-dom-scheduling servo-safe-cut servo-document-envelope; do
  # The envelope extension supersedes contexts in both host-call patches.
  if [[ "$patch_name" == servo-sync-host || "$patch_name" == servo-binary-host ]] && git -C vendor/servo apply --reverse --check "$PWD/patches/servo-document-envelope.patch" 2>/dev/null; then
    continue
  fi
  patch_path="$PWD/patches/$patch_name.patch"
  # The binary extension modifies the same generated binding/trait contexts.
  # Its successful reverse check establishes that the preceding sync patch is
  # already present; testing that older patch in isolation would be ambiguous.
  if [[ "$patch_name" == servo-sync-host ]] && git -C vendor/servo apply --reverse --check "$PWD/patches/servo-binary-host.patch" 2>/dev/null; then
    continue
  fi
  if ! git -C vendor/servo apply --reverse --check "$patch_path" 2>/dev/null; then
    git -C vendor/servo apply --check "$patch_path"
    git -C vendor/servo apply "$patch_path"
  fi
done
pnpm --dir app install --frozen-lockfile
pnpm --dir app run build
if [[ "${1:-}" == "--aot" ]]; then
  bash scripts/build-aot.sh
  node scripts/prepare-wpt.mjs
  cargo build --locked --features aot
else
  cargo build --locked
fi
