'use strict';
const { app, powerMonitor } = require('electron');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const timer = setTimeout(() => { console.error('Power event test timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  const names = ['on-ac', 'suspend', 'resume', 'lock-screen', 'unlock-screen'];
  const received = [];
  const events = names.map(name => { powerMonitor.on(name, () => received.push(name)); return once(powerMonitor, name); });
  assert.ok(Number.isInteger(powerMonitor.getSystemIdleTime()));
  assert.equal(powerMonitor.getSystemIdleState(99999), 'active');
  assert.throws(() => powerMonitor.getSystemIdleState(0), /threshold/);
  assert.equal(powerMonitor.isOnBatteryPower(), true);
  await Promise.all(events);
  assert.deepEqual(received, names);
  assert.equal(powerMonitor.onBatteryPower, false);
  assert.equal(powerMonitor.getCurrentThermalState(), 'unknown');
  clearTimeout(timer);
  console.log(JSON.stringify({ kind: 'native-power-integration', passed: true,
    backend: process.versions.bun ? 'bun' : 'node', events: received }));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
