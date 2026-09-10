# Linux safeStorage boundary

Weber compiles the fork's unchanged `lib/browser/api/safe-storage.ts` and replaces
only `electron_browser_safe_storage`. VS Code's original encryption service uses
the synchronous methods and serializes Electron Buffers as JSON.

## Implemented contract

- Before app ready: availability is false and selected backend is `unknown`.
- `gnome-libsecret`: the helper reads the OS Secret Service using the application's
  name, exactly as Electron configures `os_crypt::Config::application_name`.
  Schema `chrome_libsecret_os_crypt_password_v2` has `DONT_MATCH_NAME` and the
  `application` attribute, allowing existing Electron libsecret keys to be found.
- New keys are 16 random bytes encoded as Base64 and stored only in the unlocked
  default system collection. Existing locked or ambiguous entries fail closed.
  There is no automatic keyring unlock prompt or file-based key fallback.
- Electron's Linux sync `v11` format is AES-128-CBC, PBKDF2-HMAC-SHA1 with
  `saltysalt`, one iteration and a 16-space IV. Empty strings produce empty
  Buffers. Reads preserve the legacy `v10` and empty-password fallback formats.
- `basic_text` writes require the application's explicit
  `setUsePlainTextEncryption(true)` call; `--password-store=basic` alone does not
  enable them. This is Electron's public hardcoded-key obfuscation, **not secure
  encryption**. A failed libsecret backend never falls back to it.
- Application name and backend are frozen at ready. The first availability or
  crypto call tries the helper once, with a five-second deadline and 8 KiB output
  cap. Successful calls retain only the derived 16-byte key in the main process;
  subsequent calls use Node/Bun crypto without helper IPC or timers. Quit wipes
  that buffer. As with Electron's cached sync key, locking the keyring later does
  not revoke the key already held by a running process. Restart reloads it.
- Inputs are capped at 4 MiB. Caller plaintext and JavaScript strings remain
  subject to the JavaScript runtime's memory management; no secure-heap guarantee.

The helper serializes first-use creation between Weber processes using an owned
0700 directory and 0600 advisory lock. Electron does not join this lock: migrate
an existing key, or initialize it before concurrently launching a fresh app in
both frameworks. Duplicate keys are rejected instead of choosing or overwriting.
The helper has no core dumps, dies with its direct parent, and writes its password
only to the private pipe. This does not constitute a complete OS sandbox.

## Explicit limits

KWallet, macOS Keychain and Windows DPAPI are not implemented. Linux desktop
selection recognizes common GNOME-family environments and explicit `basic` or
`gnome-libsecret` switches; it is not the full Chromium desktop/preference detector.
Async safeStorage methods and their newer key-migration format are unsupported;
`isAsyncEncryptionAvailable()` resolves false. The legacy compatible CBC format
does not authenticate ciphertext, so arbitrary tampering cannot reliably be
detected. There is no claim of renderer credential isolation beyond the existing
Weber process boundary.

## Build and validation

Install `libsecret-1-dev` and compile after the original modules:

```sh
node weber/electron-runtime/build.cjs
node weber/electron-runtime/safe-storage/build.cjs
node --test weber/electron-runtime/test-safe-storage.cjs
bun test ./weber/electron-runtime/test-safe-storage.cjs
python3 weber/electron-runtime/safe-storage/run-live.py
xvfb-run -a python3 weber/electron-runtime/safe-storage/run-live.py /absolute/path/to/electron
```

Live tests require `gnome-keyring`, `dbus-x11`, `libsecret-1`, Node and Bun.
The runner owns a temporary HOME, XDG directories and D-Bus session. It checks
cross-process Node/Bun reads, optional real Electron cross-reads in both directions,
concurrent initialization, locked/missing service failures and recovery without
key rotation. Only public fixture strings are encrypted; no user's keyring is read.
Full CI runs the reference against pinned Electron 42.0.0. Its success is a
mandatory runtime gate independent of the diagnostic VS Code startup probe.

## Source contracts

- [Electron's retained Chromium sync implementation](https://github.com/Hunter2030ZeRo/Weber/blob/c1aad3df47dcae19bad6d12157c7f06ad72ea409/patches/chromium/revert_oscrypt_remove_sync_backend.patch)
- [Electron safeStorage binding](https://github.com/Hunter2030ZeRo/Weber/blob/c1aad3df47dcae19bad6d12157c7f06ad72ea409/shell/browser/api/electron_api_safe_storage.cc)
- [Electron application key-store configuration](https://github.com/Hunter2030ZeRo/Weber/blob/c1aad3df47dcae19bad6d12157c7f06ad72ea409/shell/browser/electron_browser_main_parts.cc)
