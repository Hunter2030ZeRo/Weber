import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../crates/weber-host/src/bridge.js', import.meta.url), 'utf8');
function realm(t) {
  const timers = new Set();
  const context = vm.createContext({
    setTimeout: (fn, delay) => { const id = setTimeout(fn, delay); timers.add(id); return id; },
    clearTimeout: id => { timers.delete(id); clearTimeout(id); }
  });
  t.after(() => { for (const id of timers) clearTimeout(id); });
  vm.runInContext(source, context);
  return context;
}
test('renderer bridge correlates successful and failed replies', async t => {
  const context = realm(t);
  const result = vm.runInContext("weber.invoke('sum', {a:2,b:3})", context);
  const calls = vm.runInContext('__weberDrain()', context);
  assert.equal(calls[0].channel, 'sum');
  assert.equal(calls[0].payload.a, 2);
  vm.runInContext(`__weberReply({call:${calls[0].call},result:5})`, context);
  assert.equal(await result, 5);
  const denied = vm.runInContext("weber.invoke('denied')", context);
  const error = assert.rejects(denied, /denied/);
  vm.runInContext("__weberReply({call:__weberDrain()[0].call,error:'denied'})", context);
  await error;
});
test('renderer rejects invalid channels and payloads', async t => {
  const context = realm(t);
  await assert.rejects(vm.runInContext("weber.invoke('')", context), /Invalid channel/);
  await assert.rejects(vm.runInContext("weber.invoke('x', 'x'.repeat(32769))", context), /limit/);
  await assert.rejects(vm.runInContext("weber.invoke('x', 1n)", context), /BigInt/);
});
test('renderer queue has bounded draining and backpressure', async t => {
  const context = realm(t);
  vm.runInContext("globalThis.requests = Array.from({length:128}, () => weber.invoke('x'))", context);
  await assert.rejects(vm.runInContext("weber.invoke('x')", context), /Too many/);
  assert.equal(vm.runInContext('__weberDrain().length', context), 8);
  vm.runInContext('for(let call=1;call<=128;call++) __weberReply({call,result:null})', context);
  await Promise.all(context.requests);
});
