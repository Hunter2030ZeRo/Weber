import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Transport, MAX_FRAME } from '../packages/weber/transport.mjs';
const fixture = fileURLToPath(new URL('./fixtures/host.mjs', import.meta.url));
function host(t, mode, timeout = 1000) {
  const transport = new Transport(process.execPath, { args: [fixture, ...(mode ? [mode] : [])], timeout });
  t.after(() => transport.close());
  return transport;
}
test('correlates concurrent out-of-order responses', async t => {
  const transport = host(t);
  assert.deepEqual(await Promise.all([
    transport.request('echo', { value: 'slow', delay: 30 }),
    transport.request('echo', { value: 'fast' })
  ]), ['slow', 'fast']);
});
test('preserves fragmented UTF-8 and ignores diagnostic stdout', async t => {
  assert.equal(await host(t).request('unicode'), '한글 🧪');
});
test('propagates host errors', async t => {
  await assert.rejects(host(t).request('error'), /deliberate host error/);
});
test('rejects pending requests when the host exits', async t => {
  const transport = host(t);
  const pending = transport.request('hang');
  const exit = transport.request('exit');
  await Promise.all([assert.rejects(pending, /exited/), assert.rejects(exit, /exited/)]);
});
test('startup failure is reported without an unhandled rejection', async t => {
  const transport = new Transport('/nonexistent/weber-host');
  t.after(() => transport.close());
  await assert.rejects(transport.ready(), /ENOENT/);
});
test('startup has a deadline', async t => {
  await assert.rejects(host(t, 'silent', 200).ready(), /startup timed out/);
});
test('request has a deadline without breaking later requests', async t => {
  const transport = host(t, undefined, 200);
  await transport.ready();
  await assert.rejects(transport.request('hang'), /request timed out/);
  assert.equal(await transport.request('echo', { value: 7 }), 7);
});
for (const [mode, error] of [['bad-json', /Invalid JSON/], ['bad-version', /Unsupported Weber protocol/], ['oversize', /exceeds 1 MiB/]]) {
  test(`rejects ${mode} host output`, async t => {
    await assert.rejects(host(t, mode).ready(), error);
  });
}
test('rejects oversized and cyclic requests before writing', async t => {
  const transport = host(t);
  await assert.rejects(transport.request('echo', { value: 'a'.repeat(MAX_FRAME) }), /exceeds 1 MiB/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(transport.request('echo', cyclic), TypeError);
  assert.equal(await transport.request('echo', { value: 'healthy' }), 'healthy');
});
