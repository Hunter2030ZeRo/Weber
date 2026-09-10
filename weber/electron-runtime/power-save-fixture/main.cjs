// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { app, powerSaveBlocker: api } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const weak = 'prevent-app-suspension', strong = 'prevent-display-sleep';
const scenario = process.env.WEBER_INHIBIT_CASE;
const timer = setTimeout(() => { console.error('Power-save fixture timed out'); app.exit(1); }, 12000);
app.whenReady().then(async () => {
  if (scenario === 'missing') {
    assert.throws(() => api.start(weak), /inhibition is unavailable/);
    assert.throws(() => api.start(strong), /inhibition is unavailable/);
    assert.equal(api.isStarted(0), false);
  } else if (scenario === 'failure' || scenario === 'downgrade') {
    const a = api.start(weak);
    if (scenario === 'failure') {
      assert.throws(() => api.start(strong), /inhibition is unavailable/);
      assert.equal(api.isStarted(a), true);
      assert.equal(api.stop(a), true);
    } else {
      const b = api.start(strong);
      assert.throws(() => api.stop(b), /inhibition is unavailable/);
      assert.equal(api.isStarted(b), true); assert.equal(api.isStarted(a), true);
      api.stop(a); api.stop(b);
    }
  } else if (scenario === 'lost') {
    const lost = once(app, 'weber-error');
    const a = api.start(weak); const [error] = await lost;
    assert.equal(error.code, 'ERR_WEBER_INHIBITOR_LOST');
    assert.equal(api.isStarted(a), false); assert.equal(api.stop(a), false);
    const b = api.start(weak); assert.ok(b > a); api.stop(b);
  } else if (scenario === 'crash') {
    api.start(strong); process.kill(process.pid, 'SIGKILL');
  } else if (scenario === 'host-crash') {
    const a = api.start(strong);
    const lost = once(app, 'weber-error');
    // Only inspect this fixture's direct children, then kill its own host.
    const task = fs.readFileSync('/proc/self/stat', 'utf8').split(' ')[0];
    const children = fs.readFileSync(`/proc/self/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    const hosts = children.filter(pid => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('weber-desktop-host'));
    assert.equal(hosts.length, 1);
    const status = fs.readFileSync(`/proc/${hosts[0]}/status`, 'utf8');
    const localPid = status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1) || hosts[0];
    process.kill(Number(localPid), 'SIGKILL');
    await lost; assert.equal(api.isStarted(a), false);
    clearTimeout(timer);
    console.log(JSON.stringify({ kind: 'native-power-save-integration', backend: process.versions.bun ? 'bun' : 'node', scenario, passed: true }));
    process.exit(0);
  } else if (scenario === 'late') {
    const a = api.start(weak); assert.equal(api.stop(a), true);
  } else {
    const a = api.start(weak), b = api.start(weak), c = api.start(strong), d = api.start(strong);
    assert.equal(api.stop(a), true); assert.equal(api.stop(c), true);
    assert.equal(api.isStarted(d), true); assert.equal(api.stop(d), true);
    assert.equal(api.isStarted(b), true); assert.equal(api.stop(b), true);
    assert.equal(api.stop(b), false);
    // Quit must release this final lease without an application stop call.
    api.start(strong);
  }
  clearTimeout(timer);
  console.log(JSON.stringify({ kind: 'native-power-save-integration', backend: process.versions.bun ? 'bun' : 'node', scenario, passed: true }));
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
