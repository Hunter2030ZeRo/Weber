# ASAR runtime scope

`asar.cjs` installs a read-only view of real ASAR archive entries before the main
application and utility-process entry execute. It reads the existing archive and
its declared `.asar.unpacked` files; it never extracts dependencies or rewrites an
application's source or package layout.

## Implemented paths

- `fs.readFile`, `stat`, `lstat`, `access`, `readdir`, and `realpath`, including
  synchronous, callback and available promise forms; `exists`/`existsSync`.
  String, Buffer and file-URL paths are accepted. Ordinary filesystem paths and
  real directories whose names end in `.asar` keep native behavior.
- Archive directories appear as directories. Entry stats report archive-backed
  times/ownership and synthetic read-only file modes, not separate real inodes.
  `readdir({withFileTypes:true})` reports files/directories; recursive listing is
  explicitly unsupported.
- `createReadStream` returns a Readable with optional byte ranges and asynchronous
  error delivery. It buffers one bounded archive file; it does not implement the
  full native `ReadStream` descriptor/open-event surface. Callback/promise reads
  currently schedule synchronous archive reads and can block the event loop.
- Both `original-fs` and `node:original-fs` return an unwrapped native filesystem
  snapshot, including native promise methods. `process.noAsar` bypasses the view.
- Node synchronous `module.registerHooks` loads packed CommonJS, ESM and JSON
  source under their actual archive paths, including normal CommonJS caching,
  legacy package mains/index fallback, and exact conditional package exports.
  Dependency package-type scopes stop at `node_modules` boundaries. Bare
  dependencies within `node_modules.asar` resolve against that archive's root.
- Native addons are loaded by the real backend from their original
  `.asar.unpacked` path. Packed native-addon extraction is not implemented.
  Successful loading still depends on the binary's platform and runtime ABI.

Node is the primary ESM path and requires synchronous module hooks. Bun uses
Weber's existing CommonJS application loader with the same archive resolver;
Bun's ordinary native `require` does not reliably pass through `Module._load`.
Bun application `original-fs` imports therefore use that custom loader. Bun ESM
archive/application imports are not claimed. Utility-process `.cjs` entries use
these same paths, including actual parent/child messaging.

## Explicit limits

Archive links, package export patterns, `#` package import maps and ESM module
URLs with query/fragment identities are rejected.
The resolver implements the stated package subset, not every Node package-resolution
edge case. Archive file descriptors, writes to entries, watchers, recursive
`readdir`, child-process execution of packed binaries, and renderer/URL protocol
ASAR reads are outside this implementation. Unsupported filesystem operations
retain the host filesystem's behavior and errors. Installing the view does not
prevent application code from modifying the underlying archive through native
write operations; it is not a permissions boundary or sandbox.

The parser validates pickle/header lengths, UTF-8, safe entry components,
file offsets, sizes, flags, depth and entry counts. Header size is limited to
32 MiB, each file to 512 MiB, depth to 64, and entries to 250,000. Metadata for at
most 32 archives is cached using stat identity/size/timestamps; file descriptors
are closed after each read. Unpacked reads check real-path containment and
matching regular-file size. These checks detect malformed archives and ordinary
path escapes. They do not authenticate publishers, verify ASAR integrity hashes,
or protect against concurrent hostile replacement of archive/unpacked inputs.
Installed application packages must remain trusted and stable during execution.

## Verification

After building the existing native runtime:

```sh
node --test weber/electron-runtime/test-asar.cjs
bun test ./weber/electron-runtime/test-asar.cjs
```

The suite checks packed/unpacked bytes without extraction, filesystem contracts,
CJS/ESM resolution, package encapsulation, original-fs, an actual unpacked native
addon, malformed inputs, ordinary filesystem behavior and an actual utility
child whose entry and data reside inside an archive. ESM-only checks skip on Bun.

A direct smoke check also loaded the pinned official VS Code distribution's
`@vscode/spdlog` from its existing `node_modules.asar`, including its original
unpacked native addon. That establishes dependency loading only; it does not
establish workbench startup or VS Code compatibility.
