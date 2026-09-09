'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../src');
function realm(name) {
  const context = vm.createContext(Object.create(null), {microtaskMode: 'afterEvaluate'});
  const before = vm.runInContext('Object.getOwnPropertyNames(globalThis).sort().join("|")', context);
  const dispatcher = vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  assert.equal(typeof dispatcher, 'function');
  const after = vm.runInContext('Object.getOwnPropertyNames(globalThis).sort().join("|")', context);
  assert.equal(after, before, 'bootstrap leaks no global names');
  return { context, raw(payload) {
    const result = JSON.parse(dispatcher(JSON.stringify(payload)));
    vm.runInContext('void 0', context);
    return result;
  }, run(source) { return vm.runInContext(source, context); } };
}
function ok(realm, payload) {
  const result = realm.raw(payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
function pair(source) {
  const main = realm('preload_main.js');
  const isolated = realm('preload_isolated.js');
  const exports = ok(isolated, {method:'configure', source});
  ok(main, {method:'install', exports});
  const results = [];
  function pump(handler = (channel, args) => { assert.equal(channel, 'sum'); return args.reduce((a,b)=>a+b,0); }) {
    for (let round = 0; round < 20; round++) {
      const mainEvents = ok(main, {method:'drain'});
      for (const event of mainEvents) {
        if (event.type === 'bridge-call') ok(isolated, {method:'call', ...event});
        else { assert.equal(event.type,'evaluation-result'); results.push(event); }
      }
      const isolatedEvents = ok(isolated, {method:'drain'});
      for (const event of isolatedEvents) {
        if (event.type === 'ipc-invoke') {
          try { ok(isolated,{method:'resolveIpc', id:event.id,ok:true,value:handler(event.channel,event.args)}); }
          catch(error) { ok(isolated,{method:'resolveIpc', id:event.id,ok:false,error:error.message}); }
        } else {
          assert.equal(event.type,'bridge-result');
          ok(main,{method:'settle',...event});
        }
      }
      if (!mainEvents.length && !isolatedEvents.length) break;
    }
    return results;
  }
  let ticket = 1;
  function evaluate(source, handler) {
    const id = 'eval/' + ticket++;
    ok(main,{method:'startEvaluation',id,source});
    pump(handler);
    const event = results.find(x=>x.id===id);
    assert.ok(event, 'evaluation completes: '+source);
    return event;
  }
  return {main, isolated, evaluate, pump, results};
}
const source = `
const {contextBridge, ipcRenderer} = require('electron');
const secret = 'isolated secret';
contextBridge.exposeInMainWorld('api', {
  add: (a,b) => ipcRenderer.invoke('sum', a,b),
  echo: value => value,
  fail: () => { throw new Error('preload failure'); },
  reject: () => Promise.reject(new Error('preload rejection')),
  nested: {label: '\\u2028\\u2029\\\\"한글🌐', answer: 42},
  list: [1, 2, 3],
  map: values => values.map(value=>value+1),
  noNode: () => [typeof process,typeof require('electron').process,typeof Deno,typeof globalThis.require,typeof document],
  attack: () => require('node:fs'),
});`;
const p = pair(source);
assert.deepEqual(p.evaluate('api.add(3, 4)').value,7);
assert.deepEqual(p.evaluate('api.map([1,2,3])').value,[2,3,4]);
assert.deepEqual(p.evaluate('api.list.map(x=>x*2)').value,[2,4,6]);
assert.equal(p.evaluate('api.nested.label').value,'\u2028\u2029\\"한글🌐');
assert.equal(p.evaluate('typeof secret').value,'undefined');
assert.deepEqual(p.evaluate('api.noNode()').value,Array(5).fill('undefined'));
assert.match(p.evaluate('api.attack()').error,/supports only/);
assert.match(p.evaluate('api.fail()').error,/preload failure/);
assert.match(p.evaluate('api.reject()').error,/preload rejection/);
assert.equal(p.evaluate('Object.isFrozen(api) && Object.isFrozen(api.nested) && Object.isFrozen(api.add)').value,true);
assert.equal(p.evaluate('Object.getOwnPropertyDescriptor(globalThis,"api").writable').value,false);
assert.equal(p.evaluate('api.echo({"__proto__": null, x:"한글🌐"})').value.x,'한글🌐');
assert.equal(p.evaluate('api.add(1,2)',()=>{throw Error('backend failure')}).error,'backend failure');
assert.match(p.evaluate('api.echo({get secret(){throw new Error("accessed")}})').error,/Accessors/);
assert.match(p.evaluate('(()=>{const x={};x.x=x;return api.echo(x)})()').error,/Cyclic/);
assert.match(p.evaluate('api.echo(new Date())').error,/plain/);
assert.match(p.evaluate('api.echo(1n)').error,/JSON values/);
assert.match(p.evaluate('api.echo(NaN)').error,/finite/);
assert.match(p.evaluate('api.echo({[Symbol("x")]:2})').error,/Symbol/);
assert.match(p.evaluate('api.echo([,1])').error,/Sparse/);
assert.match(p.evaluate('api.echo("x".repeat(1024*1024))').error,/byte limit/);
assert.match(p.evaluate('(()=>{let x={};for(let i=0;i<40;i++)x={x};return x})()').error,/complex/);
assert.equal(p.evaluate('api.echo([1,2]).then(value=>value.map(x=>x+2))').value[1],4);
// Main world attempts to intercept queues/serialization/continuations after bootstrap.
p.main.run(`
Object.prototype.toJSON = function(){ throw 'object serialization intercepted' };
Array.prototype.toJSON = function(){ throw 'array serialization intercepted' };
Object.prototype.value = 99;
Array.prototype.push = function(){throw 'push intercepted'};
JSON.stringify = function(){throw 'stringify intercepted'};
JSON.parse = function(){throw 'parse intercepted'};
Reflect.apply = function(){throw 'apply intercepted'};
Object.getOwnPropertyDescriptor = function(){throw 'descriptor intercepted'};
Object.hasOwn = function(){throw 'hasOwn intercepted'};
Promise.prototype.then = function(){throw 'then intercepted'};
Object.defineProperty(Promise.prototype,'constructor',{__proto__:null,get(){throw 'constructor intercepted'}});
globalThis.Error = function(){throw 'Error intercepted'};
`);
assert.equal(p.evaluate('api.add(4,5)').value,9);
assert.equal(p.evaluate('api.echo({hello:"world"})').value.hello,'world');
assert.match(p.evaluate('api.echo({get hidden(){return 4}})').error,/Accessors/);
// Configure rejects unsupported host access and cannot be used after failed setup.
for (const src of ["require('fs')", "require('electron').contextBridge.exposeInMainWorld('api',{get x(){return 1}})"]) {
  const iso = realm('preload_isolated.js');
  assert.equal(iso.raw({method:'configure',source:src}).ok,false);
  assert.equal(iso.raw({method:'configure',source:''}).ok,false);
  assert.equal(iso.raw({method:'call',id:1,functionId:1,args:[]}).ok,false);
}
// IDs for evaluations and bridge invocations remain distinct, and evaluation IDs retain type.
const tickets = pair(source);
ok(tickets.main,{method:'startEvaluation',id:1,source:'api.add(1,2)'});
ok(tickets.main,{method:'startEvaluation',id:'1',source:'api.add(3,4)'});
assert.equal(tickets.main.raw({method:'startEvaluation',id:1,source:'3'}).ok,false);
tickets.pump();
assert.deepEqual(tickets.results.map(x=>[x.id,x.value]),[[1,3],['1',7]]);
const limits = pair(source);
for (let i=1;i<=256;i++) ok(limits.main,{method:'startEvaluation',id:i,source:'new Promise(()=>{})'});
assert.equal(limits.main.raw({method:'startEvaluation',id:257,source:'3'}).ok,false);
// Combined queued messages stay bounded, including completion failures.
const bounded = pair(source);
for (let i = 1; i <= 3; i++) {
  ok(bounded.main, {method:'startEvaluation', id:i, source:'"x".repeat(400000)'});
}
const batch = ok(bounded.main, {method:'drain'});
assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 1024*1024);
assert.equal(batch.length,3);
assert.equal(batch.filter(event=>!event.ok).length,1);
assert.match(bounded.evaluate('Array(2000).fill("x".repeat(4096))').error,/byte limit/);
console.log('preload bootstrap VM integration and isolation regressions passed');
