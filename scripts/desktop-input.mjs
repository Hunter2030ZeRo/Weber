import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, NativeKeys, execute, delay, requireSession } from './native-desktop.mjs';
const prefix = process.env.WEBER_REPORT_PREFIX ?? '';
assert.match(prefix, /^[a-zA-Z0-9-]*$/);

await requireSession();
const binary = process.argv[2] ?? 'target/debug/weber-servo';
const build = JSON.parse((await execute(resolve(binary), ['--build-info'])).stdout);
const originalIme = (await execute('fcitx5-remote', [])).stdout.trim();
const keys = await NativeKeys.open();
const results = [];
try {
  for (const engine of ['aot', 'web']) {
    const app = await launch({ binary, engine, name: `${prefix}desktop-input-${engine}`, mode: 'input', config: { timeoutMs: 90000 } });
    keys.app = app;
    try {
      await app.waitEvent(event => event.data.stage === 'driver-start', 'Desktop script start');
      await keys.activate();
      await app.waitEvent(event => event.data.stage === 'focused', 'input focus');
      await app.waitEvent(event => event.data.stage === 'window-focus' && event.data.focused, 'native window focus');
      await delay(700);
      await execute('fcitx5-remote', ['-c']); await delay(300);
      const count = async () => (await app.events()).length;
      const until = async (after, predicate, name) => app.waitEvent((event, index) => index >= after && predicate(event.data), name, 8000);
      const clearInput = async () => { await keys.key(57); await keys.key(30, [29]); await keys.key(14); };
      const inputMode = async hangul => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await clearInput(); const after = await count(); await keys.key(hangul ? 19 : 45);
          const probe = await until(after, data => data.type === 'input' && data.snapshot?.input, 'Input method probe');
          if (probe.data.snapshot.input === (hangul ? 'ㄱ' : 'x')) { await clearInput(); return; }
          // Verify the actual focused IME path rather than relying on a daemon's
          // state before the compositor finishes activating its input context.
          await keys.key(122);
        }
        throw new Error('Focused Hangul/Latin mode could not be established');
      };
      const text = async (value, operation) => {
        const after = await count(); await operation();
        const event = await until(after, data => data.stage === 'input-update' && data.snapshot?.input === value && data.snapshot?.text === value, `native text ${JSON.stringify(value)}`);
        assert.equal(event.data.trusted, true); return event;
      };
      await inputMode(false);
      await keys.key(30, [29]); await keys.key(14);
      await text('abc', async () => { for (const code of [30, 48, 46]) await keys.key(code); });
      await text('ac', async () => { await keys.key(105); await keys.key(14); });
      await text('a', () => keys.key(111));
      await text('ax', () => keys.key(45));
      let after = await count(); await keys.key(15);
      await until(after, data => data.type === 'focusin' && data.target === 'solid-reorder', 'Tab focus');
      after = await count(); await keys.key(15, [42]);
      await until(after, data => data.type === 'focusin' && data.target === 'solid-input', 'Shift-Tab focus');
      await keys.key(30, [29]); await keys.key(14);
      await execute('fcitx5-remote', ['-o']); await delay(150);
      await inputMode(true);
      const compositionAfter = await count();
      const hangul = await text('가나다 ', async () => { for (const code of [19, 37, 31, 37, 18, 37, 57]) await keys.key(code); });
      const composed = (await app.events()).slice(compositionAfter).filter(event => event.data.type?.startsWith('composition'));
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) assert.ok(composed.some(event => event.data.type === type && event.data.trusted), `${type} from actual IME`);
      assert.equal(hangul.data.snapshot.composition, '');
      await execute('fcitx5-remote', ['-c']);
      after = await count(); await keys.key(15, [42]);
      await until(after, data => data.type === 'focusin' && data.target === 'solid-counter', 'Button keyboard focus');
      after = await count(); await keys.key(28);
      const click = await until(after, data => data.type === 'click' && data.target === 'solid-counter' && data.snapshot?.count === '1', 'Native Enter activation');
      assert.equal(click.data.trusted, true);
      await app.waitEvent(event => event.data.stage === 'input-present', 'Native input presentation');
      for (let index = 0; index < 20; index++) {
        after = await count(); await keys.key(15);
        const focus = await until(after, data => data.type === 'focusin', 'Keyboard focus traversal');
        if (focus.data.target === 'desktop-scroll') break;
        if (index === 19) throw new Error('Scroll region not reachable by keyboard');
      }
      after = await count(); await keys.key(109);
      const scroll = await until(after, data => data.type === 'scroll' && data.target === 'desktop-scroll' && data.snapshot?.scroll > 0, 'Native PageDown scrolling');
      after = await count(); await keys.key(104);
      await until(after, data => data.type === 'scroll' && data.target === 'desktop-scroll' && data.snapshot?.scroll === 0, 'Native PageUp direction');
      const all = await app.events();
      assert.ok(all.some(event => event.data.type === 'keydown' && event.data.key === 'a' && event.data.code === 'KeyA' && event.data.trusted), 'Native physical/logical key mapping');
      results.push({ engine, passed: true, backend: (await keys.ready).backend, text: hangul.data.snapshot.text,
        compositionEvents: composed.map(event => ({ type: event.data.type, data: event.data.data, composing: event.data.isComposing })), scroll: scroll.data.snapshot.scroll,
        tests: ['Latin typing', 'Ctrl-A selection', 'Backspace', 'Delete', 'ArrowLeft', 'Tab', 'Shift-Tab', 'Hangul preedit/commit', 'Enter trusted click', 'PageDown/PageUp native scrolling'] });
      await keys.key(62, [56]); await app.waitExit();
    } finally { keys.app = null; await app.stop(); }
  }
  await writeFile(`artifacts/${prefix}desktop-input.json`, JSON.stringify({ passed: true, build, method: 'OS input through GNOME Mutter RemoteDesktop; real Wayland/IME path, not human physical-device input', results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  keys.app = null; await keys.close();
  if (originalIme === '1' || originalIme === '2') await execute('fcitx5-remote', [originalIme === '2' ? '-o' : '-c']);
}
