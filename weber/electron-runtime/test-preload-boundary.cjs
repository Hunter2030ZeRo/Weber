'use strict';
// Exercise the actual bootstrap sources in two separate JS realms. Native V8
// watchdog, generation and renderer-process checks remain in the Rust/CI suite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const turn = () => new Promise(resolve => setImmediate(resolve));
function realm(name) {
  const source = fs.readFileSync(path.join(__dirname, '../crates/weber-engine/src', `preload_${name}.js`), 'utf8');
  const dispatch = vm.runInContext(source, vm.createContext({}));
  return request => JSON.parse(dispatch(JSON.stringify(request)));
}
test('bridge transfers copies and ignores inherited serialization hooks', async () => {
  const main = realm('main'), isolated = realm('isolated');
  const configured = isolated({ method: 'configure', source: `
    let hooks = 0;
    require('electron').contextBridge.exposeInMainWorld('api', {
      mutate: value => { value.items[0] = 'changed'; return { value, hooks, local: Object.getPrototypeOf(value) === Object.prototype }; },
    });
    Object.defineProperty(Object.prototype, 'toJSON', { get() { hooks++; throw Error('isolated hook'); } });
  ` });
  assert.equal(configured.ok, true);
  assert.equal(main({ method: 'install', exports: configured.value }).ok, true);
  assert.equal(main({ method: 'startEvaluation', id: 'copy', source: String.raw`
    globalThis.hooks = 0;
    Object.defineProperty(Object.prototype, 'toJSON', { get() { hooks++; throw Error('page hook'); } });
    const original = JSON.parse('{"items":["한글🙂\\u0000"],"__proto__":{"polluted":true}}');
    api.mutate(original).then(result => [original.items[0], result.value.items[0], result.hooks, hooks,
      result.local, Object.getPrototypeOf(result.value) === Object.prototype,
      Object.prototype.polluted === true, result.value.__proto__.polluted]);
  ` }).ok, true);
  let completion;
  for (let i = 0; i < 10 && !completion; i++) {
    await turn();
    for (const event of main({ method: 'drain' }).value) {
      if (event.type === 'evaluation-result') completion = event;
      else assert.equal(isolated({ method: 'call', id: event.id, functionId: event.functionId, args: event.args }).ok, true);
    }
    await turn();
    for (const event of isolated({ method: 'drain' }).value)
      assert.equal(main({ ...event, method: 'settle' }).ok, true);
  }
  assert.equal(completion?.ok, true, JSON.stringify(completion));
  assert.deepEqual(completion.value, ['한글🙂\0', 'changed', 0, 0, true, true, false, true]);
  const deep = {}; let cursor = deep;
  for (let i = 0; i < 40; i++) cursor = cursor.next = {};
  const rejected = isolated({ method: 'call', id: 99, functionId: 1, args: [deep] });
  assert.equal(rejected.ok, false); assert.match(rejected.error, /complex/);
});
