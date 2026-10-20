# Fixed profile validation — 2026-10-19

`weber-ui-2025-01-v1` reached its declared completion gate. The machine-readable
evidence is `artifacts/compatibility-profile.json` (`passed: true`).

| Gate | Result |
| --- | --- |
| Selected original WPT files | 17/17 on both engines |
| Actual Servo WPT subtests | 1,474/1,474 PASS |
| Static Hermes native AOT WPT subtests | 1,474/1,474 PASS |
| Harness errors, skips, missing or pending results | 0 |
| Mandatory application scenarios | 15/15 PASS |
| Build, TypeScript/Vite, Clippy, formatting | PASS |
| Source fingerprint matches compiled executable | PASS |

This is a fixed, selected UI compatibility profile, **not full 2025 browser
compatibility**. The test source and original harness come from WPT revision
`58c1148991566b4b3454edac0f9a8e11010e20b2` (2024-12-31). All 21 downloaded files
and the profile itself are hash locked. Each native test script is compiled into
a Static Hermes native object; it is not evaluated as source in the running app.
The native harness uses WPT's shell environment; Servo uses its window environment.
See [the scope and exclusions](compatibility-target.md).

## Native evidence

The run used the actual Wayland compositor with DISPLAY unset. It tested the
same native executable for WPT, synchronous renderer reads, typed UI events and
asynchronous APIs. Existing native AOT contracts passed: 30 DOM, 7 Solid and 9
scheduler cases. Existing Wayland DOM and Solid scheduling tests also passed.

Renderer checks included transformed/bordered rectangles, a live computed style
after an AOT write, scrolling to (23, 35), and native focus/blur identity. Mouse,
keyboard and input snapshots returned to compiled AOT handlers, including
synchronous preventDefault. ResizeObserver delivered initial/changed/re-observed
sizes and stopped after unobserve/disconnect. Real Servo fetch returned Unicode
JSON and POST text, status/headers, abort reasons and network/parse failures.

An additional lifecycle probe deliberately left one timer, one ResizeObserver
and one fetch pending. Disposal changed the native snapshot from 13 managed nodes
and three listeners to only the mount root, with zero tasks, observers or requests.
After remount and a 600 ms wait, old callback count remained zero; the pending AOT
fetch rejected with AbortError, and both AOT async registries were empty.

Input was programmatic DOM input. Physical keyboard/pointer behavior, memory,
startup and latency benchmarks were not measured by this gate. Servo still uses
SpiderMonkey for its DOM and the outer page; the compiled Hermes application
talks to it through the experimental owned-tree bridge.

## Reproduction and identity

After the pinned bootstrap/build, run `node scripts/profile-smoke.mjs` in a live
Wayland session. The command exits unsuccessfully on missing/failing scenarios,
different per-engine subtest counts, harness errors, failed checks, or stale
source/binary identity. Original failed cases were retained while fixing the
implementation; the locked profile was not narrowed.

- Profile SHA-256: `a1f4cf678fb47d371d2268c255ad09752fe008e57a47304f18ff8b739eb81c78`
- Source fingerprint: `144d491be4e80ed913a94310a1f35b76e6390e0e70c86aacf38de84f2c4eb304`
- Executable SHA-256: `d6d7665d00cb7fdb264e9748743655648e37cd82dfaceb0534a83f4a735da00d`
- Servo: `aac43a3f31a259f04a574f5ec4e959c943ad7cc7`
- Static Hermes: `17b37301da5da4a2cd55d78f9697c46c0fd96123`

Tracked local patches implement observer fixes, synchronous/query host calls,
time origin, and Hermes unit capacity. All four patch reverse checks passed
against the tested sources. Build caches invalidate native objects on a changed
SHRuntime header; the expanded unit table is an ABI change.
The original acceptance record below is historical. The current source passed
the same locked profile again; see [standalone validation](standalone-validation.md)
and `artifacts/compatibility-profile.json` for current build provenance.

