# Electron compatibility ledger

This is an implementation ledger, not a declaration of Electron compatibility.
The public contract is the existing Electron application model. Obscura,
backend selection and optional agent access are the intended differences.
The engine-specific implementation may change; applications should not need a
new window/IPC architecture. The current prototype has not reached that goal.

Contracts checked against the official documentation on 2026-09-09:
[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window),
[app](https://www.electronjs.org/docs/latest/api/app),
[ipcMain](https://www.electronjs.org/docs/latest/api/ipc-main).
These are moving documentation references, not a pinned compatibility version.
The [initial pinned VS Code audit](vscode-audit.md) identifies preload and window
startup blockers. It is not yet a complete dependency inventory or execution test.

| Surface | Current implementation | Remaining gap |
| --- | --- | --- |
| Window identity | Synchronous immutable ID, getAllWindows/fromId/fromWebContents, isDestroyed | Native creation is still asynchronous; host supports only one concurrent window |
| Window destruction | Registry removed before destroyed/closed notifications; host exit invalidates objects | Cancellable close and Electron shutdown sequence |
| webContents | EventEmitter, synchronous getURL, isDestroyed, destroyed | URL cache covers explicit loadFile only; renderer navigation/history not synchronized |
| loadFile | Resolves undefined, updates URL before did-finish-load | Full navigation events, load options, subframes and concurrent navigation semantics |
| App readiness | Shared whenReady promise, isReady, single ready event | Lazy initialization and pre-ready window construction differ from Electron |
| ipcMain.handleOnce | Registration consumed before user handler, including pending/rejected asynchronous handlers | Full ipcMain EventEmitter and renderer invoke argument/structured-clone contracts |
| Window mutators | Existing asynchronous prototype operations | Electron synchronous return values and host event synchronization |
| Module imports | Local ESM runtime | Existing require('electron') and import from 'electron' resolution |
| preload/contextBridge | Unsupported, rejected explicitly | Actual isolated realm and process security required before exposing these APIs |
| Agent interface | Not implemented | Opt-in access, window/document-scoped permissions and lifecycle revocation |

Public IDs are independent of host wire IDs. The current host recycles wire ID 1
after a window closes; applications must never see that ID reuse. Internal IPC
continues to use host IDs and document epochs. Registry tests with multiple fake
windows do not demonstrate native multiwindow support.

The Node/Bun contract tests use an identified protocol double. The separate
native smoke exercises Obscura rendering, IPC, synchronous identity/URL reads,
destruction and sequential window replacement on Linux. See the actual CI result
for the tested revision; source assertions alone are not passing results.

The agent interface must be an optional extension to Electron-compatible apps.
Page JavaScript must not acquire agent privileges. Agent entry points must share
the window/document authority checks used by other privileged operations, and
must not silently open an unauthenticated debugging listener.
