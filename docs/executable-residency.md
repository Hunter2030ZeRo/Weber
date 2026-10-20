# Initial executable residency investigation

Linux Wayland, normal production Notes, JIT. No application code, engine feature,
allocator or system memory policy is changed by this investigation.

The [font-lifetime report](font-lifetime-optimization.md) recorded higher initial
PSS after the font-cache fix, mostly in the main executable's clean mappings.
Reading both old executables into the file cache did not remove that difference.
That observation remains valid for those files and runs.

## New counterfactual and controlled comparison

The original files reproduced the discrepancy: the old executable's text mapping
had about 49,600 KiB RSS, versus about 60,100–60,500 KiB for the font-fixed file.
Those mappings had equal RSS/PSS and no shared-clean pages, so another process
sharing the old executable did not explain the difference in these trials.

Copying the **byte-identical old executable** to a fresh inode, then running the
same app, increased its text residency to about 60,000–61,200 KiB too. The new
copy of the fixed executable occupied a similar range. This contradicts treating
the earlier difference as evidence that the font patch alone required 10 MiB
more running code. File identity / cache-population history is a confound.

`scripts/residency-benchmark.mjs` now makes fresh executable/private-library
copies for **each** launch, verifies their hashes, and uses identical full-file
reads before the timed spawn. Four interleaved launches per host keep the app
and assets unchanged and inject no polling/performance JavaScript. The initial
controlled repeat compares:

- Before: `df0d61ebb0d3f9a28ea56f7cddf4a0c9eb7f778a31bc58f6e5c828682c89c5ad`.
- Font fix: `38dfc3415af9355d1041b93899b12fb17dad309a68d722e4ff7790623eaa8423`.

| Warm-file measurement | Before | Font fix |
| --- | ---: | ---: |
| Median settled Notes PSS across four launches | 113.36 MiB | 113.47 MiB |
| Range of per-launch settled PSS medians | 112.77–119.72 MiB | 113.37–113.65 MiB |
| Median main executable mapping RSS | 76.64 MiB | 76.66 MiB |
| Median parent spawn → SDK DOM ready | 199.77 ms | 205.01 ms |

The earlier initial-PSS penalty did not reproduce under this preparation.
These four trials do **not** establish a memory or startup improvement; startup
variance and the first old-host anonymous-memory outlier remain visible. The
short settled idle windows detected no process CPU ticks at 10 ms resolution.
They do not exercise typing, an active caret or animations.

The precise kernel/filesystem mechanism behind the old inodes' different
residency is not isolated. Merely warming an existing file is not the same
preparation as a fresh per-launch copy. This method reduces an observed confound,
but cannot guarantee identical kernel cache state or represent cold-disk startup.
No global cache drop, production `madvise`, discard of code pages or feature
disable is introduced. A diagnostic `MADV_RANDOM` experiment on the original
files did not remove their difference and was not adopted.

The retained-font-cache improvement remains supported by its separate lifetime
test. A general lower-memory claim and beta performance promotion still require
representative repeated workloads; the old initial regression should no longer
be attributed solely to the font implementation.

## Reproduction

```sh
dbus-run-session -- node scripts/headless-wayland.mjs scripts/residency-benchmark.mjs BEFORE_BUNDLE/weber AFTER_BUNDLE/weber NOTES/application
```

Both executables must be prepared runtime bundles with private `lib/` files.
Only freshly created test copies are removed at completion. Original runtime
files, app assets and the user's session are untouched. The benchmark records
the app manifest, source/build and binary/library hashes, per-mapping KiB,
process-tree memory, CPU ticks and traces. DOM ready and the first post-ready
native presentation stay separate; a missing presentation marker is `null`.

Raw local evidence: `artifacts/residency-probe.json`, `residency-copied.json`,
`residency-random.json`, `residency-benchmark.json`, their `.smaps` files and
native traces. The first controlled report predates cosmetic result-field
renaming in the tracked script (`memoryMiB.pssKiB` became `memoryMiB.pss`);
its values were already MiB. Kernel/GPU/compositor memory outside the app process
tree is excluded. This is not a cross-framework or physical-input benchmark.
