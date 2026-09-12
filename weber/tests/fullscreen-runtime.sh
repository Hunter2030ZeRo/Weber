#!/usr/bin/env bash
# Copyright Weber contributors. SPDX-License-Identifier: MIT
set -euo pipefail
openbox --sm-disable &
fullscreen_wm_pid=$!
trap 'kill "$fullscreen_wm_pid" 2>/dev/null || true; wait "$fullscreen_wm_pid" 2>/dev/null || true' EXIT
fullscreen_wm_ready=false
for ((i=0; i<100; i++)); do
  if wmctrl -m >/dev/null 2>&1; then fullscreen_wm_ready=true; break; fi
  sleep 0.05
done
if [[ "$fullscreen_wm_ready" != true ]]; then echo 'Window manager did not start' >&2; exit 1; fi
timeout 40s "$1" weber/electron-runtime/bootstrap.cjs "${2:-weber/electron-runtime/fullscreen-fixture}"
