import { createInterface } from 'node:readline';
import { format } from 'node:util';

const LIMIT = 1024 * 1024;
let output = Promise.resolve();
let queuedBytes = 0;
function send(value) {
  const line = JSON.stringify(value, (_, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Backend results must be finite JSON');
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item)) throw new TypeError('Backend results must be JSON');
    return item;
  }) + '\n';
  if (Buffer.byteLength(line) > LIMIT) throw new RangeError('Backend result exceeds 1MiB');
  const bytes = Buffer.byteLength(line);
  if (queuedBytes + bytes > 2 * LIMIT) throw new RangeError("Backend output queue exceeds 2MiB");
  queuedBytes += bytes;
  output = output.then(() => new Promise((resolve, reject) => process.stdout.write(line, error => error ? reject(error) : resolve())));
  return output.finally(() => { queuedBytes -= bytes; });
}
const failure = error => ({ name: String(error?.name ?? 'Error').slice(0, 200), message: String(error?.message ?? error).slice(0, 4000) });
export async function serve(load) {
  // Stdout is the framed protocol; ordinary console output remains visible.
  for (const name of ['log', 'info', 'debug', 'warn', 'error']) console[name] = (...args) => process.stderr.write(format(...args) + '\n');
  let methods;
  try {
    methods = (await load()).default;
    if (!methods || typeof methods !== 'object') throw new TypeError('Backend must default-export a method object');
    await send({ protocol: 1, ready: true, runtime: Bun.version });
  } catch (error) { await send({ protocol: 1, ready: false, error: failure(error) }); process.exit(1); }
  const active = new Map();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  lines.on('close', () => process.exit(0));
  lines.on('line', line => {
    void (async () => {
      if (Buffer.byteLength(line) > LIMIT) throw new RangeError('Backend request exceeds 1MiB');
      const request = JSON.parse(line);
      if (!Number.isSafeInteger(request.id) || request.id < 1) throw new TypeError('Invalid request id');
      if (request.op === 'cancel') { active.get(request.id)?.abort(); return; }
      if (!['call', 'subscribe'].includes(request.op) || active.has(request.id) || active.size >= 128) throw new TypeError('Invalid or excessive backend request');
      const controller = new AbortController(); active.set(request.id, controller);
      try {
        if (!/^[A-Za-z][\w.-]{0,127}$/.test(request.method) || !Object.hasOwn(methods, request.method) || typeof methods[request.method] !== 'function') throw new Error('Unknown backend method: ' + request.method);
        const streaming = request.op === 'subscribe';
        const emit = value => {
          if (!streaming) throw new Error('emit is only available for subscriptions');
          if (controller.signal.aborted) return Promise.resolve();
          const event = { id: request.id, kind: 'event', value };
          if (Buffer.byteLength(JSON.stringify(event)) > 32768) throw new RangeError('Backend event exceeds 32KiB');
          return send(event);
        };
        const result = await methods[request.method](request.params, { signal: controller.signal, emit });
        if (!controller.signal.aborted) await send({ id: request.id, ...(request.op === 'subscribe' ? { kind: 'end' } : {}), ok: true, result: result === undefined ? null : result });
      } catch (error) { if (!controller.signal.aborted) await send({ id: request.id, ...(request.op === 'subscribe' ? { kind: 'end' } : {}), ok: false, error: failure(error) }); }
      finally { active.delete(request.id); }
    })().catch(error => { console.error('Backend protocol failure:', error); process.exit(1); });
  });
}
