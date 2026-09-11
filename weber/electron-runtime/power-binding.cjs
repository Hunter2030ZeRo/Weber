// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { EventEmitter } = require('node:events');
function createPowerBinding({ host, app }) {
  const source = new EventEmitter();
  let started = false;
  let closed = false;
  let listening = false;
  let lastShutdownGeneration = 0;
  const start = () => {
    if (started) return;
    started = true;
    host.requestSync('powerMonitor.start');
  };
  host.on('event', event => {
    if (closed) return;
    if (event.event === 'power-monitor-shutdown-status') {
      app.emit('weber-power-monitor-status', event);
      if (event.reason) process.emitWarning(event.reason, { code: 'WEBER_SHUTDOWN_INHIBITOR_UNAVAILABLE' });
      return;
    }
    if (event.event !== 'power-monitor') return;
    if (event.type !== 'shutdown') { source.emit(event.type, {}); return; }
    const generation = event.generation;
    if (!Number.isSafeInteger(generation) || generation <= lastShutdownGeneration) return;
    lastShutdownGeneration = generation;
    let prevented = false;
    let dispatching = true;
    const shutdownEvent = {
      get defaultPrevented() { return prevented; },
      preventDefault() { if (dispatching) prevented = true; },
    };
    try {
      if (listening) source.emit('shutdown', shutdownEvent);
    } finally {
      dispatching = false;
      // EventEmitter removes a once listener before calling it. The native
      // lifecycle retains its FD across that disable request and this decision.
      if (!closed) host.requestSync('powerMonitor.shutdownDecision', { generation, prevented });
    }
  });
  source.setListeningForShutdown = value => {
    if (closed || listening === Boolean(value)) return;
    host.requestSync('powerMonitor.setListeningForShutdown', { listening: Boolean(value), who: app.getName() });
    listening = Boolean(value);
  };
  host.once('closed', () => { closed = true; listening = false; });
  app.once('quit', () => {
    if (closed) return;
    closed = true; listening = false;
    host.requestSync('powerMonitor.close');
  });
  return {
    createPowerMonitor: () => {
      if (app.isReady()) start();
      else app.whenReady().then(start).catch(error => app.emit('weber-error', error));
      return source;
    },
    getSystemIdleTime: () => host.requestSync('powerMonitor.idleTime'),
    getSystemIdleState: threshold => {
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 2147483647)
        throw new TypeError('Invalid idle threshold, must be a positive integer');
      return host.requestSync('powerMonitor.idleState', { threshold });
    },
    isOnBatteryPower: () => host.requestSync('powerMonitor.battery'),
    // Linux has no equivalent of the macOS thermal-pressure state exposed by
    // this Electron API. Its documented unknown value represents that absence.
    getCurrentThermalState: () => 'unknown',
  };
}
module.exports = { createPowerBinding };
