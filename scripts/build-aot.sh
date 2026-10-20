#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
revision=17b37301da5da4a2cd55d78f9697c46c0fd96123
if [[ ! -d vendor/hermes/.git ]]; then
  git clone https://github.com/facebook/hermes.git vendor/hermes
  git -C vendor/hermes checkout "$revision"
fi
[[ "$(git -C vendor/hermes rev-parse HEAD)" == "$revision" ]] || exit 1
patch_path="$PWD/patches/hermes-unit-capacity.patch"
if ! git -C vendor/hermes apply --reverse --check "$patch_path" 2>/dev/null; then
  git -C vendor/hermes apply --check "$patch_path"
  git -C vendor/hermes apply "$patch_path"
fi
cmake -S vendor/hermes -B target/hermes -G Ninja -DCMAKE_BUILD_TYPE=Release -DHERMES_ENABLE_TEST_SUITE=OFF
cmake --build target/hermes --target shermes hermesvm shermes_console -j 8
node app/build-platform.mjs
