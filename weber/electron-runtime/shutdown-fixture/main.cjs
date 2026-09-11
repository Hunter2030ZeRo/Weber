// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const readline = require('node:readline');
const send = value => console.log(JSON.stringify({ shutdownFixture: true, ...value }));
let app, powerMonitor, host;
if (process.env.WEBER_POWER_MONITOR_HOST) {
  const { HostClient } = require('../host-client.cjs');
  const { createPowerBinding } = require('../power-binding.cjs');
  const { createCommonJSLoader } = require('../commonjs-loader.cjs');
  host = new HostClient(process.env.WEBER_POWER_MONITOR_HOST);
  app = Object.assign(new EventEmitter(), {
    isReady: () => true, whenReady: () => Promise.resolve(), getName: () => 'weber-shutdown-fixture',
    quit() { this.emit('quit'); host.close(); },
  });
  const binding = createPowerBinding({ app, host });
  const saved = process._linkedBinding;
  process._linkedBinding = name => name === 'electron_browser_power_monitor' ? binding : saved(name);
  try { powerMonitor = createCommonJSLoader(() => undefined).load(path.join(__dirname, '../dist/browser/api/power-monitor.js')); }
  finally { process._linkedBinding = saved; }
} else {
  ({ app, powerMonitor } = require('electron'));
}
app.on('weber-power-monitor-status', status => send({ status }));
app.on('weber-error', error => { console.error(error); process.exit(1); });
const handlers = new Map();
app.whenReady().then(() => {
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    const command = JSON.parse(line);
    try {
      if (command.action === 'add') {
        const handler = event => {
          if (command.prevented) event.preventDefault();
          assert.equal(event.defaultPrevented, Boolean(command.prevented));
          send({ fired: command.name, prevented: event.defaultPrevented });
        };
        handlers.set(command.name, handler);
        powerMonitor[command.once ? 'once' : 'on']('shutdown', handler);
      } else if (command.action === 'remove') {
        powerMonitor.removeListener('shutdown', handlers.get(command.name));
      } else if (command.action === 'removeAll') {
        powerMonitor.removeAllListeners('shutdown');
      } else if (command.action === 'stale') {
        // Native-only probe exercises generation validation through the actual
        // host channel, not a replacement shutdown implementation.
        assert(host);
        assert.equal(host.requestSync('powerMonitor.shutdownDecision', {
          generation: command.generation, prevented: false,
        }), false);
      } else if (command.action === 'quit') {
        input.close(); app.quit();
      } else if (command.action === 'crash') {
        process.kill(process.pid, 'SIGKILL');
      } else if (command.action === 'host-crash') {
        assert(host);
        host.child.kill('SIGKILL');
      } else throw Error('Unknown action');
      send({ reply: command.id });
    } catch (error) { console.error(error); process.exit(1); }
  });
  send({ ready: true });
});
