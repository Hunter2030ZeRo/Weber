# App paths and persistent JSON storage

The JIT foundation host exposes `storageProtocol: 1`. It requires neither Bun
nor Node in the packaged UI. Use the current SDK and host together.

```ts
import { getAppPaths, getValue, setValue, removeValue, listKeys } from '@weber/sdk/storage';

const paths = await getAppPaths();
await setValue('theme', { mode: 'dark' }); // config area
const theme = await getValue<{ mode: string }>('theme');
await setValue('note', '한글 😀', 'data');
const note = await getValue<string>('note', 'data');
const keys = await listKeys('data');
const removed = await removeValue('note', 'data');
```

`config`, `data` and `cache` paths follow the OS base directories through
`directories-next`. Weber appends `weber/apps/<SHA-256 of app id>/<config|data|cache>` to each base, so areas
remain separate even when an OS uses the same base for config and data.
Packaged identity comes from `weber.json` / `app.json`; the Vite development
launcher passes that same id through `WEBER_APP_ID`. The embedded demo or a
manually launched URL defaults to `dev.weber.demo`. A paths query creates no
files or directories. The cache path is returned for backend use; the key/value
API supports only `config` and `data`.

Windows within an app share a serialized worker queue. Filesystem operations,
JSON store parsing and writes run off the UI thread. The worker starts on first
use, and the SDK polls only while a request is pending; there is no idle timer.
Closing/navigating a window drops its pending replies. A window cannot poll or
cancel another window's request ids. Shutdown joins the worker after disconnecting
its channels; a filesystem call already in progress may delay shutdown.

Keys contain 1–96 ASCII letters, digits, dots, underscores or hyphens. They are
JSON object keys, never filesystem paths. Each area permits 128 keys, values of
up to 8192 serialized UTF-8 JSON bytes, and a total store file of at most 1 MiB.
There are at most 32 pending requests app-wide. Undefined values, nonfinite
numbers and non-JSON values are rejected. Missing keys return null; stored null
also returns null, so use `listKeys` if that distinction matters. A generic type
parameter is a TypeScript assertion, not runtime schema validation.

Each area uses one `store.json`. Writes create a unique sibling temporary file,
flush it, and atomically replace the store. Unix files are created with mode 0600.
Reads reject nonregular/symlink files on the tested Linux path, malformed JSON
and oversized stores; they do not silently reset corrupted user data. Storage is
plain JSON and this API is not an OS security sandbox or a general filesystem API.
Atomic replacement is implemented across platforms, but native verification in
this milestone is Linux only. Successful flush/rename is not a guarantee against
all storage hardware or power-loss failures.

Issued operations are not transactions across separate API calls. In particular,
`getValue` then `setValue` is not an atomic increment. Parallel writes in a single
Weber process execute in accepted queue order; independently launched processes
with the same app id do not have a cross-process lock and can overwrite each
other's updates. Cancelling a reply, a timeout or closing a window does not undo
an already issued write. Await `setValue` before closing if persistence matters.

## Working example

```sh
rtk proxy node sdk/cli.mjs init /tmp/my-weber-notes notes
# From the generated project:
rtk npm install
rtk npm run dev
rtk npm run build
rtk npm start
```

The Notes template uses a textarea, Save/Reload and New window. Save persists in
the data area; Reload reads the latest saved value. There is no autosave or
live synchronization of unsaved text between windows. Build/package use the
existing Vite/npm path. See [foundation validation](foundation-validation.md)
for executed native scenarios and their limits.
