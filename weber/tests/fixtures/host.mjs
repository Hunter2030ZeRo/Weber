// Protocol test double. This does not emulate or validate Obscura rendering.
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const send = message => process.stdout.write(`@weber:${JSON.stringify(message)}\n`);
if (mode === 'bad-json') process.stdout.write('@weber:{bad}\n');
else if (mode === 'oversize') process.stdout.write('x'.repeat(1024 * 1024 + 1));
else if (mode === 'bad-version') send({ event: 'ready', protocol: 999 });
else if (mode !== 'silent') send({ event: 'ready', protocol: 1 });
process.stdout.write('non-protocol engine diagnostic\n');
let next = 0;
const replies = [];
const urls = new Map();
createInterface({ input: process.stdin }).on('line', async line => {
  const { id, method, params } = JSON.parse(line);
  if (mode === 'silent' || method === 'hang') return;
  if (method === 'exit') process.exit(7);
  if (method === 'error') return send({ id, error: 'deliberate host error' });
  if (method === 'echo') {
    await new Promise(resolve => setTimeout(resolve, params.delay ?? 0));
    return send({ id, result: params.value });
  }
  if (method === 'unicode') {
    const frame = Buffer.from(`@weber:${JSON.stringify({ id, result: '한글 🧪' })}\n`);
    for (const byte of frame) process.stdout.write(Buffer.from([byte]));
    return;
  }
  if (method === 'window.create') {
    if (mode === 'create-fail') return send({ id, error: 'creation failed' });
    return send({ id, result: mode === 'reuse-id' ? 1 : ++next });
  }
  if (method === 'window.url') return send({ id, result: urls.get(params.window) ?? '' });
  if (method === 'window.loadFile') {
    if (params.path.endsWith('missing.html')) return send({ id, error: 'file missing' });
    urls.set(params.window, pathToFileURL(params.path).href);
    send({ id, result: null });
    send({ event: 'invoke', window: params.window, epoch: 1, call: 1, channel: 'system.info', payload: { value: 42 } });
    send({ event: 'invoke', window: params.window, epoch: 1, call: 2, channel: mode === 'once' ? 'system.info' : 'forbidden', payload: null });
    return;
  }
  if (method === 'ipc.reply') replies.push(params);
  if (method === 'window.evaluate') return send({ id, result: replies });
  if (method === 'window.close') {
    send({ id, result: null });
    send({ event: 'closed', window: params.window });
    return;
  }
  if (method === 'app.quit') {
    send({ id, result: null });
    process.exit(0);
  }
  send({ id, result: null });
});
