# Korean IME — 0.6.0-alpha.2

Korean input is an alpha acceptance requirement. Applications use ordinary HTML
`input` and `textarea`; no additional Weber text widget or app-specific Hangul
implementation is required. The default runtime remains Servo/SpiderMonkey JIT.
Static Hermes is not involved in this path.

## Implementation

The path is compositor IME → Wayland text-input-v3 → winit → Weber composition
state → Servo text controls → trusted DOM composition/input events. On GNOME,
Fcitx5 supplies its IBus compatibility frontend to Shell. See the
[official Fcitx Wayland guide](https://fcitx-im.org/wiki/Using_Fcitx_5_on_Wayland/en).

Real Fcitx Hangul input reproduced three defects that are fixed here:

- Deleting the last jamo left a visible character: Servo ignored empty preedit.
  Empty updates now replace the selected composition with an empty string.
- A preedit clear without a following commit left `isComposing` true. Weber
  distinguishes a cancellation from the clear+commit pair in a single native
  event batch. Cancellation is flushed at the batch boundary or before the next
  ordinary event; there is no idle polling timer. A commit in that batch ends
  the existing composition once.
- Readonly input/textarea accepted ordinary editing keys. Text-control editing
  now rejects changes to immutable controls, with cursor movement preserved;
  composition handlers also check mutability.

Input-method controls are tracked by their Servo control ID. A stale hide for a
different control cannot disable the new field's context. Backend disable is an
acknowledgement, not a request to blur the newly focused DOM element. Password
fields request password purpose; textarea requests multiline input. This does
not promise password secrecy against a privileged operating-system IME.

The Servo changes are reproducible in `patches/servo-ime-composition.patch`,
applied after the other pinned patches by bootstrap. `check-servo-patches.py`
compares a clean ordered application with the source actually compiled.

## Native acceptance

`scripts/ime-native.mjs` launches real Fcitx5 with the Hangul engine in a temporary
GNOME Wayland session. A private D-Bus bus, runtime directory and input profile
keep the user's desktop configuration unchanged. Mutter RemoteDesktop injects
OS keycodes; no DOM composition/input events are fabricated. Test controls reset
fixtures or focus fields; typed results pass through the real IME and renderer.

The temporary profile uses `kr-kr104`, with `Hangul` as the switch key. Right Alt
therefore maps to the Hangul keysym. Immediate-toggle cases send the next actual
character without waiting for an engine query or retrying the input.

Thirteen acceptance scenarios cover:

1. Syllable composition and commit, including a trailing space and trusted events.
2. Backspace decomposition `한 → 하 → ㅎ → empty`, followed by a noncomposing key.
3. Ten immediate Hangul-key on/off roundtrips and the first character each time.
4. Right Alt switching, including a held switch, with immediate first characters.
5. UTF-16 selection/caret behavior beside an emoji and insertion in the middle.
6. Replacing selected Latin text with composed Hangul.
7. Multiline textarea input, line breaks, final-jamo deletion and input-bound state.
8. Tab during composition, retaining the committed text in the original field.
9. Programmatic focus change during composition without stealing the new focus.
10. Actual compositor switching between two native windows and returning.
11. Readonly input and textarea remaining unchanged under ordinary keys.
12. Stable password focus and subsequent Tab navigation.
13. The actual Solid Workbench controlled textarea: type `한글`, Ctrl+S, close,
    restart, and read back the same persisted document.

The test waits for the focused IBus context before starting the baseline case.
GNOME initially opens Overview in a new empty session; it can retain client
focus while intercepting unhandled keys. The harness dismisses that private
Overview through its Escape handler before mapping an app. Merely changing the
Shell D-Bus property left stage keyboard focus on hidden overview controls in
this GNOME build; the actual compositor screenshot and stage-focus diagnostics
distinguished this from a Weber event loss. The test does not accept a missing
space or add one in Weber. Optional `WEBER_IME_WAYLAND_TRACE=1` records raw
Wayland and private D-Bus traffic when diagnosing transport failures.

## Reproduction and evidence

After the locked release build and local npm packaging described in
[the distribution guide](npm-distribution.md):

```sh
node scripts/ime-workflow.mjs --installed
env -u IBUS_ADDRESS -u FCITX_DBUS_ADDRESS dbus-run-session -- \
  node scripts/headless-wayland.mjs scripts/ime-native.mjs \
  target/package/weber-clipboard-jit/weber
node scripts/alpha-audit.mjs
node scripts/alpha-dist.mjs
```

The workflow installs the local SDK tarball in fresh DOM and Solid Workbench
projects. The alpha audit verifies SDK bytes, the runtime source fingerprint,
all thirteen scenarios and the existing app/window/system gates. The local
alpha archive includes `ime-validation.json` alongside its other acceptance
records; it does not publish to npm or install desktop configuration.

The observed environment is Linux x64, GNOME Shell 51.1 / Mutter 51.0,
Fcitx5 5.1.23, fcitx5-hangul 5.1.11 and libhangul 0.2.0, with a 960×720@60
virtual monitor. Test input and output belong to the private session.

Verified on 2026-10-21, with the locked optimized release and installed SDK
**0.6.0-alpha.2**. Runtime source fingerprint:
`3c5e1c8ebbfa8b057f7f644c33a2c8492ceb928168295c9d6ba53f82fc722b94`.

| Check | Result |
| --- | --- |
| Release build, formatting and Clippy | Passed; existing vendored Servo warnings remain |
| Host Rust tests | 26 passed, 0 failed |
| Ordered pinned Servo patches | 10 patches / 22 files match the compiled checkout |
| Real Hangul engine acceptance | 13/13 in each of two fresh private sessions |
| Actual Solid Workbench Hangul save/restart | Passed in both sessions |
| Existing preview/clipboard/npm/window lifetime/activation gates | All eight passed; lifetime includes 50 and 200 cycles |
| Workbench application/window/system and desktop launcher | Passed |
| Installed SDK bytes and package/runtime source identity | Passed |
| Local alpha archive | Created with acceptance records; not published |

Local evidence is in `artifacts/ime-native-first.json`, `artifacts/ime-native.json`,
`artifacts/alpha-audit.json` and `artifacts/final-alpha-checks.json`. Generated
files are ignored by Git; the checked-in scripts and this report describe their
reproduction. `target/alpha/` contains the SDK/runtime tarballs and a production
Workbench bundle. The production Workbench has no acceptance probe and runs
without Node or Bun. This is a developer alpha, not a beta certification.

## Boundaries

This acceptance uses real Fcitx5 Hangul with automated OS keycodes in GNOME;
it is not a human physical-keyboard session. Other compositor/IME combinations,
Windows and macOS need their own native acceptance. Hanja candidate popup
positioning, surrounding-text reconversion, contenteditable default editing,
accessibility and extended all-day sessions are not established by these tests.
In particular, winit's current path does not supply full surrounding-text and
DeleteSurroundingText integration. Passing basic Hangul editing does not imply
these broader capabilities. No new performance advantage is claimed.
